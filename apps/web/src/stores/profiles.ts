import type { ClientProfileDescriptor } from '@gravit-panel/shared'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const storageKey = 'gravit-panel:selected-profile'

export const reconcileProfileSelection = (
  selectedName: string,
  profiles: ClientProfileDescriptor[],
) => {
  if (profiles.some((item) => item.name === selectedName)) return selectedName
  return profiles[0]?.name ?? ''
}

export const useProfilesStore = defineStore('profiles', () => {
  const profiles = ref<ClientProfileDescriptor[]>([])
  const selectedProfileName = ref(
    typeof window === 'undefined' ? '' : window.localStorage.getItem(storageKey) ?? '',
  )

  const setProfiles = (items: ClientProfileDescriptor[]) => {
    profiles.value = items
    selectedProfileName.value = reconcileProfileSelection(selectedProfileName.value, items)
  }

  const clearProfiles = () => {
    profiles.value = []
    selectedProfileName.value = ''
  }

  const clearProfileCatalog = () => {
    profiles.value = []
  }

  watch(selectedProfileName, (value) => {
    if (typeof window === 'undefined') return
    if (value) window.localStorage.setItem(storageKey, value)
    else window.localStorage.removeItem(storageKey)
  })

  return {
    profiles,
    selectedProfileName,
    setProfiles,
    clearProfiles,
    clearProfileCatalog,
  }
})
