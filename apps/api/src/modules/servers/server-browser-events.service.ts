import type { ServerRuntimeEvent } from '@gravit-panel/shared'
import type { ServerAgentEventHub } from './server-agent.events'
import type { ServerAgentStore } from './server-agent.store'

interface BrowserEventSocket {
  raw?: object
  send(data: unknown): unknown
  close(code?: number, reason?: string): unknown
}

export class ServerBrowserEventsService {
  private readonly subscriptions = new WeakMap<object, () => void>()

  constructor(
    private readonly store: Pick<ServerAgentStore, 'listEvents'>,
    private readonly events: ServerAgentEventHub,
  ) {}

  open(socket: BrowserEventSocket, bindingId: string) {
    const key = this.socketKey(socket)
    this.close(socket)
    const sendEvent = (event: ServerRuntimeEvent) => {
      try {
        socket.send(JSON.stringify({ type: 'event', event }))
      } catch {
        this.close(socket)
        socket.close(1011, 'Unable to deliver server event')
      }
    }
    this.subscriptions.set(key, this.events.subscribe(bindingId, sendEvent))
    try {
      socket.send(JSON.stringify({
        type: 'history',
        events: this.store.listEvents(bindingId, 500),
      }))
    } catch {
      this.close(socket)
      socket.close(1011, 'Unable to deliver server history')
    }
  }

  message(socket: BrowserEventSocket, raw: unknown) {
    const message = this.parse(raw)
    if (message?.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', time: new Date().toISOString() }))
    }
  }

  close(socket: BrowserEventSocket) {
    const key = this.socketKey(socket)
    this.subscriptions.get(key)?.()
    this.subscriptions.delete(key)
  }

  private socketKey(socket: BrowserEventSocket) {
    return socket.raw ?? socket as object
  }

  private parse(raw: unknown): Record<string, unknown> | null {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>
    if (typeof raw !== 'string') return null
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
}
