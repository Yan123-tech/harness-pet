/**
 * Entry-point hardening tests.
 *
 * The DSH client runner does not call the plugin's `apply` with the raw Cordis
 * context: it passes a **guard proxy** whose target is empty and which throws
 * when a service is read without being declared. Two real bugs during the
 * 0.2.1 port came from ignoring that:
 *
 *   1. reading `ctx.uiSession` directly threw at activation, aborting the whole
 *      client lifecycle;
 *   2. spreading the proxy (`{ ...ctx }`) yielded `{}`, silently dropping
 *      `sessions` and `connection`.
 *
 * `harnessContextOf` is the fix for both; these tests reproduce the guard's
 * observable behavior so neither regression can return unnoticed.
 */
import { describe, expect, it } from 'vitest'
import { harnessContextOf, inject, type PetClientContext } from '../src/client/index.js'
import type { SignalSnapshot, SnapshotSource } from '../src/adapters/deepseek-harness.js'

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
}

/**
 * A stand-in for the runner's guard proxy: an empty target (so spreading yields
 * nothing) and a `get` trap that throws for undeclared services, matching
 * `dynamicCordisContext` in `dsh-cordis-client-runner`.
 */
function guardContext(services: Record<string, unknown>, declared: string[]) {
  const declaredSet = new Set(declared)
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'get') return (name: string) => services[name]
      if (typeof prop !== 'string') return undefined
      if (!declaredSet.has(prop)) {
        throw new Error(`service "${prop}" is not declared by your plugin`)
      }
      return services[prop]
    },
    has: (_target, prop) => typeof prop === 'string' && declaredSet.has(prop),
  })
}

function services(overrides: Record<string, unknown> = {}) {
  const session = new Source<SignalSnapshot>({ running: true })
  return {
    sessions: { list: new Source({ byId: {} }), binding: () => ({ session }) },
    connection: { state: new Source('connected') },
    ...overrides,
  }
}

describe('client entry hardening', () => {
  it('declares only services the host always provides', () => {
    // `uiSession` is deliberately absent: it is optional and read via ctx.get.
    expect(inject).toEqual(['sessions', 'connection'])
    expect(inject).not.toContain('uiSession')
  })

  it('does not throw on the guard proxy and keeps the declared services', () => {
    const ctx = guardContext(services(), ['sessions', 'connection'])
    const context = harnessContextOf(ctx as unknown as PetClientContext)

    // Spreading the proxy would have produced {}; explicit reads preserve these.
    expect(context.sessions).toBeDefined()
    expect(context.connection).toBeDefined()
    expect(context.sessions.list.getSnapshot()).toEqual({ byId: {} })
  })

  it('omits uiSession without throwing when the service is absent', () => {
    const ctx = guardContext(services(), ['sessions', 'connection'])
    const context = harnessContextOf(ctx as unknown as PetClientContext)
    // Read through ctx.get, so the undeclared read never happens.
    expect(context.uiSession).toBeUndefined()
  })

  it('attaches uiSession when the host provides it', () => {
    const status = new Source(new Map([['s1', { running: true, pendingInteraction: { kind: 'approval' } }]]))
    const ctx = guardContext(services({ uiSession: { sessionStatus: status } }), ['sessions', 'connection'])
    const context = harnessContextOf(ctx as unknown as PetClientContext)

    expect(context.uiSession?.sessionStatus).toBe(status)
    expect(context.uiSession?.sessionStatus?.getSnapshot().get('s1')?.running).toBe(true)
  })

  it('rejects a direct read of an undeclared service (documents the hazard)', () => {
    const ctx = guardContext(services({ uiSession: { sessionStatus: new Source(new Map()) } }), ['sessions', 'connection'])
    // This is exactly the call that used to abort activation.
    expect(() => (ctx as unknown as { uiSession: unknown }).uiSession).toThrow(/not declared/)
  })

  it('spreads to nothing, which is why explicit reads are required', () => {
    const ctx = guardContext(services(), ['sessions', 'connection'])
    expect({ ...ctx }).toEqual({})
  })
})
