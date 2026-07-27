import type { GravitInstallation } from '@gravit-panel/shared'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

const storageKey = 'gravit-panel:selected-installation'

export const reconcileInstallationSelection = (
  selectedId: string,
  installations: GravitInstallation[],
) => {
  if (installations.some((item) => item.id === selectedId)) return selectedId
  return installations[0]?.id ?? ''
}

export const useInstallationsStore = defineStore('installations', () => {
  const installations = ref<GravitInstallation[]>([])
  const selectedInstallationId = ref(
    typeof window === 'undefined' ? '' : window.localStorage.getItem(storageKey) ?? '',
  )
  const selectedInstallation = computed(
    () =>
      installations.value.find((item) => item.id === selectedInstallationId.value) ?? null,
  )

  const setInstallations = (items: GravitInstallation[]) => {
    installations.value = items
    selectedInstallationId.value = reconcileInstallationSelection(
      selectedInstallationId.value,
      items,
    )
  }

  watch(selectedInstallationId, (value) => {
    if (typeof window === 'undefined') return
    if (value) window.localStorage.setItem(storageKey, value)
    else window.localStorage.removeItem(storageKey)
  })

  return {
    installations,
    selectedInstallation,
    selectedInstallationId,
    setInstallations,
  }
})
