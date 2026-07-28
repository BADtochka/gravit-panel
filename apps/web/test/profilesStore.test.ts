import { describe, expect, test } from 'bun:test'
import type { ClientProfileDescriptor } from '@gravit-panel/shared'
import { createPinia, setActivePinia } from 'pinia'
import { reconcileProfileSelection, useProfilesStore } from '../src/stores/profiles'

const profile = (name: string): ClientProfileDescriptor => ({
  name,
  minecraftVersion: '1.21.1',
  loader: 'FABRIC',
})

describe('profile selection reconciliation', () => {
  test('preserves a selected profile that still exists', () => {
    expect(reconcileProfileSelection('beta', [profile('alpha'), profile('beta')])).toBe('beta')
  })

  test('selects the first profile when the previous selection is missing', () => {
    expect(reconcileProfileSelection('missing', [profile('alpha')])).toBe('alpha')
    expect(reconcileProfileSelection('missing', [])).toBe('')
  })

  test('keeps the selection while a server profile catalog is refreshing', () => {
    setActivePinia(createPinia())
    const store = useProfilesStore()
    store.setProfiles([profile('alpha'), profile('beta')])
    store.selectedProfileName = 'beta'

    store.clearProfileCatalog()

    expect(store.profiles).toEqual([])
    expect(store.selectedProfileName).toBe('beta')
  })
})
