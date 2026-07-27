import type { JobRecord, JobType } from '@gravit-panel/shared'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, toValue, watch, type WatchSource } from 'vue'

interface ActiveJobResponse {
  job: JobRecord | null
}

const getActiveJob = async (installationId: string) => {
  const response = await fetch(
    `/api/jobs/active?installationId=${encodeURIComponent(installationId)}`,
  )
  if (!response.ok) throw new Error(`Active job request failed with status ${response.status}`)
  return response.json() as Promise<ActiveJobResponse>
}

export const useInstallationJob = (
  installationId: WatchSource<string>,
  supportedTypes: readonly JobType[],
) => {
  const queryClient = useQueryClient()
  const job = ref<JobRecord | null>(null)
  const currentInstallationId = computed(() => toValue(installationId))
  const supported = new Set<JobType>(supportedTypes)
  const queryKey = computed(() => ['active-installation-job', currentInstallationId.value])
  const { data, error, refetch } = useQuery({
    queryKey,
    queryFn: () => getActiveJob(currentInstallationId.value),
    enabled: computed(() => Boolean(currentInstallationId.value)),
    refetchInterval: 1_000,
  })

  watch(currentInstallationId, () => {
    job.value = null
  })
  watch(
    data,
    (response) => {
      const active = response?.job
      if (active && supported.has(active.type)) job.value = active
    },
    { immediate: true },
  )

  const attach = (nextJob: JobRecord) => {
    job.value = nextJob
    queryClient.setQueryData<ActiveJobResponse>(queryKey.value, { job: nextJob })
  }
  const finish = async (finishedJob: JobRecord) => {
    job.value = finishedJob
    await queryClient.invalidateQueries({ queryKey: queryKey.value })
  }

  return {
    activeJob: job,
    activeJobError: error,
    attachJob: attach,
    finishJob: finish,
    refetchActiveJob: refetch,
  }
}
