import {
  detectPetStatus,
  harnessAssistantText,
  harnessConversationTitle,
  harnessSignalIdentity,
  isHarnessRunning,
  observeHarnessSignals,
  sendHarnessFollowup,
  type HarnessContext,
} from '../adapters/deepseek-harness.js'
import { createWhalePet, type WhalePet, type WhalePetOptions } from '../pet/index.js'
import { PetStateMachine } from '../state-machine.js'
import { acquireWhaleSingleton, type DisposableWhale } from '../storage/singleton.js'

/**
 * Service names resolved onto `ctx` before `apply` runs.
 *
 * These are Cordis service keys, not package ids: `dsh.client.inject` in
 * package.json carries the package ids that must be loaded first. `uiSession`
 * is the DSH 0.2.1 optional service that publishes per-session running and
 * pending-interaction status; the adapter treats its absence as "unknown".
 */
export const inject = ['sessions', 'connection']

/** Minimal structural view of the client root context the pet needs. */
export interface PetClientContext extends HarnessContext {
  effect?(callback: () => (() => void) | void, label?: string): void
  get?(name: string): unknown
}

/**
 * Resolve the optional `uiSession` status feed.
 *
 * The runner hands `apply` a guarded context proxy that throws when a service
 * is read without being declared in `inject`, so `uiSession` is reached through
 * `ctx.get(name)` — the guard's own undeclared-lookup seat. It is deliberately
 * *not* declared in `inject`: the pet only uses the feed to sharpen `waiting`
 * detection, and a hard injection would park the plugin whenever the provider
 * is absent.
 */
function resolveUiSession(ctx: PetClientContext): HarnessContext['uiSession'] {
  const resolved = typeof ctx.get === 'function' ? ctx.get('uiSession') : undefined
  return resolved !== null && typeof resolved === 'object'
    ? resolved as HarnessContext['uiSession']
    : undefined
}

export function startHarnessPet(
  context: HarnessContext,
  createPet: (options: WhalePetOptions) => WhalePet = createWhalePet,
): DisposableWhale {
  const pet = createPet({ onFollowup: (text) => sendHarnessFollowup(context, text) })
  const machine = new PetStateMachine()
  let successTimer: ReturnType<typeof setTimeout> | undefined
  let conversationTitle: string | undefined
  let assistantText: string | undefined
  let conversationIdentity: string | undefined

  const unsubscribe = observeHarnessSignals(context, (snapshot) => {
    const identity = harnessSignalIdentity(snapshot)
    if (identity !== conversationIdentity) {
      conversationIdentity = identity
      conversationTitle = undefined
      assistantText = undefined
    }
    conversationTitle = harnessConversationTitle(snapshot) ?? conversationTitle
    assistantText = harnessAssistantText(snapshot)
    const status = machine.update({
      status: detectPetStatus(snapshot),
      running: isHarnessRunning(snapshot),
      identity,
    })
    pet.setStatus(status, conversationTitle, assistantText, identity)
    if (successTimer !== undefined) clearTimeout(successTimer)
    successTimer = status === 'success'
      ? setTimeout(() => pet.setStatus(machine.tick(), conversationTitle, assistantText, conversationIdentity), 3_010)
      : undefined
  })

  return {
    dispose: () => {
      if (successTimer !== undefined) clearTimeout(successTimer)
      unsubscribe()
      pet.dispose()
    },
  }
}

/**
 * Build the adapter context from the host's client context.
 *
 * Exported because the host hands `apply` a guard proxy over an empty target:
 * spreading `ctx` yields nothing, and reading an undeclared service throws.
 * Building the context explicitly is the fix for both, and it is unit-tested
 * against a proxy that reproduces that behavior.
 */
export function harnessContextOf(ctx: PetClientContext): HarnessContext {
  const uiSession = resolveUiSession(ctx)
  return {
    sessions: ctx.sessions,
    connection: ctx.connection,
    ...(uiSession === undefined ? {} : { uiSession }),
  }
}

/** Client half entry point: mount one pet per browser page. */
export function apply(ctx: PetClientContext): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return

  const context = harnessContextOf(ctx)
  const start = (): DisposableWhale => startHarnessPet(context)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => acquireWhaleSingleton(window, start).release, 'harness-pet: client lifecycle')
    return
  }
  // Without a lifecycle seat the pet still mounts, but the host owns teardown.
  acquireWhaleSingleton(window, start)
}
