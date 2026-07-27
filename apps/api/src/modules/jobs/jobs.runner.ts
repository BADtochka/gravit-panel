import type { JobEvent, JobRecord, JobType } from '@gravit-panel/shared'
import { logger } from '../../core/logger'
import type { JobsEventHub } from './jobs.events'
import type { JobsStore } from './jobs.store'

const demoSteps = [
  { progress: 25, message: 'Workspace accepted the job' },
  { progress: 60, message: 'Background worker is processing the no-op task' },
  { progress: 90, message: 'No-op checks completed' },
] as const

export class JobsRunner {
  private readonly running = new Map<string, AbortController>()
  private readonly cancelled = new Set<string>()

  constructor(
    private readonly store: JobsStore,
    private readonly events: JobsEventHub,
  ) {
    this.recoverInterruptedJobs()
  }

  createDemoJob(): JobRecord {
    return this.create('demo.noop', {}, 'Demo job queued', async ({ progress, signal }) => {
      for (const step of demoSteps) {
        await Bun.sleep(200)
        signal.throwIfAborted()
        progress(step.progress, step.message)
      }

      return { message: 'No-op job completed successfully' }
    })
  }

  create(
    type: JobType,
    input: Record<string, unknown>,
    queuedMessage: string,
    task: JobTask,
  ): JobRecord {
    const job = this.store.create(type, input)
    this.emit(job.id, 'queued', queuedMessage, 0)
    queueMicrotask(() => void this.runJob(job.id, task))
    return job
  }

  hasActiveType(type: JobType) {
    return this.store.listByStatuses(['queued', 'running']).some((job) => job.type === type)
  }

  runningIds() {
    return [...this.running.keys()]
  }

  cancel(jobId: string): JobRecord | null {
    const job = this.store.get(jobId)
    if (!job) return null
    if (job.status !== 'queued' && job.status !== 'running') return job
    if (this.cancelled.has(jobId)) return job

    this.cancelled.add(jobId)
    const controller = this.running.get(jobId)
    if (job.status === 'running') {
      controller?.abort(new Error('Job cancelled by user'))
      this.emit(jobId, 'log', 'Cancellation requested')
      return job
    }

    controller?.abort(new Error('Job cancelled by user'))
    const cancelled = this.store.update(jobId, {
      status: 'cancelled',
      error: null,
      finishedAt: new Date().toISOString(),
    })
    this.emit(jobId, 'cancelled', 'Job cancelled by user')
    return cancelled
  }

  private async runJob(jobId: string, task: JobTask) {
    if (this.cancelled.has(jobId)) {
      this.cancelled.delete(jobId)
      return
    }
    const controller = new AbortController()
    this.running.set(jobId, controller)

    try {
      if (this.cancelled.has(jobId)) {
        controller.abort(new Error('Job cancelled by user'))
        return
      }
      const startedAt = new Date().toISOString()
      this.store.update(jobId, { status: 'running', startedAt })
      this.emit(jobId, 'started', 'Job started', 0)

      const result = await task({
        signal: controller.signal,
        log: (message) => {
          controller.signal.throwIfAborted()
          this.emit(jobId, 'log', message)
        },
        progress: (value, message) => {
          controller.signal.throwIfAborted()
          this.store.update(jobId, { progress: value })
          this.emit(jobId, 'progress', message, value)
        },
      })

      if (this.cancelled.has(jobId) && !controller.signal.aborted) {
        controller.abort(new Error('Job cancelled by user'))
      }
      controller.signal.throwIfAborted()
      if (this.store.get(jobId)?.status === 'cancelled') return
      const finishedAt = new Date().toISOString()
      this.store.update(jobId, {
        status: 'succeeded',
        progress: 100,
        result,
        finishedAt,
      })
      this.emit(jobId, 'completed', 'Job completed successfully', 100)
    } catch (error) {
      if (controller.signal.aborted || this.store.get(jobId)?.status === 'cancelled') {
        if (this.store.get(jobId)?.status !== 'cancelled') {
          this.store.update(jobId, {
            status: 'cancelled',
            error: null,
            finishedAt: new Date().toISOString(),
          })
          this.emit(jobId, 'cancelled', 'Job cancelled by user')
        }
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.store.update(jobId, {
        status: 'failed',
        error: message,
        finishedAt: new Date().toISOString(),
      })
      this.emit(jobId, 'failed', message)
      logger.error(`Job ${jobId} failed`, error)
    } finally {
      this.running.delete(jobId)
      this.cancelled.delete(jobId)
    }
  }

  private recoverInterruptedJobs() {
    for (const job of this.store.listByStatuses(['queued', 'running'])) {
      const message = 'Job was interrupted by an API restart'
      this.store.update(job.id, {
        status: 'failed',
        error: message,
        finishedAt: new Date().toISOString(),
      })
      this.emit(job.id, 'failed', message)
    }
  }

  private emit(
    jobId: string,
    type: JobEvent['type'],
    message: string,
    progress: number | null = null,
  ) {
    const event = this.store.appendEvent(jobId, type, message, progress)
    this.events.publish(event)
  }
}

export interface JobTaskContext {
  signal: AbortSignal
  log: (message: string) => void
  progress: (value: number, message: string) => void
}

export type JobTask = (context: JobTaskContext) => Promise<Record<string, unknown>>
