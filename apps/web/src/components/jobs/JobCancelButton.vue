<template>
  <Button
    v-if="cancellable"
    type="button"
    variant="outline"
    :size="size"
    :disabled="isPending || requested"
    :title="error?.message ?? 'Cancel this job'"
    @click="cancelJob()"
  >
    <LoaderCircle v-if="isPending || requested" class="size-4 animate-spin" />
    <CircleStop v-else class="size-4" />
    <span v-if="showLabel">{{ requested ? 'Cancelling…' : 'Cancel' }}</span>
  </Button>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import type { JobRecord } from '@gravit-panel/shared'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { CircleStop, LoaderCircle } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  job: JobRecord | null
  showLabel?: boolean
  size?: 'default' | 'sm' | 'lg' | 'icon'
}>(), {
  showLabel: true,
  size: 'sm',
})
const emit = defineEmits<{ requested: [job: JobRecord] }>()
const queryClient = useQueryClient()
const requested = ref(false)
const cancellable = computed(
  () => props.job?.status === 'queued' || props.job?.status === 'running',
)

const {
  mutate: cancelJob,
  isPending,
  error,
} = useMutation({
  mutationFn: async () => {
    if (!props.job) throw new Error('No active job selected')
    const response = await fetch(`/api/jobs/${props.job.id}/cancel`, { method: 'POST' })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null
      throw new Error(body?.message ?? `Cancellation failed with status ${response.status}`)
    }
    return response.json() as Promise<JobRecord>
  },
  onSuccess: async (job) => {
    requested.value = job.status === 'queued' || job.status === 'running'
    emit('requested', job)
    await queryClient.invalidateQueries({ queryKey: ['jobs'] })
  },
})

watch(
  () => [props.job?.id, props.job?.status] as const,
  ([id, status], previous) => {
    if (id !== previous?.[0] || status === 'cancelled' || status === 'failed' || status === 'succeeded') {
      requested.value = false
    }
  },
)
</script>
