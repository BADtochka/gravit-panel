import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schema } from '../../db/schema'
import { InstallationsStore } from './installations.store'

describe('InstallationsStore', () => {
  test('persists source metadata and updates an installation by canonical path', () => {
    const database = new Database(':memory:')
    database.exec(schema)
    const store = new InstallationsStore(database)

    const first = store.upsert('primary', {
      installationPath: '/srv/launcher',
      mode: 'clone',
      address: 'localhost:17549',
      projectName: 'PRIMARY',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      environmentBackupPath: null,
    })
    const updated = store.upsert('primary-renamed', {
      installationPath: '/srv/launcher',
      mode: 'import',
      address: 'launcher.example.com',
      projectName: 'RENAMED',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: 'fef9bae63da1afc0518d32e3333db20f409ab196',
      environmentBackupPath: '/srv/launcher/.env.backup',
    })

    expect(updated.id).toBe(first.id)
    expect(store.list()).toEqual([
      expect.objectContaining({
        id: first.id,
        name: 'primary-renamed',
        path: '/srv/launcher',
        address: 'launcher.example.com',
        projectName: 'RENAMED',
        sourceRevision: 'fef9bae63da1afc0518d32e3333db20f409ab196',
      }),
    ])
    expect(store.delete(first.id)).toBe(true)
    expect(store.delete(first.id)).toBe(false)
    expect(store.list()).toEqual([])
    database.close()
  })
})
