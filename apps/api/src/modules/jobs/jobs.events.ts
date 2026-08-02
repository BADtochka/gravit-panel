import type { JobEvent } from '@gravit-panel/shared'

type JobEventListener = (event: JobEvent) => void

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
}
