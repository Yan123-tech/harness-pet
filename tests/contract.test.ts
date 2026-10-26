/**
 * Compile-time contract guard against the installed DeepSeek Harness.
 *
 * The original plugin declared its own structural interfaces and never imported
 * the real runtime types, so `tsc` passed while activation threw at runtime
 * (`ctx.connection.hostDescription` was removed in 0.2.1, and conversation
 * content moved off `SessionSnapshot`). This file closes that gap: it asserts,
 * in the type system, that the exact members the adapter reads still exist on
 * the real published contracts.
 *
 * A breaking DSH change fails `pnpm run typecheck` here instead of surfacing as
 * a silently idle pet in the browser.
 */
import type {
  ISessions,
  SessionBinding,
  SessionFace,
  SessionListState,
  SessionReference,
  SessionRetainInfo,
  SessionRetainOptions,
  SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import { describe, expect, it } from 'vitest'
import type {
  HarnessListState,
  HarnessSessionStatus,
  SignalSnapshot,
  SnapshotSource,
} from '../src/adapters/deepseek-harness.js'

/** True when `T` is assignable to `U`. */
type Assignable<T, U> = [T] extends [U] ? true : false

/** True when `K` is a key of `T`. */
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false

/** True when the two types are exactly equal. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** Forces a compile error when the argument is not `true`. */
function expectTrue<T extends true>(): void {
  void 0 as unknown as T
}

describe('installed DSH contract compatibility', () => {
  it('keeps the observable source shape the adapter subscribes to', () => {
    // A real store observable is structurally the pet's minimal source.
    expectTrue<Assignable<ObservableSnapshot<SessionSnapshot>, SnapshotSource<SessionSnapshot>>>()
    expectTrue<Assignable<SnapshotStore<unknown>, SnapshotSource<unknown>>>()
    expectTrue<Assignable<ReturnType<ISessions['list']['getSnapshot']>, HarnessListState>>()
    expect(true).toBe(true)
  })

  it('pins every SessionSnapshot member the adapter reads', () => {
    // `running` is the authoritative turn bit behind working/success.
    expectTrue<HasKey<SessionSnapshot, 'running'>>()
    expectTrue<Equal<SessionSnapshot['running'], boolean>>()
    // Send/stop failure feeds the error state.
    expectTrue<HasKey<SessionSnapshot, 'promptError'>>()
    expectTrue<HasKey<SessionSnapshot, 'lastAgentError'>>()
    expectTrue<Equal<SessionSnapshot['lastAgentError'], string | null>>()
    expect(true).toBe(true)
  })

  it('pins the sessions-service surface the adapter calls', () => {
    expectTrue<HasKey<ISessions, 'list'>>()
    expectTrue<HasKey<ISessions, 'binding'>>()
    expectTrue<HasKey<ISessions, 'retainInfo'>>()
    expectTrue<HasKey<ISessions, 'retain'>>()
    // Session ids stay opaque strings to the adapter.
    expectTrue<Assignable<Parameters<ISessions['binding']>[0], string>>()
    expectTrue<Assignable<ReturnType<ISessions['binding']>, SessionBinding | undefined>>()
    expectTrue<Assignable<ReturnType<ISessions['retainInfo']>, ObservableSnapshot<SessionRetainInfo>>>()
    expectTrue<HasKey<SessionRetainOptions, 'source'>>()
    expectTrue<Assignable<SessionReference['binding'], SessionBinding>>()
    expect(true).toBe(true)
  })

  it('keeps the SessionBinding members the adapter subscribes to', () => {
    expectTrue<HasKey<SessionBinding, 'session'>>()
    // The event window is where conversation text lives on 0.2.1.
    expectTrue<HasKey<SessionBinding, 'eventSource'>>()
    expectTrue<Assignable<SessionBinding['session'], SessionFace>>()
    expect(true).toBe(true)
  })

  it('keeps prompt callable with the pet follow-up arguments', () => {
    // The official content-part shape accepts the pet's text part.
    expectTrue<Assignable<{ type: 'text'; text: string }, PromptContentPart>>()
    expectTrue<HasKey<SessionFace, 'prompt'>>()
    // Success is discriminated by `ok`, which the adapter switches on.
    expectTrue<HasKey<Awaited<ReturnType<SessionFace['prompt']>>, 'ok'>>()
    expectTrue<Assignable<Awaited<ReturnType<SessionFace['prompt']>>['ok'], boolean>>()
    // The face is still an observable of the native snapshot (getSnapshot + subscribe).
    expectTrue<Assignable<SessionFace, ObservableSnapshot<SessionSnapshot>>>()
    expect(true).toBe(true)
  })

  it('documents the two 0.2.1 removals this fork had to adapt to', () => {
    // `SessionListState` carries no `current` field on 0.2.1; the pet derives the
    // current session from the main-view retention flag instead.
    expectTrue<HasKey<SessionListState, 'byId'>>()
    expectTrue<Equal<Extract<keyof SessionListState, 'current'>, never>>()

    // `SessionSnapshot` carries no conversation content; text comes from the
    // event window, which is why the adapter reduces `eventSource`.
    expectTrue<Equal<Extract<keyof SessionSnapshot, 'partial' | 'nodes' | 'runningCalls' | 'queue'>, never>>()

    // The pet's normalized snapshot exposes the 0.2.1-derived facts instead.
    expectTrue<HasKey<SignalSnapshot, 'sessionRunning'>>()
    expectTrue<HasKey<SignalSnapshot, 'toolNames'>>()
    expectTrue<HasKey<SignalSnapshot, 'turnFailed'>>()
    expectTrue<HasKey<SignalSnapshot, 'pendingInteraction'>>()
    expect(true).toBe(true)
  })

  it('keeps the SessionStatus shape read for waiting detection', () => {
    expectTrue<HasKey<HarnessSessionStatus, 'running'>>()
    expectTrue<HasKey<HarnessSessionStatus, 'pendingInteraction'>>()
    expect(true).toBe(true)
  })
})
