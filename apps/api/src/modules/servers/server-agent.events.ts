import type { ServerRuntimeEvent } from '@gravit-panel/shared'
import { sse } from 'elysia'

type Listener = (event: ServerRuntimeEvent) => void

export class ServerAgentEventHub {
  private readonly listeners = new Map<string, Set<Listener>>()

  publish(event: ServerRuntimeEvent | null) {
    if (!event) return
    for (const listener of this.listeners.get(event.bindingId) ?? []) listener(event)
  }

  subscribe(bindingId: string, listener: Listener) {
    const listeners = this.listeners.get(bindingId) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(bindingId, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(bindingId)
    }
  }

  async *stream(bindingId: string, loadHistory: () => ServerRuntimeEvent[]) {
    const queue: ServerRuntimeEvent[] = []
    let wake: (() => void) | null = null
    let lastSequence = 0
    let overflow = false
    const unsubscribe = this.subscribe(bindingId, (event) => {
      if (queue.length >= 2000) {
        overflow = true
        wake?.()
        wake = null
        return
      }
      queue.push(event)
      wake?.()
      wake = null
    })
    try {
      queue.push(...loadHistory())
      while (true) {
        queue.sort((left, right) => left.sequence - right.sequence)
        while (queue.length) {
          const event = queue.shift()
          if (!event || event.sequence <= lastSequence) continue
          lastSequence = event.sequence
          yield sse({ id: event.sequence, event: 'server', data: event })
        }
        if (overflow) return
        const received = await Promise.race([
          new Promise<true>((resolve) => { wake = () => resolve(true) }),
          Bun.sleep(15_000).then(() => false as const),
        ])
        wake = null
        if (!received) {
          yield sse({ event: 'heartbeat', data: { bindingId, time: new Date().toISOString() } })
        }
      }
    } finally {
      unsubscribe()
    }
  }
}
