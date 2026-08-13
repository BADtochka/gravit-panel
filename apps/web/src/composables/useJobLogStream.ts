import type { JobEvent, JobRecord } from '@gravit-panel/shared'
import { connectJobEventSocket, type JobEventConnection } from '@/lib/job-event-socket'
import { panelFetch } from '@/lib/public-path'
import { onScopeDispose, ref, watch, type WatchSource } from 'vue'

type ConnectToJobEvents = (jobId: string) => JobEventConnection
type LoadJob = (jobId: string) => Promise<JobRecord>

const connectToJobEvents: ConnectToJobEvents = (jobId) => {
  return connectJobEventSocket(jobId)
}

const loadJob: LoadJob = async (id) => {
  const response = await panelFetch(`/api/jobs/${id}`)
  if (!response.ok) throw new Error(`Unable to refresh job ${id}`)
  return response.json() as Promise<JobRecord>
}

export const useJobLogStream = (
  job: WatchSource<JobRecord | null>,
  onFinished: (job: JobRecord) => void,
  connect: ConnectToJobEvents = connectToJobEvents,
  getJob: LoadJob = loadJob,
  pollIntervalMs = 1_000,
) => {
  const currentJob = ref<JobRecord | null>(null)
  const events = ref<JobEvent[]>([])
  let connectedJobId: string | null = null
  let connection: JobEventConnection | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  const finishedJobs = new Set<string>()

  const isTerminal = (record: JobRecord) =>
    record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled'

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  const finish = (record: JobRecord) => {
    if (finishedJobs.has(record.id)) return
    finishedJobs.add(record.id)
    stopPolling()
    closeConnection()
    currentJob.value = record
    if (!events.value.some((event) => event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled')) {
      events.value = [...events.value, {
        sequence: -1,
        jobId: record.id,
        type: record.status === 'succeeded' ? 'completed' : record.status === 'cancelled' ? 'cancelled' : 'failed',
        message: record.error ?? (record.status === 'succeeded' ? 'Job completed successfully' : 'Job cancelled by user'),
        progress: record.progress,
        createdAt: record.finishedAt ?? new Date().toISOString(),
      }]
    }
    onFinished(record)
  }

  const closeConnection = () => {
    connection?.close()
    connection = null
  }

  watch(
    job,
    (nextJob) => {
      currentJob.value = nextJob ? { ...nextJob } : null
      const nextJobId = nextJob?.id ?? null
      if (nextJobId === connectedJobId) return

      closeConnection()
      stopPolling()
      connectedJobId = nextJobId
      events.value = []
      if (!nextJobId) return

      const jobId = nextJobId
      const refreshJob = () => void getJob(jobId).then((record) => {
        if (connectedJobId !== jobId) return
        currentJob.value = record
        if (isTerminal(record)) finish(record)
      }).catch(() => {})
      const startPolling = () => {
        if (pollTimer || finishedJobs.has(jobId)) return
        refreshJob()
        pollTimer = setInterval(refreshJob, pollIntervalMs)
      }
      connection = connect(jobId)
      connection.onState((state) => {
        if (connectedJobId !== jobId) return
        if (state === 'live') {
          stopPolling()
          return
        }
        if (state === 'reconnecting' || state === 'closed') startPolling()
      })
      connection.onEvents((batch) => {
        const additions = batch.filter((event) =>
          !events.value.some((item) => item.sequence === event.sequence))
        if (additions.length === 0) return
        events.value = [...events.value, ...additions]
          .sort((left, right) => left.sequence - right.sequence)
          .slice(-1000)
        const latestProgress = additions.findLast((event) => event.progress !== null)?.progress
        if (latestProgress !== undefined && latestProgress !== null && currentJob.value) {
          currentJob.value.progress = latestProgress
        }
        const event = additions.findLast((item) =>
          item.type === 'completed' || item.type === 'failed' || item.type === 'cancelled')
        if (!event) return

        closeConnection()
        if (currentJob.value?.id === jobId) {
          currentJob.value.status =
            event.type === 'completed'
              ? 'succeeded'
              : event.type === 'cancelled'
                ? 'cancelled'
                : 'failed'
        }
        void getJob(jobId)
          .then((record) => {
            if (connectedJobId !== jobId) return
            finish(record)
          })
          .catch(() => {
            // The terminal event remains visible even if the final record refresh fails.
          })
      })
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    stopPolling()
    closeConnection()
  })

  return { currentJob, events }
}
