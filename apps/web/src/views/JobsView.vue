<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-2xl font-semibold tracking-tight">Jobs</h2>
        <p class="mt-1 text-sm text-muted-foreground">Background operations and live execution logs.</p>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          type="button"
          title="Refresh jobs"
          aria-label="Refresh jobs"
          @click="refetch()"
        >
          <RefreshCw class="size-4" :class="{ 'animate-spin': isFetching }" aria-hidden="true" />
        </Button>
        <Button type="button" :disabled="isPending" @click="createJob()">
          <Play class="size-4" aria-hidden="true" />
          Run demo job
        </Button>
      </div>
    </div>

    <p
      v-if="queryError || createError"
      class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {{ (queryError || createError)?.message }}
    </p>

    <div class="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div class="space-y-2">
        <p class="text-xs font-medium uppercase text-muted-foreground">Recent jobs</p>
        <p v-if="isLoading" class="py-8 text-center text-sm text-muted-foreground">Loading jobs...</p>
        <p
          v-else-if="!jobs?.items.length"
          class="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground"
        >
          No jobs yet
        </p>
        <Button
          v-for="job in jobs?.items"
          :key="job.id"
          variant="outline"
          type="button"
          class="h-auto w-full flex-col items-stretch gap-0 whitespace-normal bg-card p-3 text-left shadow-none hover:bg-accent dark:bg-card"
          :class="{
            'border-foreground/30 bg-accent dark:bg-accent': selectedJobId === job.id,
          }"
          @click="selectedJobId = job.id"
        >
          <span class="flex items-center justify-between gap-2">
            <span class="truncate text-sm font-medium">{{ job.type }}</span>
            <span class="rounded px-1.5 py-0.5 text-xs font-medium" :class="statusClass[job.status]">
              {{ statusLabel[job.status] }}
            </span>
          </span>
          <span class="mt-2 block h-1.5 overflow-hidden rounded bg-muted">
            <span
              class="block h-full bg-foreground transition-[width]"
              :style="{ width: `${job.progress}%` }"
            />
          </span>
          <span class="mt-2 block text-xs text-muted-foreground">{{ formatTime(job.createdAt) }}</span>
        </Button>
      </div>

      <div class="min-w-0 rounded-md border bg-card">
        <div class="flex h-12 items-center justify-between border-b px-4">
          <p class="text-sm font-medium">Live log</p>
          <div v-if="selectedJob" class="flex items-center gap-2">
            <JobCancelButton :job="selectedJob" />
            <div class="flex items-center gap-2">
              <Switch id="jobs-auto-scroll" v-model="autoScroll" />
              <label class="text-xs text-muted-foreground" for="jobs-auto-scroll">Auto-scroll</label>
            </div>
            <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span class="size-1.5 rounded-full" :class="streamStateClass" />
              {{ streamStateLabel }}
            </span>
            <span class="font-mono text-xs text-muted-foreground">
              {{ selectedJob.id.slice(0, 8) }}
            </span>
          </div>
        </div>
        <div v-if="!selectedJobId" class="grid min-h-80 place-items-center p-6 text-sm text-muted-foreground">
          Select a job to inspect its log
        </div>
        <div
          v-else
          ref="logContainer"
          class="min-h-80 max-h-[36rem] overflow-auto p-4 font-mono text-xs"
        >
          <p v-if="events.length === 0" class="text-muted-foreground">Waiting for events...</p>
          <div
            v-for="event in events"
            :key="event.sequence"
            class="grid grid-cols-[5rem_5rem_minmax(0,1fr)] gap-3 border-b py-2 last:border-0"
          >
            <span class="text-muted-foreground">{{ formatTime(event.createdAt, true) }}</span>
            <span class="font-medium">{{ event.type }}</span>
            <span class="break-words">{{ event.message }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import JobCancelButton from '@/components/jobs/JobCancelButton.vue'
import { Switch } from '@/components/ui/switch'
import { useLogAutoScroll } from '@/composables/useLogAutoScroll'
import { panelFetch, panelUrl } from '@/lib/public-path'
import type { JobEvent, JobRecord, JobStatus, JobsResponse } from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Play, RefreshCw } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const queryClient = useQueryClient()
const selectedJobId = ref('')
const events = ref<JobEvent[]>([])
const { autoScroll, logContainer } = useLogAutoScroll(() => events.value.length)
const streamState = ref<'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed'>('idle')
let eventSource: EventSource | null = null

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await panelFetch(input, init)
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
  return response.json() as Promise<T>
}

const {
  data: jobs,
  error: queryError,
  isFetching,
  isLoading,
  refetch,
} = useQuery({
  queryKey: ['jobs'],
  queryFn: () => getJson<JobsResponse>('/api/jobs?limit=50'),
  refetchInterval: 1_000,
})

const { error: createError, mutate: createJob, isPending } = useMutation({
  mutationFn: () => getJson<JobRecord>('/api/jobs/demo', { method: 'POST' }),
  onSuccess: async (job) => {
    selectedJobId.value = job.id
    await queryClient.invalidateQueries({ queryKey: ['jobs'] })
  },
})

const selectedJob = computed(() => jobs.value?.items.find((job) => job.id === selectedJobId.value))

const connectToJob = (jobId: string) => {
  eventSource?.close()
  events.value = []
  streamState.value = jobId ? 'connecting' : 'idle'
  if (!jobId) return

  const seen = new Set<number>()
  eventSource = new EventSource(panelUrl(`/api/jobs/${jobId}/events`))
  eventSource.onopen = () => {
    streamState.value = 'live'
  }
  eventSource.onerror = () => {
    streamState.value = 'reconnecting'
  }
  eventSource.addEventListener('job', (rawEvent) => {
    const event = JSON.parse((rawEvent as MessageEvent<string>).data) as JobEvent
    if (seen.has(event.sequence)) return

    seen.add(event.sequence)
    events.value.push(event)

    if (
      event.type === 'completed' ||
      event.type === 'failed' ||
      event.type === 'cancelled'
    ) {
      eventSource?.close()
      streamState.value = 'closed'
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    }
  })
}

watch(
  () => jobs.value?.items,
  (items) => {
    if (!selectedJobId.value && items?.length) {
      selectedJobId.value =
        items.find((job) => job.status === 'queued' || job.status === 'running')?.id ??
        items[0].id
    }
  },
  { immediate: true },
)
watch(selectedJobId, connectToJob)
onBeforeUnmount(() => eventSource?.close())

const statusLabel: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const statusClass: Record<JobStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  succeeded: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  cancelled: 'bg-muted text-muted-foreground',
}

const streamStateLabel = computed(
  () =>
    ({
      idle: 'Idle',
      connecting: 'Connecting',
      live: 'Live',
      reconnecting: 'Reconnecting',
      closed: 'Complete',
    })[streamState.value],
)
const streamStateClass = computed(
  () =>
    ({
      idle: 'bg-muted-foreground',
      connecting: 'bg-amber-500',
      live: 'bg-emerald-500',
      reconnecting: 'bg-amber-500',
      closed: 'bg-muted-foreground',
    })[streamState.value],
)

const formatTime = (value: string, includeSeconds = false) =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: includeSeconds ? '2-digit' : undefined,
  }).format(new Date(value))
</script>
