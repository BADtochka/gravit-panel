import type { JobEvent, JobRecord } from '@gravit-panel/shared'
import { panelFetch, panelUrl } from '@/lib/public-path'
import { onScopeDispose, ref, watch, type WatchSource } from 'vue'

interface JobEventConnection {
  close(): void
  onJob(listener: (event: MessageEvent<string>) => void): void
}

type ConnectToJobEvents = (jobId: string) => JobEventConnection
type LoadJob = (jobId: string) => Promise<JobRecord>

const connectToJobEvents: ConnectToJobEvents = (jobId) => {
  const source = new EventSource(panelUrl(`/api/jobs/${jobId}/events`))
  return {
    close: () => source.close(),
    onJob: (listener) => source.addEventListener('job', listener),
  }
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
      connection.onJob((rawEvent) => {
        const event = JSON.parse(rawEvent.data) as JobEvent
        if (events.value.some((item) => item.sequence === event.sequence)) return
        events.value.push(event)
        if (event.progress !== null && currentJob.value) {
          currentJob.value.progress = event.progress
        }
        if (
          event.type !== 'completed' &&
          event.type !== 'failed' &&
          event.type !== 'cancelled'
        ) return

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
