import type { JobEvent } from '@gravit-panel/shared'
import { sse } from 'elysia'

type JobEventListener = (event: JobEvent) => void

const terminalTypes = new Set<JobEvent['type']>(['completed', 'failed', 'cancelled'])

export class JobsEventHub {
  private readonly listeners = new Map<string, Set<JobEventListener>>()

  publish(event: JobEvent) {
    for (const listener of this.listeners.get(event.jobId) ?? []) {
      listener(event)
    }
  }

  subscribe(jobId: string, listener: JobEventListener) {
    const listeners = this.listeners.get(jobId) ?? new Set<JobEventListener>()
    listeners.add(listener)
    this.listeners.set(jobId, listeners)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(jobId)
    }
  }

  async *stream(jobId: string, loadHistory: () => JobEvent[], isTerminal: () => boolean) {
    const queue: JobEvent[] = []
    let wake: (() => void) | null = null
    let lastSequence = 0
    let terminal = false

    const enqueue = (event: JobEvent) => {
      queue.push(event)
      wake?.()
      wake = null
    }
    const unsubscribe = this.subscribe(jobId, enqueue)

    try {
      queue.push(...loadHistory())

      while (true) {
        while (queue.length > 0) {
          const event = queue.shift()
          if (!event || event.sequence <= lastSequence) continue

          lastSequence = event.sequence
          terminal = terminalTypes.has(event.type)
          yield sse({
            id: event.sequence,
            event: 'job',
            data: event,
          })
        }

        if (terminal || isTerminal()) return

        const eventReceived = await Promise.race([
          new Promise<true>((resolve) => {
            wake = () => resolve(true)
          }),
          Bun.sleep(15_000).then(() => false as const),
        ])
        wake = null

        if (!eventReceived) {
          yield sse({
            event: 'heartbeat',
            data: { jobId, time: new Date().toISOString() },
          })
        }
      }
    } finally {
      unsubscribe()
    }
  }
}
