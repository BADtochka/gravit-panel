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
) => {
  const currentJob = ref<JobRecord | null>(null)
  const events = ref<JobEvent[]>([])
  let connectedJobId: string | null = null
  let connection: JobEventConnection | null = null

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
      connectedJobId = nextJobId
      events.value = []
      if (!nextJobId) return

      const jobId = nextJobId
      connection = connect(jobId)
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
            currentJob.value = record
            onFinished(record)
          })
          .catch(() => {
            // The terminal event remains visible even if the final record refresh fails.
          })
      })
    },
    { immediate: true },
  )

  onScopeDispose(closeConnection)

  return { currentJob, events }
}
