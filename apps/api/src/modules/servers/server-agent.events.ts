import type { ServerRuntimeEvent } from '@gravit-panel/shared'

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
}
