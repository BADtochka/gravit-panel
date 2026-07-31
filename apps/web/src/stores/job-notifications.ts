import type { JobRecord } from '@gravit-panel/shared'
import { ref } from 'vue'

type FinishedHandler = (job: JobRecord) => void

const trackedJob = ref<JobRecord | null>(null)
const trackedTitle = ref('Job')
const finishedHandlers = new Map<string, Set<FinishedHandler>>()

const isTerminal = (job: JobRecord) =>
  job.status === 'succeeded' ||
  job.status === 'failed' ||
  job.status === 'cancelled'

export const registerJobNotification = (
  job: JobRecord,
  title: string,
  onFinished: FinishedHandler,
) => {
  const current = trackedJob.value
  if (current?.id === job.id) {
    if (!isTerminal(current) || isTerminal(job)) {
      trackedJob.value = {
        ...current,
        ...job,
        progress: Math.max(current.progress, job.progress),
      }
    }
  } else {
    trackedJob.value = { ...job }
  }
  trackedTitle.value = title

  const handlers = finishedHandlers.get(job.id) ?? new Set<FinishedHandler>()
  handlers.add(onFinished)
  finishedHandlers.set(job.id, handlers)

  return () => {
    handlers.delete(onFinished)
    if (!handlers.size) finishedHandlers.delete(job.id)
  }
}

export const finishJobNotification = (job: JobRecord) => {
  trackedJob.value = { ...job }
  const handlers = finishedHandlers.get(job.id)
  if (!handlers) return
  for (const handler of handlers) handler(job)
  finishedHandlers.delete(job.id)
}

export const useJobNotifications = () => ({
  trackedJob,
  trackedTitle,
  finishJobNotification,
})
