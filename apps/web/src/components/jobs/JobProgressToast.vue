<template>
  <div
    class="w-[var(--width)] max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg"
  >
    <div class="flex items-start gap-3">
      <div
        class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full"
        :class="statusIconClass"
      >
        <CircleCheck v-if="status === 'succeeded'" class="size-4" />
        <CircleX v-else-if="status === 'failed'" class="size-4" />
        <Ban v-else-if="status === 'cancelled'" class="size-4" />
        <LoaderCircle v-else class="size-4 animate-spin" />
      </div>

      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium">{{ title }}</p>
        <p class="mt-0.5 text-xs capitalize text-muted-foreground">{{ status }}</p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="size-8"
          title="Open logs"
          aria-label="Open logs"
          @click="onOpenLogs"
        >
          <ScrollText class="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="size-8"
          title="Open jobs"
          aria-label="Open jobs"
          @click="onOpenJobs"
        >
          <ListChecks class="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="size-8"
          title="Close notification"
          aria-label="Close notification"
          @click="onDismiss"
        >
          <X class="size-4" />
        </Button>
      </div>
    </div>

    <div class="mt-3 flex items-center gap-3">
      <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          class="h-full rounded-full transition-[width] duration-300"
          :class="progressClass"
          :style="{ width: `${progress}%` }"
        />
      </div>
      <span class="w-9 text-right text-xs tabular-nums text-muted-foreground">
        {{ progress }}%
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import type { JobRecord } from '@gravit-panel/shared'
import {
  Ban,
  CircleCheck,
  CircleX,
  ListChecks,
  LoaderCircle,
  ScrollText,
  X,
} from '@lucide/vue'
import { computed } from 'vue'

const props = defineProps<{
  title: string
  progress: number
  status: JobRecord['status']
  onOpenLogs: () => void
  onOpenJobs: () => void
  onDismiss: () => void
}>()

const statusIconClass = computed(() => {
  if (props.status === 'succeeded') return 'bg-emerald-500/15 text-emerald-500'
  if (props.status === 'failed') return 'bg-destructive/15 text-destructive'
  if (props.status === 'cancelled') return 'bg-muted text-muted-foreground'
  return 'bg-primary/10 text-primary'
})

const progressClass = computed(() => {
  if (props.status === 'failed') return 'bg-destructive'
  if (props.status === 'cancelled') return 'bg-muted-foreground'
  if (props.status === 'succeeded') return 'bg-emerald-500'
  return 'bg-primary'
})
</script>
