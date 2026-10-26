import type { PetStatus } from '../status.js'

export interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/**
 * Normalized Harness signal consumed by the pure mapper and the pet UI.
 *
 * Fields below the divider carry the DSH 0.2.1 shape; the ones above it are the
 * 0.1.0 shape kept because the same mapper still degrades safely on either
 * runtime. Every field is `unknown` so a malformed or absent source produces
 * `idle` rather than an exception.
 */
export interface SignalSnapshot {
  sessionId?: unknown
  chat?: unknown
  partial?: unknown
  running?: unknown
  runningCalls?: unknown
  pending?: unknown
  queue?: unknown
  promptError?: unknown
  lastAgentError?: unknown
  nodes?: unknown
  connection?: unknown
  derivedSuccess?: unknown
  /** DSH 0.2.1 SessionSnapshot.running. */
  sessionRunning?: unknown
  /** DSH 0.2.1 SessionSnapshot.promptError. */
  sessionPromptError?: unknown
  /** DSH 0.2.1 SessionStatus.pendingInteraction (approval or question). */
  pendingInteraction?: unknown
  /** Names of tool calls opened on the 0.2.1 event window and not yet answered. */
  toolNames?: unknown
  /** Latest local user prompt text read from the 0.2.1 event window. */
  userText?: unknown
  /** Latest assistant text (finalized, or the streamed prefix) from the event window. */
  assistantText?: unknown
  /** DSH 0.2.1 event window ended its last turn with a failure. */
  turnFailed?: unknown
  [key: string]: unknown
}

/** Structural subset of the DSH sessions list state. */
export interface HarnessListState {
  ids?: readonly string[]
  current?: string
  byId?: Record<string, { retainedBy?: Readonly<Record<string, number>> } | undefined>
}

interface HarnessSessions {
  list: SnapshotSource<HarnessListState>
  binding(id: string): HarnessSessionBinding | undefined
}

export interface FollowupSendResult {
  ok: boolean
  message?: string
}

/** Structural subset of a DSH SessionBinding. */
export interface HarnessSessionBinding {
  session: HarnessSessionFace
  eventSource?: SnapshotSource<unknown>
}

export interface HarnessSessionFace extends SnapshotSource<SignalSnapshot> {
  prompt?(
    content: Array<{ type: 'text'; text: string }>,
    mode: 'queue' | 'steer',
  ): Promise<unknown>
}

/** DSH 0.2.1 SessionStatus row (running + pending interaction per session). */
export interface HarnessSessionStatus {
  running?: boolean | undefined
  pendingInteraction?: unknown
  completionUnread?: boolean
}

export interface HarnessContext {
  sessions: HarnessSessions
  connection: {
    /**
     * DSH 0.2.1: ObservableSnapshot<'connected' | 'reconnecting' | undefined>.
     *
     * Upstream read `connection.hostDescription`, which 0.2.1 removed. The
     * reference is deliberately gone rather than kept as a fallback: calling a
     * removed member is what aborted activation, and this fork does not support
     * the generation that had it.
     */
    state?: SnapshotSource<unknown>
  }
  /** DSH 0.2.1 ui-session service; optional so an older runtime still loads. */
  uiSession?: {
    sessionStatus?: SnapshotSource<ReadonlyMap<string, HarnessSessionStatus>>
  }
}

const TOOL_NAMES: Readonly<Record<'searching' | 'bash' | 'editing', ReadonlySet<string>>> = {
  searching: new Set([
    'web_search',
    'tool_web',
    'web',
    'web-fetch',
    'web-fetch-and-search',
    'tool_web_search',
    'fetch',
  ]),
  bash: new Set(['bash', 'tool_bash', 'pwsh', 'tool_pwsh', 'powershell', 'shell', 'run_command']),
  editing: new Set([
    'str-replace-editor',
    'str_replace_editor',
    'tool_str_replace_editor',
    'apply_patch',
    'write_file',
    'write-file',
    'file_write',
    'edit',
    'multi_edit',
    'create_file',
  ]),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function legacySlice(snapshot: SignalSnapshot): Record<string, unknown> | undefined {
  if (!isRecord(snapshot.chat) || !isRecord(snapshot.chat.legacy)) return undefined
  return snapshot.chat.legacy
}

function snapshotArray(snapshot: SignalSnapshot, key: 'nodes' | 'runningCalls'): readonly unknown[] {
  return Array.isArray(snapshot[key]) ? snapshot[key] : array(legacySlice(snapshot)?.[key])
}

function snapshotPartial(snapshot: SignalSnapshot): Record<string, unknown> | undefined {
  if ('partial' in snapshot) return isRecord(snapshot.partial) ? snapshot.partial : undefined
  const legacy = legacySlice(snapshot)?.partial
  return isRecord(legacy) ? legacy : undefined
}

/** Join the visible `text` blocks of a message or partial content array. */
function contentText(value: unknown): string | undefined {
  const text = array(value)
    .flatMap((block) => {
      if (!isRecord(block)) return []
      if (block.type !== 'text' && block.kind !== 'text') return []
      return typeof block.text === 'string' ? [block.text.trim()] : []
    })
    .filter(Boolean)
    .join(' ')
  return text || undefined
}

function runningToolNames(snapshot: SignalSnapshot): Set<string> {
  const names = new Set<string>()
  for (const call of snapshotArray(snapshot, 'runningCalls')) {
    if (!isRecord(call) || typeof call.name !== 'string') continue
    names.add(call.name.trim().toLowerCase())
  }
  for (const name of array(snapshot.toolNames)) {
    if (typeof name === 'string' && name.trim()) names.add(name.trim().toLowerCase())
  }
  return names
}

function isRunning(snapshot: SignalSnapshot): boolean {
  // An explicit 0.2.1 bit is authoritative; the 0.1.0 bits are the fallback so a
  // snapshot carrying both cannot disagree.
  if (typeof snapshot.sessionRunning === 'boolean') return snapshot.sessionRunning
  return snapshot.running === true
}

function hasError(snapshot: SignalSnapshot): boolean {
  const lastNode = snapshotArray(snapshot, 'nodes').at(-1)
  return (
    isRecord(snapshot.promptError) ||
    isRecord(snapshot.sessionPromptError) ||
    snapshot.turnFailed === true ||
    (typeof snapshot.lastAgentError === 'string' && snapshot.lastAgentError.trim().length > 0) ||
    snapshot.connection === 'reconnecting' ||
    (isRecord(lastNode) && lastNode.kind === 'turn-error')
  )
}

/**
 * Pure Harness signal mapper. Unknown and malformed fields degrade safely.
 *
 * Semantics of the two "busy" states are deliberate and differ slightly from
 * upstream, which keyed `thinking` off a `partial` field that no longer exists
 * on 0.2.1 (so it could never fire there):
 *
 * - a run with an open tool call is `working` (or a specialized tool state);
 * - a run with no open tool call is `thinking` — the model is generating;
 * - `idle` when neither holds.
 */
export function detectPetStatus(snapshot: SignalSnapshot): PetStatus {
  if (hasError(snapshot)) return 'error'
  if (snapshot.derivedSuccess === true) return 'success'

  if (
    array(snapshot.pending).length > 0 ||
    (snapshot.pendingInteraction !== undefined && snapshot.pendingInteraction !== null) ||
    array(snapshot.queue).some((item) => isRecord(item) && item.placement === 'queued')
  ) {
    return 'waiting'
  }

  const names = runningToolNames(snapshot)
  const legacyCalls = snapshotArray(snapshot, 'runningCalls').length > 0
  for (const status of ['searching', 'bash', 'editing'] as const) {
    if ([...names].some((name) => TOOL_NAMES[status].has(name))) return status
  }

  // Tool execution outranks pure generation.
  if (names.size > 0 || legacyCalls) return 'working'
  if (isRunning(snapshot)) return 'thinking'
  // 0.1.0 compatibility: a streamed partial with no running bit still means "busy".
  if (snapshotPartial(snapshot) !== undefined) return 'thinking'
  return 'idle'
}

/** Exact native running bit used by the generic success state machine. */
export function isHarnessRunning(snapshot: SignalSnapshot): boolean {
  return isRunning(snapshot)
}

export function harnessSignalIdentity(snapshot: SignalSnapshot): string | undefined {
  return typeof snapshot.sessionId === 'string' ? snapshot.sessionId : undefined
}

/** Latest local user message for the pet card. Never persisted or transmitted. */
export function harnessConversationTitle(snapshot: SignalSnapshot): string | undefined {
  for (const node of [...snapshotArray(snapshot, 'nodes')].reverse()) {
    if (!isRecord(node) || (node.kind !== 'user' && node.kind !== 'steering')) continue
    const text = contentText(node.content)
    if (text !== undefined) return text
  }

  for (const item of [...array(snapshot.queue)].reverse()) {
    if (!isRecord(item)) continue
    if (typeof item.text === 'string' && item.text.trim()) return item.text.trim()
    if (typeof item.preview === 'string' && item.preview.trim()) return item.preview.trim()
  }

  const userText = typeof snapshot.userText === 'string' ? snapshot.userText.trim() : ''
  return userText || undefined
}

/** Live partial answer, or the finalized answer that belongs to the latest user message. */
export function harnessAssistantText(snapshot: SignalSnapshot): string | undefined {
  const livePartial = snapshotPartial(snapshot)
  if (livePartial !== undefined) {
    const partial = contentText(livePartial.blocks)
    if (partial !== undefined) return partial
  }

  for (const node of [...snapshotArray(snapshot, 'nodes')].reverse()) {
    if (!isRecord(node)) continue
    if (node.kind === 'user' || node.kind === 'steering') return undefined
    if (node.kind === 'assistant') return contentText(node.blocks)
  }

  const assistantText = typeof snapshot.assistantText === 'string' ? snapshot.assistantText.trim() : ''
  return assistantText || undefined
}

/**
 * Reduce a DSH 0.2.1 `SessionEventWindow` to the facts the pet needs.
 *
 * The window is the conversation itself on 0.2.1 (`SessionSnapshot` carries only
 * turn status). Entries are `{ type: 'event', event }` for durable events and
 * `{ type: 'transient', event }` for live stream chunks. Reconstruction stays
 * deliberately shallow: the pet shows the newest prompt, the newest reply, and
 * which tools are open — it never re-derives the full transcript.
 */
export function reduceSessionEvents(window: unknown): {
  userText?: string
  assistantText?: string
  toolNames: string[]
  turnFailed: boolean
} {
  if (!isRecord(window)) return { toolNames: [], turnFailed: false }
  const entries = array(window.entries)

  let userText: string | undefined
  let assistantText: string | undefined
  let turnFailed = false
  const openCalls = new Map<string, string>()
  let streamed = ''

  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.event)) continue
    const event = entry.event
    const type = typeof event.type === 'string' ? event.type : ''
    const data = isRecord(event.data) ? event.data : undefined

    if (entry.type === 'transient') {
      // assistant/live-chunk: accumulate the streamed text prefix of this turn.
      const chunk = data !== undefined && isRecord(data.chunk) ? data.chunk : undefined
      if (type === 'assistant/live-chunk' && chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        streamed += chunk.text
      }
      continue
    }

    if (type === 'user/message') {
      // A new human prompt resets the reply state for the card.
      const source = data !== undefined && isRecord(data.source) ? data.source : undefined
      const text = data !== undefined ? contentText(data.content) : undefined
      if (text !== undefined && (source === undefined || source.kind === 'user')) {
        userText = text
        assistantText = undefined
        streamed = ''
      }
      continue
    }

    if (type === 'assistant/message') {
      const message = data !== undefined && isRecord(data.message) ? data.message : undefined
      const text = message !== undefined ? contentText(message.content) : undefined
      if (text !== undefined) assistantText = text
      streamed = ''
      continue
    }

    if (type === 'tool/call') {
      if (typeof data?.callId === 'string' && typeof data.name === 'string') {
        openCalls.set(data.callId, data.name)
      }
      continue
    }

    if (type === 'tool/result') {
      const callId = data !== undefined && typeof data.callId === 'string' ? data.callId : undefined
      if (callId !== undefined) openCalls.delete(callId)
      continue
    }

    if (type === 'turn/end') {
      const reason = data !== undefined && isRecord(data.reason) ? data.reason : undefined
      turnFailed = reason?.kind === 'failed' || reason?.kind === 'blocked'
      openCalls.clear()
      continue
    }

    if (type === 'turn/start') {
      turnFailed = false
    }
  }

  // A streamed prefix is shown only while no finalized answer superseded it.
  const live = streamed.trim() || undefined
  const reply = assistantText ?? live
  return {
    ...(userText === undefined ? {} : { userText }),
    ...(reply === undefined ? {} : { assistantText: reply }),
    toolNames: [...openCalls.values()],
    turnFailed,
  }
}

/** The session the UI currently retains for its main view (DSH 0.2.1 selection rule). */
export function currentSessionId(state: HarnessListState | undefined): string | undefined {
  if (state === undefined) return undefined
  // 0.1.0 carried an explicit selection field.
  if (typeof state.current === 'string') return state.current
  // 0.2.1: the main view is the row retained by the workspace, exactly as
  // ui-session's publishMain and ui-workspace's mainSessionId resolve it.
  if (state.byId === undefined) return undefined
  for (const [id, row] of Object.entries(state.byId)) {
    if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) return id
  }
  return undefined
}

function promptFailureMessage(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.error)) return 'Harness 未确认发送结果'
  return typeof result.error.message === 'string' && result.error.message.trim()
    ? result.error.message.trim()
    : 'Harness 拒绝了这条消息'
}

/** Send through the current official SessionFace; no direct fetch or third-party endpoint. */
export async function sendHarnessFollowup(
  context: HarnessContext,
  value: string,
): Promise<FollowupSendResult> {
  const text = value.trim()
  if (!text) return { ok: false, message: '请输入继续跟进的内容' }
  const id = currentSessionId(context.sessions.list.getSnapshot())
  const session = id === undefined ? undefined : context.sessions.binding(id)?.session
  if (session?.prompt === undefined) return { ok: false, message: '当前没有可发送的 Harness 会话' }

  try {
    const result = await session.prompt([{ type: 'text', text }], 'queue')
    return isRecord(result) && result.ok === true
      ? { ok: true }
      : { ok: false, message: promptFailureMessage(result) }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error && error.message ? error.message : '发送到 Harness 失败',
    }
  }
}

/** Read the connection state. */
function connectionState(
  connection: HarnessContext['connection'],
): 'connected' | 'reconnecting' | undefined {
  const raw = connection.state?.getSnapshot()
  if (raw === 'connected' || raw === 'reconnecting') return raw
  return undefined
}

/**
 * Subscribe to the current SessionFace, its event window, the session status
 * feed, and the public connection source.
 *
 * A connection source that goes absent after the first successful connection is
 * the public structured reconnect signal. `binding(id)` yields a read-only face
 * for the session the workspace already retains, so the pet never allocates a
 * scope of its own.
 */
export function observeHarnessSignals(
  context: HarnessContext,
  listener: (snapshot: SignalSnapshot) => void,
): () => void {
  let disposed = false
  let boundSessionId: string | undefined
  let currentBinding: HarnessSessionBinding | undefined
  let unsubscribeSession: (() => void) | undefined
  let unsubscribeEvents: (() => void) | undefined
  let everConnected = connectionState(context.connection) === 'connected'

  function emit(): void {
    if (disposed) return
    const sessionSnapshot = currentBinding?.session.getSnapshot()
    const window = currentBinding?.eventSource?.getSnapshot()
    const status = boundSessionId === undefined
      ? undefined
      : context.uiSession?.sessionStatus?.getSnapshot().get(boundSessionId)
    const reduced = reduceSessionEvents(window)
    const connection = connectionState(context.connection)
    if (connection === 'connected') everConnected = true

    // The native SessionSnapshot bit is authoritative when present; the
    // uiSession status feed is the fallback and the only source of a pending
    // interaction (an approval or question blocking the turn).
    const nativeRunning = isRecord(sessionSnapshot) ? sessionSnapshot.running : undefined
    const sessionRunning = typeof nativeRunning === 'boolean'
      ? nativeRunning
      : status?.running === true

    listener({
      ...(isRecord(sessionSnapshot) ? sessionSnapshot : {}),
      sessionId: boundSessionId,
      connection: connection === 'connected' ? 'connected' : everConnected ? 'reconnecting' : undefined,
      sessionRunning,
      ...(status?.pendingInteraction === undefined ? {} : { pendingInteraction: status.pendingInteraction }),
      ...(reduced.userText === undefined ? {} : { userText: reduced.userText }),
      ...(reduced.assistantText === undefined ? {} : { assistantText: reduced.assistantText }),
      toolNames: reduced.toolNames,
      turnFailed: reduced.turnFailed,
    })
  }

  const bindCurrent = (): void => {
    const id = currentSessionId(context.sessions.list.getSnapshot())
    const next = id === undefined ? undefined : context.sessions.binding(id)
    boundSessionId = id
    if (Object.is(next, currentBinding)) {
      emit()
      return
    }
    unsubscribeSession?.()
    unsubscribeEvents?.()
    currentBinding = next
    unsubscribeSession = next?.session.subscribe(emit)
    unsubscribeEvents = next?.eventSource?.subscribe(emit)
    emit()
  }

  const unsubscribeList = context.sessions.list.subscribe(bindCurrent)
  const statusSource = context.uiSession?.sessionStatus
  const unsubscribeStatus = statusSource?.subscribe(emit)
  const unsubscribeConnection = context.connection.state?.subscribe(emit)
  bindCurrent()

  return () => {
    if (disposed) return
    disposed = true
    unsubscribeSession?.()
    unsubscribeEvents?.()
    unsubscribeList()
    unsubscribeStatus?.()
    unsubscribeConnection?.()
    currentBinding = undefined
  }
}
