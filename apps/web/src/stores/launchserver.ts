import type { GravitInstallation } from '@gravit-panel/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useLaunchServerStore = defineStore('launchserver', () => {
  const launchServer = ref<GravitInstallation | null>(null)
  const launchServerId = computed(() => launchServer.value?.id ?? '')

  const setLaunchServer = (item: GravitInstallation | null) => {
    launchServer.value = item
  }

  return {
    launchServer,
    launchServerId,
    setLaunchServer,
  }
})
