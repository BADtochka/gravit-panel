import type { ProfileServerBinding } from '@gravit-panel/shared'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const storageKey = 'gravit-panel:selected-server'

export const serverBindingKey = (binding: ProfileServerBinding) =>
  binding.id ?? `legacy:${binding.name}:${binding.serverAddress}:${binding.serverPort}`

export const useServersStore = defineStore('servers', () => {
  const bindings = ref<ProfileServerBinding[]>([])
  const selectedBindingKey = ref(
    typeof window === 'undefined' ? '' : window.localStorage.getItem(storageKey) ?? '',
  )
  const dialogAction = ref<'create' | 'edit' | null>(null)
  const requestCreate = () => { dialogAction.value = 'create' }
  const requestEdit = () => { dialogAction.value = 'edit' }
  const consumeDialogAction = () => { dialogAction.value = null }

  const setBindings = (items: ProfileServerBinding[]) => {
    bindings.value = items
    if (!items.some((binding) => serverBindingKey(binding) === selectedBindingKey.value)) {
      selectedBindingKey.value = items[0] ? serverBindingKey(items[0]) : ''
    }
  }

  const clearBindings = () => {
    bindings.value = []
    selectedBindingKey.value = ''
  }

  watch(selectedBindingKey, (value) => {
    if (typeof window === 'undefined') return
    if (value) window.localStorage.setItem(storageKey, value)
    else window.localStorage.removeItem(storageKey)
  })

  return {
    bindings, selectedBindingKey, dialogAction,
    setBindings, clearBindings, requestCreate, requestEdit, consumeDialogAction,
  }
})
