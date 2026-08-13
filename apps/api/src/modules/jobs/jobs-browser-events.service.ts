import type { JobEvent, JobRecord } from '@gravit-panel/shared'
import type { JobsEventHub } from './jobs.events'
import type { JobsStore } from './jobs.store'

interface JobEventSocket {
  raw?: object
  send(data: unknown): unknown
  close(code?: number, reason?: string): unknown
}

const terminalTypes = new Set<JobEvent['type']>(['completed', 'failed', 'cancelled'])
const terminalStatuses = new Set<JobRecord['status']>(['succeeded', 'failed', 'cancelled'])

export class JobsBrowserEventsService {
  private readonly subscriptions = new WeakMap<object, () => void>()

  constructor(
    private readonly store: Pick<JobsStore, 'get' | 'listRecentEvents'>,
    private readonly events: JobsEventHub,
  ) {}

  open(socket: JobEventSocket, jobId: string) {
    const job = this.store.get(jobId)
    if (!job) {
      socket.close(1008, 'Job not found')
      return
    }
    const key = this.socketKey(socket)
    this.close(socket)
    const sendEvent = (event: JobEvent) => {
      try {
        socket.send(JSON.stringify({ type: 'event', event }))
        if (terminalTypes.has(event.type)) {
          this.close(socket)
          socket.close(1000, 'Job complete')
        }
      } catch {
        this.close(socket)
        socket.close(1011, 'Unable to deliver job event')
      }
    }
    if (!terminalStatuses.has(job.status)) {
      this.subscriptions.set(key, this.events.subscribe(jobId, sendEvent))
    }
    try {
      socket.send(JSON.stringify({
        type: 'history',
        events: this.store.listRecentEvents(jobId, 1000),
        terminal: terminalStatuses.has(job.status),
      }))
    } catch {
      this.close(socket)
      socket.close(1011, 'Unable to deliver job history')
      return
    }
    // Let the client close after receiving terminal history. Closing here can race
    // the WebSocket transport and discard the history frame for very fast jobs.
  }

  message(socket: JobEventSocket, raw: unknown) {
    const message = this.parse(raw)
    if (message?.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', time: new Date().toISOString() }))
    }
  }

  close(socket: JobEventSocket) {
    const key = this.socketKey(socket)
    this.subscriptions.get(key)?.()
    this.subscriptions.delete(key)
  }

  private socketKey(socket: JobEventSocket) {
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
