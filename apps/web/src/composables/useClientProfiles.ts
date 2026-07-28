import { useLaunchServerStore } from '@/stores/launchserver'
import { useProfilesStore } from '@/stores/profiles'
import type { ClientProfileDescriptor } from '@gravit-panel/shared'
import { useQuery } from '@tanstack/vue-query'
import { storeToRefs } from 'pinia'
import { computed, watch } from 'vue'

const getJson = async <T>(input: RequestInfo | URL): Promise<T> => {
  const response = await fetch(input)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

// Shared client-profile catalog for the single managed LaunchServer. Every
// consumer (sidebar switcher, Mods, Clients) subscribes to the same query key,
// and the global profile selection is reconciled whenever the catalog loads.
export const useClientProfiles = () => {
  const { launchServerId: installationId } = storeToRefs(useLaunchServerStore())
  const profilesStore = useProfilesStore()

  const query = useQuery({
    queryKey: computed(() => ['client-profiles', installationId.value]),
    queryFn: () =>
      getJson<{ items: ClientProfileDescriptor[] }>(
        `/api/clients/profiles?installationId=${encodeURIComponent(installationId.value)}`,
      ),
    enabled: computed(() => Boolean(installationId.value)),
    retry: false,
  })

  watch(
    installationId,
    (id) => {
      if (id) profilesStore.clearProfileCatalog()
      else profilesStore.clearProfiles()
    },
    { immediate: true },
  )
  watch(
    () => query.data.value?.items,
    (items) => {
      if (items) profilesStore.setProfiles(items)
    },
    { immediate: true },
  )

  return query
}
