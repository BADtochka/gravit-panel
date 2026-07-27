<template>
  <Card v-if="currentJob">
    <CardHeader class="border-b">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle class="text-base">{{ title }}</CardTitle>
          <CardDescription class="font-mono">{{ currentJob.id }}</CardDescription>
        </div>
        <div class="flex items-center gap-2">
          <JobCancelButton :job="currentJob" />
          <Switch :id="switchId" v-model="autoScroll" />
          <label class="cursor-pointer text-xs text-muted-foreground" :for="switchId">
            Auto-scroll
          </label>
        </div>
      </div>
    </CardHeader>
    <div class="h-1.5 bg-muted">
      <div
        class="h-full transition-[width]"
        :class="currentJob.status === 'failed' ? 'bg-destructive' : 'bg-primary'"
        :style="{ width: `${currentJob.progress}%` }"
      />
    </div>
    <CardContent class="p-0">
      <div ref="logContainer" class="max-h-80 overflow-auto p-6 font-mono text-xs">
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
    </CardContent>
    <CardFooter
      v-if="currentJob.status === 'cancelled'"
      class="border-t pt-6 text-sm text-muted-foreground"
    >
      Job cancelled by user.
    </CardFooter>
    <CardFooter v-else-if="currentJob.error" class="border-t pt-6 text-sm text-destructive">
      {{ currentJob.error }}
    </CardFooter>
  </Card>
</template>

<script setup lang="ts">
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import JobCancelButton from '@/components/jobs/JobCancelButton.vue'
import { Switch } from '@/components/ui/switch'
import { useJobLogStream } from '@/composables/useJobLogStream'
import { useLogAutoScroll } from '@/composables/useLogAutoScroll'
import type { JobRecord } from '@gravit-panel/shared'

const props = defineProps<{ job: JobRecord | null; title?: string }>()
const emit = defineEmits<{ finished: [job: JobRecord] }>()
const { currentJob, events } = useJobLogStream(
  () => props.job,
  (job) => emit('finished', job),
)
const { autoScroll, logContainer } = useLogAutoScroll(() => events.value.length)
const switchId = `job-auto-scroll-${crypto.randomUUID()}`
</script>
