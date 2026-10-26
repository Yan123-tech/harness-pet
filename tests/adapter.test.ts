import { describe, expect, it, vi } from 'vitest'
import {
  currentSessionId,
  detectPetStatus,
  harnessAssistantText,
  harnessConversationTitle,
  observeHarnessSignals,
  reduceSessionEvents,
  sendHarnessFollowup,
  type HarnessContext,
  type SignalSnapshot,
  type SnapshotSource,
} from '../src/adapters/deepseek-harness.js'

class Source<T> implements SnapshotSource<T> {
  readonly listeners = new Set<() => void>()

  constructor(private value: T) {}

  getSnapshot(): T {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(value: T): void {
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }
}

describe('detectPetStatus', () => {
  const states: Array<[string, SignalSnapshot]> = [
    ['idle', {}],
    ['thinking', { partial: { blocks: [] } }],
    ['working', { runningCalls: [{ name: 'future_tool' }] }],
    ['searching', { runningCalls: [{ name: 'web_search' }] }],
    ['bash', { runningCalls: [{ name: 'pwsh' }] }],
    ['editing', { runningCalls: [{ name: 'str-replace-editor' }] }],
    ['waiting', { pending: [{}] }],
    ['error', { promptError: {} }],
    ['success', { derivedSuccess: true }],
  ]

  it.each(states)('detects %s', (status, snapshot) => {
    expect(detectPetStatus(snapshot)).toBe(status)
  })

  it('applies error > success > waiting > specialized tool > working > thinking', () => {
    const all: SignalSnapshot = {
      promptError: {},
      derivedSuccess: true,
      pending: [{}],
      runningCalls: [{ name: 'web_search' }],
      running: true,
      partial: { blocks: [] },
    }
    expect(detectPetStatus(all)).toBe('error')
    expect(detectPetStatus({ ...all, promptError: null })).toBe('success')
    expect(detectPetStatus({ ...all, promptError: null, derivedSuccess: false })).toBe('waiting')
    expect(detectPetStatus({ ...all, promptError: null, derivedSuccess: false, pending: [] })).toBe('searching')
  })

  it('separates generation from tool execution', () => {
    // A running turn with an open tool call is executing a tool...
    expect(detectPetStatus({ running: true, toolNames: ['future_tool'] })).toBe('working')
    // ...while a running turn with no open call is the model generating text.
    expect(detectPetStatus({ running: true })).toBe('thinking')
    expect(detectPetStatus({ running: true, partial: { blocks: [] } })).toBe('thinking')
  })

  it('uses the latest finalized node for turn errors', () => {
    expect(detectPetStatus({ nodes: [{ kind: 'turn-error' }] })).toBe('error')
    expect(detectPetStatus({ nodes: [{ kind: 'turn-error' }, { kind: 'assistant' }] })).toBe('idle')
  })

  it.each([
    { lastAgentError: 'agent failed' },
    { connection: 'reconnecting' },
  ] satisfies SignalSnapshot[])('detects every live error channel', (snapshot) => {
    expect(detectPetStatus(snapshot)).toBe('error')
  })

  it('detects only queued queue placements as waiting', () => {
    expect(detectPetStatus({ queue: [{ placement: 'queued' }] })).toBe('waiting')
    expect(detectPetStatus({ queue: [{ placement: 'steering' }] })).toBe('idle')
  })

  it('degrades unknown tools to working and unknown signals to idle', () => {
    expect(detectPetStatus({ toolNames: ['future_tool'] })).toBe('working')
    expect(detectPetStatus({ runningCalls: [{ name: 'future_tool' }] })).toBe('working')
    expect(detectPetStatus({ partial: 'malformed' })).toBe('idle')
    expect(detectPetStatus({ futureSignal: true } as SignalSnapshot)).toBe('idle')
  })
})

// DSH 0.2.1 moved conversation content out of SessionSnapshot into the session
// event window, and moved running/pending-interaction into the uiSession status
// feed. These cases pin the 0.2.1 signal shape.
describe('detectPetStatus on DSH 0.2.1 signals', () => {
  it('reads the native SessionSnapshot running bit', () => {
    // Running with no open tool call is generation; with one it is execution.
    expect(detectPetStatus({ sessionRunning: true })).toBe('thinking')
    expect(detectPetStatus({ sessionRunning: true, toolNames: ['bash'] })).toBe('bash')
    expect(detectPetStatus({ sessionRunning: false })).toBe('idle')
  })

  it('reads a failed send from SessionSnapshot.promptError', () => {
    expect(detectPetStatus({ sessionPromptError: { op: 'send', error: { code: 'x' } } })).toBe('error')
  })

  it('reads a failed turn from the event window', () => {
    expect(detectPetStatus({ turnFailed: true })).toBe('error')
  })

  it('treats a pending approval or question as waiting', () => {
    expect(detectPetStatus({ pendingInteraction: { key: 'approval', kind: 'approval', sessionId: 'a' } })).toBe('waiting')
    expect(detectPetStatus({ pendingInteraction: undefined })).toBe('idle')
  })

  it('maps specialized tool names taken from the event window', () => {
    expect(detectPetStatus({ toolNames: ['web_search'] })).toBe('searching')
    expect(detectPetStatus({ toolNames: ['bash'] })).toBe('bash')
    expect(detectPetStatus({ toolNames: ['apply_patch'] })).toBe('editing')
    expect(detectPetStatus({ toolNames: ['unknown_tool'] })).toBe('working')
  })

  it('prefers error over a pending interaction and running', () => {
    expect(detectPetStatus({
      turnFailed: true,
      pendingInteraction: { kind: 'approval' },
      sessionRunning: true,
      toolNames: ['bash'],
    })).toBe('error')
  })
})

describe('reduceSessionEvents', () => {
  const event = (type: string, data: unknown) => ({ type: 'event', event: { type, seq: 1, time: 0, data } })

  it('collects the newest human prompt and finalized reply', () => {
    const reduced = reduceSessionEvents({
      entries: [
        event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] }),
        event('assistant/message', { message: { content: [{ type: 'text', text: '第一条回答' }] } }),
        event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '第二条' }] }),
      ],
    })
    expect(reduced.userText).toBe('第二条')
    // The newer prompt clears the stale reply so the card cannot show a mismatch.
    expect(reduced.assistantText).toBeUndefined()
  })

  it('tracks tool calls that opened and not yet returned', () => {
    const reduced = reduceSessionEvents({
      entries: [
        event('tool/call', { callId: 'c1', name: 'bash' }),
        event('tool/call', { callId: 'c2', name: 'web_search' }),
        event('tool/result', { callId: 'c1' }),
      ],
    })
    expect(reduced.toolNames).toEqual(['web_search'])
  })

  it('accumulates transient live-chunk text as the streaming reply', () => {
    const reduced = reduceSessionEvents({
      entries: [
        event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '讲个故事' }] }),
        { type: 'transient', event: { type: 'assistant/live-chunk', data: { chunk: { type: 'text-delta', text: '从前' } } } },
        { type: 'transient', event: { type: 'assistant/live-chunk', data: { chunk: { type: 'text-delta', text: '有座山' } } } },
      ],
    })
    expect(reduced.assistantText).toBe('从前有座山')
  })

  it('ignores synthetic context injections that are not human prompts', () => {
    const reduced = reduceSessionEvents({
      entries: [event('user/message', { source: { kind: 'context' }, content: [{ type: 'text', text: 'AGENTS.md 内容' }] })],
    })
    expect(reduced.userText).toBeUndefined()
  })

  it('flags a failed turn and clears open tool calls', () => {
    const reduced = reduceSessionEvents({
      entries: [
        event('tool/call', { callId: 'c1', name: 'bash' }),
        event('turn/end', { turn: 1, reason: { kind: 'failed', error: { message: 'boom' } } }),
      ],
    })
    expect(reduced.turnFailed).toBe(true)
    expect(reduced.toolNames).toEqual([])
  })

  it('degrades malformed windows to an empty reduction', () => {
    expect(reduceSessionEvents(undefined)).toEqual({ toolNames: [], turnFailed: false })
    expect(reduceSessionEvents('nonsense')).toEqual({ toolNames: [], turnFailed: false })
    expect(reduceSessionEvents({ entries: [null, 1, { type: 'event' }] })).toEqual({ toolNames: [], turnFailed: false })
  })
})

describe('currentSessionId', () => {
  it('reads the 0.2.1 main-view retention flag', () => {
    expect(currentSessionId({
      ids: ['a', 'b'],
      byId: { a: { retainedBy: {} }, b: { retainedBy: { mainView: 1 } } },
    })).toBe('b')
  })

  it('still accepts the 0.1.0 explicit current field', () => {
    expect(currentSessionId({ current: 'legacy' })).toBe('legacy')
  })

  it('returns undefined without a retained main view', () => {
    expect(currentSessionId({ ids: ['a'], byId: { a: { retainedBy: {} } } })).toBeUndefined()
    expect(currentSessionId(undefined)).toBeUndefined()
    expect(currentSessionId({})).toBeUndefined()
  })
})

describe('harnessConversationTitle', () => {
  it('uses the latest finalized local user or steering text', () => {
    expect(harnessConversationTitle({
      nodes: [
        { kind: 'user', content: [{ type: 'text', text: '第一条问题' }] },
        { kind: 'assistant', content: [{ type: 'text', text: '回答' }] },
        { kind: 'steering', content: [{ type: 'text', text: '  最新要求  ' }] },
      ],
    })).toBe('最新要求')
  })

  it('falls back to the latest local queue preview', () => {
    expect(harnessConversationTitle({ queue: [{ text: '等待中问题' }] })).toBe('等待中问题')
    expect(harnessConversationTitle({ queue: [{ preview: '预览文字' }] })).toBe('预览文字')
  })

  it('falls back to the 0.2.1 event-window prompt', () => {
    expect(harnessConversationTitle({ userText: '来自事件窗口' })).toBe('来自事件窗口')
    expect(harnessConversationTitle({ userText: '   ' })).toBeUndefined()
  })

  it('ignores assistant text and malformed unknown content', () => {
    expect(harnessConversationTitle({ nodes: [{ kind: 'assistant', content: [{ type: 'text', text: '不显示' }] }] })).toBeUndefined()
    expect(harnessConversationTitle({ nodes: [{ kind: 'user', content: [{ type: 'image', text: '不显示' }, null] }] })).toBeUndefined()
  })
})

describe('harnessAssistantText', () => {
  it('prefers live partial text over the finalized answer', () => {
    expect(harnessAssistantText({
      partial: { blocks: [{ kind: 'text', text: '正在实时输出' }] },
      nodes: [{ kind: 'assistant', blocks: [{ kind: 'text', text: '上一条回答' }] }],
    })).toBe('正在实时输出')
  })

  it('reads the official chat legacy mirror when top-level compatibility fields are absent', () => {
    const snapshot: SignalSnapshot = {
      chat: {
        legacy: {
          partial: { blocks: [{ kind: 'text', text: '镜像中的流式文字' }] },
          nodes: [{ kind: 'user', content: [{ type: 'text', text: '写一篇长文' }] }],
        },
      },
    }
    expect(detectPetStatus(snapshot)).toBe('thinking')
    expect(harnessConversationTitle(snapshot)).toBe('写一篇长文')
    expect(harnessAssistantText(snapshot)).toBe('镜像中的流式文字')
  })

  it('uses the latest finalized assistant text', () => {
    expect(harnessAssistantText({
      nodes: [
        { kind: 'user', content: [{ type: 'text', text: '你好' }] },
        { kind: 'assistant', blocks: [{ kind: 'reasoning', text: '不显示' }, { kind: 'text', text: '你好！在的。' }] },
      ],
    })).toBe('你好！在的。')
  })

  it('falls back to the 0.2.1 event-window reply', () => {
    expect(harnessAssistantText({ assistantText: '来自事件窗口的回答' })).toBe('来自事件窗口的回答')
  })

  it('clears an older answer once a newer user message is waiting for output', () => {
    expect(harnessAssistantText({
      nodes: [
        { kind: 'assistant', blocks: [{ kind: 'text', text: '旧回答' }] },
        { kind: 'user', content: [{ type: 'text', text: '新问题' }] },
      ],
    })).toBeUndefined()
  })
})

describe('sendHarnessFollowup', () => {
  const contextWith = (session: unknown, byId: Record<string, unknown>): HarnessContext => ({
    sessions: {
      list: new Source({ byId: byId as never }),
      binding: () => (session === undefined ? undefined : { session: session as never }),
    },
    connection: { state: new Source<'connected' | 'reconnecting' | undefined>('connected') },
  })

  it('sends trimmed text through the current official session queue', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const session = Object.assign(new Source<SignalSnapshot>({}), { prompt })
    const context = contextWith(session, { s1: { retainedBy: { mainView: 1 } } })

    await expect(sendHarnessFollowup(context, '  继续检查  ')).resolves.toEqual({ ok: true })
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: '继续检查' }], 'queue')
  })

  it('reports missing sessions and official prompt failures', async () => {
    await expect(sendHarnessFollowup(contextWith(undefined, {}), '继续')).resolves.toMatchObject({ ok: false })

    const session = Object.assign(new Source<SignalSnapshot>({}), {
      prompt: vi.fn().mockResolvedValue({ ok: false, error: { message: '发送被拒绝' } }),
    })
    const rejected = contextWith(session, { s1: { retainedBy: { mainView: 1 } } })
    await expect(sendHarnessFollowup(rejected, '继续')).resolves.toEqual({ ok: false, message: '发送被拒绝' })
  })
})

describe('observeHarnessSignals', () => {
  it('switches current-session subscriptions and cleans up every listener', () => {
    const sessionA = new Source<SignalSnapshot>({ sessionRunning: true })
    const eventsA = new Source<unknown>({ entries: [] })
    const sessionB = new Source<SignalSnapshot>({ sessionRunning: false })
    const status = new Source(new Map([['a', { running: true }]]))
    const list = new Source({ byId: { a: { retainedBy: { mainView: 1 } } } as Record<string, { retainedBy: Record<string, number> }> })
    const connection = new Source<'connected' | 'reconnecting' | undefined>('connected')
    const context: HarnessContext = {
      sessions: {
        list,
        binding: (id) => ({
          session: (id === 'a' ? sessionA : sessionB) as never,
          eventSource: eventsA as never,
        }),
      },
      connection: { state: connection },
      uiSession: { sessionStatus: status as never },
    }
    const seen: SignalSnapshot[] = []

    const dispose = observeHarnessSignals(context, (snapshot) => seen.push(snapshot))
    expect(list.listeners.size).toBe(1)
    expect(sessionA.listeners.size).toBe(1)
    expect(eventsA.listeners.size).toBe(1)
    expect(status.listeners.size).toBe(1)
    expect(connection.listeners.size).toBe(1)
    expect(seen.at(-1)?.sessionRunning).toBe(true)
    expect(seen.at(-1)?.connection).toBe('connected')

    list.publish({ byId: { b: { retainedBy: { mainView: 1 } } } })
    expect(sessionA.listeners.size).toBe(0)
    expect(sessionB.listeners.size).toBe(1)
    expect(seen.at(-1)?.sessionId).toBe('b')

    connection.publish('reconnecting')
    expect(seen.at(-1)?.connection).toBe('reconnecting')

    dispose()
    expect(list.listeners.size).toBe(0)
    expect(sessionA.listeners.size).toBe(0)
    expect(sessionB.listeners.size).toBe(0)
    expect(eventsA.listeners.size).toBe(0)
    expect(status.listeners.size).toBe(0)
    expect(connection.listeners.size).toBe(0)
  })

  it('surfaces reconnect only after a connection has existed', () => {
    const list = new Source({ byId: {} })
    const connection = new Source<'connected' | 'reconnecting' | undefined>(undefined)
    const context: HarnessContext = {
      sessions: { list, binding: () => undefined },
      connection: { state: connection },
    }
    const seen: SignalSnapshot[] = []
    const dispose = observeHarnessSignals(context, (snapshot) => seen.push(snapshot))

    expect(seen.at(-1)?.connection).toBeUndefined()
    connection.publish('connected')
    expect(seen.at(-1)?.connection).toBe('connected')
    connection.publish('reconnecting')
    expect(seen.at(-1)?.connection).toBe('reconnecting')
    dispose()
  })

  it('reports nothing when the connection source is absent', () => {
    const list = new Source({ byId: {} })
    const context: HarnessContext = {
      sessions: { list, binding: () => undefined },
      connection: {},
    }
    const seen: SignalSnapshot[] = []
    const dispose = observeHarnessSignals(context, (snapshot) => seen.push(snapshot))

    expect(seen.at(-1)?.connection).toBeUndefined()
    expect(() => dispose()).not.toThrow()
  })

  it('treats a legacy current field as the selected session', () => {
    // The 0.1.0 `current` field is still honored for the sessions the pet can
    // read, even though 0.2.1 uses the main-view retention flag.
    const list = new Source({ current: 'legacy' })
    const connection = new Source<'connected' | 'reconnecting' | undefined>('connected')
    const context: HarnessContext = {
      sessions: { list, binding: () => ({ session: new Source<SignalSnapshot>({}) as never }) },
      connection: { state: connection },
    }
    const seen: SignalSnapshot[] = []
    const dispose = observeHarnessSignals(context, (snapshot) => seen.push(snapshot))

    expect(seen.at(-1)?.sessionId).toBe('legacy')
    expect(seen.at(-1)?.connection).toBe('connected')
    dispose()
  })
})
