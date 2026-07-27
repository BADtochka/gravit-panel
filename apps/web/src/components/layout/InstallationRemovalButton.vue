<template>
  <AlertDialog>
    <AlertDialogTrigger as-child>
      <Button
        class="w-full cursor-pointer"
        size="sm"
        variant="outline"
        :disabled="pending || !selectedInstallation"
      >
        <LoaderCircle v-if="pending" class="animate-spin" />
        <Trash2 v-else />
        {{ pending ? 'Deleting profile…' : 'Delete profile' }}
      </Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete {{ selectedInstallation?.name }} permanently?</AlertDialogTitle>
        <AlertDialogDescription class="space-y-2">
          <span class="block">
            Containers, Compose volumes, installation files, configuration snapshots, and the
            encrypted RemoteControl credential will be removed.
          </span>
          <span class="block break-all font-mono text-xs">{{ selectedInstallation?.path }}</span>
          <span class="block font-medium text-destructive">
            This cannot be undone. Job history is retained as an audit log.
          </span>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          class="cursor-pointer bg-destructive text-white hover:bg-destructive/90"
          @click="startRemoval"
        >
          Delete profile and data
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
  <JobCancelButton v-if="pending" class="w-full" :job="currentJob" />
  <p v-if="error" class="text-xs text-destructive">{{ error.message }}</p>
</template>

<script setup lang="ts">
import JobCancelButton from '@/components/jobs/JobCancelButton.vue'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { useJobLogStream } from '@/composables/useJobLogStream'
import { useInstallationsStore } from '@/stores/installations'
import type { JobRecord } from '@gravit-panel/shared'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { LoaderCircle, Trash2 } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'

const emit = defineEmits<{ removed: [] }>()
const queryClient = useQueryClient()
const { selectedInstallation, selectedInstallationId } = storeToRefs(useInstallationsStore())
const {
  activeJob: job,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => selectedInstallationId.value,
  ['docker.launcherdockered.delete'],
)

const {
  mutate: removeInstallation,
  isPending: requestPending,
  error: requestError,
} = useMutation({
  mutationFn: async (installationId: string) => {
    const response = await fetch(`/api/docker/installations/${installationId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmDeletion: true }),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null
      throw new Error(body?.message ?? `Removal request failed with status ${response.status}`)
    }
    return response.json() as Promise<JobRecord>
  },
  onSuccess: attachJob,
})
const { currentJob } = useJobLogStream(
  () => job.value,
  async (finished) => {
    await finishJob(finished)
    if (finished.status !== 'succeeded') return
    const installationId = String(
      finished.result?.installationId ?? finished.input.installationId ?? '',
    )
    if (installationId) {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey.includes(installationId),
      })
    }
    await queryClient.invalidateQueries({ queryKey: ['docker-installations'] })
    emit('removed')
  },
)
const pending = computed(
  () =>
    requestPending.value ||
    currentJob.value?.status === 'queued' ||
    currentJob.value?.status === 'running',
)
const error = computed(
  () =>
    (requestError.value as Error | null) ||
    (currentJob.value?.status === 'failed' && currentJob.value.error
      ? new Error(currentJob.value.error)
      : null),
)
const startRemoval = () => {
  if (selectedInstallation.value && !pending.value) {
    removeInstallation(selectedInstallation.value.id)
  }
}
</script>
