import { describe, expect, it, vi } from 'vitest'
import { startHarnessPet } from '../src/client/index.js'
import type { HarnessContext, SignalSnapshot, SnapshotSource } from '../src/adapters/deepseek-harness.js'
import type { WhalePetOptions } from '../src/pet/index.js'

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

describe('client lifecycle', () => {
  it('wires replies and follow-up sending, then releases every resource', async () => {
    vi.useFakeTimers()
    // DSH 0.2.1: conversation content arrives on the session event window, and
    // running/pending come from the uiSession status feed.
    const entries = (text: string, streaming: string) => ({
      entries: [
        { type: 'event', event: { type: 'user/message', seq: 1, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } },
        { type: 'transient', event: { type: 'assistant/live-chunk', data: { chunk: { type: 'text-delta', text: streaming } } } },
      ],
    })
    const session = Object.assign(new Source<SignalSnapshot>({ running: true }), {
      prompt: vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
    })
    const events = new Source<unknown>(entries('检查这个项目', '正在检查'))
    const list = new Source({ byId: { current: { retainedBy: { mainView: 1 } } } })
    const status = new Source(new Map([['current', { running: true }]]))
    const connection = new Source<'connected' | 'reconnecting' | undefined>('connected')
    const context: HarnessContext = {
      sessions: { list, binding: () => ({ session: session as never, eventSource: events as never }) },
      connection: { state: connection },
      uiSession: { sessionStatus: status as never },
    }
    const pet = { setStatus: vi.fn(), dispose: vi.fn() }
    let createOptions: WhalePetOptions | undefined
    const lifecycle = startHarnessPet(context, (options) => {
      createOptions = options
      return pet
    })

    // The turn is running with no open tool call, so the pet is generating.
    expect(pet.setStatus).toHaveBeenLastCalledWith('thinking', '检查这个项目', '正在检查', 'current')
    events.publish(entries('检查这个项目', '正在检查，而且仍在持续输出更多文字'))
    expect(pet.setStatus).toHaveBeenLastCalledWith(
      'thinking',
      '检查这个项目',
      '正在检查，而且仍在持续输出更多文字',
      'current',
    )
    await expect(createOptions?.onFollowup?.('继续')).resolves.toEqual({ ok: true })
    expect(session.prompt).toHaveBeenCalledWith([{ type: 'text', text: '继续' }], 'queue')

    // The turn ends cleanly: status clears and the derived success state fires.
    session.publish({ running: false })
    expect(pet.setStatus).toHaveBeenLastCalledWith('success', '检查这个项目', '正在检查，而且仍在持续输出更多文字', 'current')
    expect(list.listeners.size).toBe(1)
    expect(session.listeners.size).toBe(1)
    expect(events.listeners.size).toBe(1)
    expect(status.listeners.size).toBe(1)
    expect(connection.listeners.size).toBe(1)

    lifecycle.dispose()
    vi.advanceTimersByTime(4_000)

    expect(list.listeners.size).toBe(0)
    expect(session.listeners.size).toBe(0)
    expect(events.listeners.size).toBe(0)
    expect(status.listeners.size).toBe(0)
    expect(connection.listeners.size).toBe(0)
    expect(pet.dispose).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
