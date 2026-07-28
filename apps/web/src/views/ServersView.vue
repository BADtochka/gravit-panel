<template>
  <section class="space-y-6">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">Servers</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Bind game servers, install ServerWrapper, and manage per-server file packs.
      </p>
    </div>

    <Alert v-if="pageError" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Server operation failed</AlertTitle>
      <AlertDescription>{{ pageError.message }}</AlertDescription>
    </Alert>

    <Card v-if="!selectedProfile">
      <CardHeader>
        <CardTitle class="text-base">No client profile selected</CardTitle>
        <CardDescription>
          Create or select a profile from the sidebar before attaching game servers.
        </CardDescription>
      </CardHeader>
    </Card>

    <ProfileServersCard
      v-else
      :disabled="operationPending"
      :installation-id="installationId"
      :profile="selectedProfile"
      @job="attachJob"
    />

    <JobLogCard :job="activeJob" title="Server operation" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import ProfileServersCard from '@/components/clients/ProfileServersCard.vue'
import JobLogCard from '@/components/jobs/JobLogCard.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useClientProfiles } from '@/composables/useClientProfiles'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { useLaunchServerStore } from '@/stores/launchserver'
import { useProfilesStore } from '@/stores/profiles'
import type { JobRecord } from '@gravit-panel/shared'
import { useQueryClient } from '@tanstack/vue-query'
import { TriangleAlert } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'

const queryClient = useQueryClient()
const { launchServerId: installationId } = storeToRefs(useLaunchServerStore())
const { selectedProfileName } = storeToRefs(useProfilesStore())
const { data: profiles, error: profilesError } = useClientProfiles()
const selectedProfile = computed(
  () => profiles.value?.items.find((item) => item.name === selectedProfileName.value) ?? null,
)
const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => installationId.value,
  [
    'gravit.server.binding.apply',
    'gravit.server.binding.remove',
    'gravit.server-pack.modify',
    'gravit.server-pack.publish',
    'gravit.server-bootstrap.prepare',
  ],
)
const operationPending = computed(
  () => activeJob.value?.status === 'queued' || activeJob.value?.status === 'running',
)
const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: ['server-bindings', installationId.value, selectedProfileName.value],
    }),
    queryClient.invalidateQueries({ queryKey: ['server-pack'] }),
    queryClient.invalidateQueries({ queryKey: ['server-bootstrap'] }),
    queryClient.invalidateQueries({
      queryKey: ['client-profiles', installationId.value],
    }),
  ])
}
const pageError = computed(
  () => (profilesError.value || activeJobError.value) as Error | null,
)
</script>
