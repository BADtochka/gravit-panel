<template>
  <Dialog v-model:open="logsOpen">
    <DialogContent class="flex max-h-[85vh] w-[calc(100%-2rem)] flex-col sm:max-w-5xl">
      <DialogHeader>
        <DialogTitle>{{ trackedTitle }}</DialogTitle>
        <DialogDescription v-if="currentJob" class="font-mono">
          {{ currentJob.id }}
        </DialogDescription>
      </DialogHeader>
      <template v-if="currentJob">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <span class="capitalize">{{ currentJob.status }}</span>
            <span>·</span>
            <span class="tabular-nums">{{ currentJob.progress }}%</span>
          </div>
          <div class="flex items-center gap-2">
            <JobCancelButton :job="currentJob" />
            <Switch :id="switchId" v-model="autoScroll" />
            <label class="cursor-pointer text-xs text-muted-foreground" :for="switchId">
              Auto-scroll
            </label>
          </div>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            class="h-full rounded-full transition-[width]"
            :class="currentJob.status === 'failed' ? 'bg-destructive' : 'bg-primary'"
            :style="{ width: `${currentJob.progress}%` }"
          />
        </div>
        <div ref="logContainer" class="min-h-64 flex-1 overflow-auto rounded-md border p-4 font-mono text-xs">
          <p v-if="events.length === 0" class="text-muted-foreground">Waiting for job events...</p>
          <div
            v-for="event in events"
            :key="event.sequence"
            class="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 border-b py-1.5 last:border-0"
          >
            <span class="text-muted-foreground">{{ event.type }}</span>
            <span class="break-words">{{ event.message }}</span>
          </div>
        </div>
        <p v-if="currentJob.status === 'cancelled'" class="text-sm text-muted-foreground">
          Job cancelled by user.
        </p>
        <p v-else-if="currentJob.error" class="text-sm text-destructive">
          {{ currentJob.error }}
        </p>
      </template>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import JobCancelButton from '@/components/jobs/JobCancelButton.vue'
import JobProgressToast from '@/components/jobs/JobProgressToast.vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useJobLogStream } from '@/composables/useJobLogStream'
import { useLogAutoScroll } from '@/composables/useLogAutoScroll'
import { useJobNotifications } from '@/stores/job-notifications'
import { toast } from 'vue-sonner'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const logsOpen = ref(false)
const { trackedJob, trackedTitle, finishJobNotification } = useJobNotifications()
const { currentJob, events } = useJobLogStream(
  () => trackedJob.value,
  finishJobNotification,
)
const { autoScroll, logContainer } = useLogAutoScroll(() => events.value.length)
const switchId = `job-auto-scroll-${crypto.randomUUID()}`
const toastId = computed(() => currentJob.value ? `job-${currentJob.value.id}` : null)
const dismissedToastIds = new Set<string>()
const dismissalTimers = new Map<string, ReturnType<typeof setTimeout>>()

const openLogs = () => {
  logsOpen.value = true
}

const openJobs = () => {
  const jobId = currentJob.value?.id
  void router.push({
    path: '/jobs',
    query: jobId ? { job: jobId } : undefined,
  })
}

const dismissNotification = (id: string) => {
  const timer = dismissalTimers.get(id)
  if (timer) clearTimeout(timer)
  dismissalTimers.delete(id)
  dismissedToastIds.add(id)
  toast.dismiss(id)
}

const scheduleDismissal = (id: string) => {
  if (dismissalTimers.has(id)) return
  dismissalTimers.set(id, setTimeout(() => {
    dismissalTimers.delete(id)
    dismissedToastIds.add(id)
    toast.dismiss(id)
  }, 10_000))
}

watch(
  () => [
    currentJob.value?.id,
    currentJob.value?.status,
    currentJob.value?.progress,
    trackedTitle.value,
  ] as const,
  ([jobId, status, progress, title]) => {
    if (!jobId || !status || progress === undefined) return
    const id = `job-${jobId}`
    if (dismissedToastIds.has(id)) return

    const terminal =
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'cancelled'
    const message =
      status === 'succeeded'
        ? `${title} completed`
        : status === 'failed'
          ? `${title} failed`
          : status === 'cancelled'
            ? `${title} cancelled`
            : title

    if (terminal) scheduleDismissal(id)

    toast.custom(JobProgressToast, {
      id,
      componentProps: {
        title: message,
        progress,
        status,
        onOpenLogs: openLogs,
        onOpenJobs: openJobs,
        onDismiss: () => dismissNotification(id),
      },
      dismissible: terminal,
      duration: terminal ? (status === 'failed' ? 15_000 : 10_000) : Infinity,
    })
  },
  { immediate: true },
)

onScopeDispose(() => {
  for (const timer of dismissalTimers.values()) clearTimeout(timer)
  dismissalTimers.clear()
  if (toastId.value) toast.dismiss(toastId.value)
})
</script>
