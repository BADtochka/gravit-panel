<template>
  <section class="mx-auto max-w-[100rem] space-y-6 p-4 sm:p-6">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">LaunchServer Files</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Browse and edit the live LaunchServer data volume. Protected credentials and runtime files are hidden.
      </p>
    </div>
    <ServerFilesCard
      v-if="launchServerId"
      :installation-id="launchServerId"
      server-name="LaunchServer"
      endpoint-base="/api/gravit/files"
      title="LaunchServer data files"
      root-label="LaunchServer"
      :disabled="Boolean(activeJob && ['queued', 'running'].includes(activeJob.status))"
      :finished-job="finishedJob"
      @job="attachJob"
    />
    <JobProgressNotifier :job="activeJob" title="LaunchServer file operation" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import ServerFilesCard from '@/components/clients/ServerFilesCard.vue'
import JobProgressNotifier from '@/components/jobs/JobProgressNotifier.vue'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { useLaunchServerStore } from '@/stores/launchserver'
import type { JobRecord } from '@gravit-panel/shared'
import { useQueryClient } from '@tanstack/vue-query'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'

const { launchServerId } = storeToRefs(useLaunchServerStore())
const queryClient = useQueryClient()
const finishedJob = ref<JobRecord | null>(null)
const { activeJob, attachJob, finishJob } = useInstallationJob(
  () => launchServerId.value,
  ['gravit.launchserver.files.modify'],
)
const jobFinished = async (job: JobRecord) => {
  finishedJob.value = job
  await finishJob(job)
  if (job.status === 'succeeded') await queryClient.invalidateQueries({ queryKey: ['live-files'] })
}
</script>
