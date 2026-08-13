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
  const createRequestedAt = ref(0)
  const requestCreate = () => { createRequestedAt.value = Date.now() }
  const consumeCreateRequest = () => { createRequestedAt.value = 0 }

  const setProfiles = (items: ClientProfileDescriptor[]) => {
    const uniqueItems = [...new Map(items.map((item) => [item.name, item])).values()]
    profiles.value = uniqueItems
    selectedProfileName.value = reconcileProfileSelection(
      selectedProfileName.value,
      uniqueItems,
    )
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
    createRequestedAt,
    requestCreate,
    consumeCreateRequest,
    setProfiles,
    clearProfiles,
    clearProfileCatalog,
  }
})
