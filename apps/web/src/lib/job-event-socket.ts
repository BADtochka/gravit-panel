import type { JobEvent } from '@gravit-panel/shared'
import { panelWebSocketUrl } from './public-path'

export type JobEventSocketState = 'connecting' | 'live' | 'reconnecting' | 'closed'

export interface JobEventConnection {
  close(): void
  onEvents(listener: (events: JobEvent[]) => void): void
  onState(listener: (state: JobEventSocketState) => void): void
}

interface JobSocketMessage {
  type: 'history' | 'event' | 'pong'
  events?: JobEvent[]
  event?: JobEvent
  terminal?: boolean
}

const terminalTypes = new Set<JobEvent['type']>(['completed', 'failed', 'cancelled'])

export const connectJobEventSocket = (jobId: string): JobEventConnection => {
  let socket: WebSocket | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let terminal = false
  let retryAttempt = 0
  let state: JobEventSocketState = 'connecting'
  let eventsListener: (events: JobEvent[]) => void = () => {}
  let stateListener: (state: JobEventSocketState) => void = () => {}

  const setState = (next: JobEventSocketState) => {
    state = next
    stateListener(next)
  }
  const clearHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  const connect = () => {
    if (stopped || terminal) return
    socket = new WebSocket(panelWebSocketUrl(`/api/jobs/${jobId}/events/ws`))
    socket.addEventListener('open', () => {
      retryAttempt = 0
      setState('live')
      heartbeatTimer = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
      }, 20_000)
    })
    socket.addEventListener('message', (raw) => {
      let message: JobSocketMessage
      try {
        message = JSON.parse(String(raw.data)) as JobSocketMessage
      } catch {
        return
      }
      const batch = message.type === 'history'
        ? message.events ?? []
        : message.type === 'event' && message.event
          ? [message.event]
          : []
      if (batch.length > 0) eventsListener(batch)
      terminal = message.terminal === true || batch.some((event) => terminalTypes.has(event.type))
      if (terminal) socket?.close(1000, 'Terminal history received')
    })
    socket.addEventListener('close', () => {
      clearHeartbeat()
      socket = null
      if (stopped || terminal) {
        setState('closed')
        return
      }
      setState('reconnecting')
      const delay = Math.min(1000 * 2 ** retryAttempt, 10_000)
      retryAttempt += 1
      retryTimer = setTimeout(connect, delay)
    })
  }

  connect()
  return {
    close: () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      clearHeartbeat()
      socket?.close(1000, 'Client closed')
      socket = null
    },
    onEvents: (listener) => { eventsListener = listener },
    onState: (listener) => {
      stateListener = listener
      listener(state)
    },
  }
}
