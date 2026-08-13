import { panelFetch } from '@/lib/public-path'
import { useLaunchServerStore } from '@/stores/launchserver'
import { useProfilesStore } from '@/stores/profiles'
import { useServersStore } from '@/stores/servers'
import type { ProfileServerBinding } from '@gravit-panel/shared'
import { useQuery } from '@tanstack/vue-query'
import { storeToRefs } from 'pinia'
import { computed, watch } from 'vue'

export const useServerBindings = () => {
  const { launchServerId } = storeToRefs(useLaunchServerStore())
  const { selectedProfileName } = storeToRefs(useProfilesStore())
  const store = useServersStore()
  const query = useQuery({
    queryKey: computed(() => ['server-bindings', launchServerId.value, selectedProfileName.value]),
    queryFn: async () => {
      const response = await panelFetch(`/api/servers/profiles/${encodeURIComponent(selectedProfileName.value)}/bindings?installationId=${encodeURIComponent(launchServerId.value)}`)
      if (!response.ok) throw new Error(`Server bindings request failed with status ${response.status}`)
      return response.json() as Promise<{ items: ProfileServerBinding[] }>
    },
    enabled: computed(() => Boolean(launchServerId.value && selectedProfileName.value)),
  })
  watch(() => query.data.value?.items, (items) => {
    if (items) store.setBindings(items)
  }, { immediate: true })
  watch([launchServerId, selectedProfileName], () => {
    if (!launchServerId.value || !selectedProfileName.value) store.clearBindings()
  })
  return query
}
