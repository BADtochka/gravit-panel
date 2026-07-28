import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { createPinia, setActivePinia } from 'pinia'
import { useLaunchServerStore } from '../src/stores/launchserver'

const installation = (id: string): GravitInstallation => ({
  id,
  name: id,
  path: `/srv/${id}`,
  address: 'localhost:17549',
  projectName: id.toUpperCase(),
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: '2026-07-27T12:00:00.000Z',
  updatedAt: '2026-07-27T12:00:00.000Z',
})

describe('LaunchServer singleton resolution', () => {
  test('stores one server and derives its technical id', () => {
    setActivePinia(createPinia())
    const store = useLaunchServerStore()

    store.setLaunchServer(installation('primary'))
    expect(store.launchServer?.id).toBe('primary')
    expect(store.launchServerId).toBe('primary')

    store.setLaunchServer(null)
    expect(store.launchServer).toBeNull()
    expect(store.launchServerId).toBe('')
  })
})
