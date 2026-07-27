import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import type { ControlFileService } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import type { ModuleManagementService } from '../modules/module-management.service'
import { AuthRecipeService } from './auth-recipe.service'

const installation: GravitInstallation = {
  id: '0da297da-3055-4785-aa1a-57fba3beba11',
  name: 'default',
  path: '/srv/gravit/default',
  address: 'localhost:17549',
  projectName: 'MY_PROJECT',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: '2026-07-27T12:00:00.000Z',
  updatedAt: '2026-07-27T12:00:00.000Z',
}

const context = (): JobTaskContext => ({
  signal: new AbortController().signal,
  log: () => {},
  progress: () => {},
})

describe('AuthRecipeService', () => {
  test('returns only sanitized auth provider metadata', async () => {
    const volume = {
      readFile: async () =>
        JSON.stringify({
          auth: {
            std: {
              isDefault: true,
              displayName: 'Default',
              core: { type: 'mysql', password: 'must-not-leak' },
            },
          },
        }),
      copy: async () => {},
      writeFileAtomic: async () => {},
    }
    const service = new AuthRecipeService({} as ControlFileService, volume)

    const result = await service.configuration(installation)

    expect(result.providers).toEqual([
      {
        id: 'std',
        displayName: 'Default',
        coreType: 'mysql',
        isDefault: true,
        visible: true,
      },
    ])
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(result.recipes.some((recipe) => recipe.id === 'file')).toBe(true)
    expect(result.recipes.find((recipe) => recipe.id === 'file')?.source.revision).toBe(
      'ebe98aa204c3282430cef4dd5bbb75ac1c7d3e0a',
    )
  })

  test('loads the module, snapshots LaunchServer.json, and installs file auth', async () => {
    const order: string[] = []
    let config = JSON.stringify({
      auth: {
        std: {
          isDefault: true,
          displayName: 'Default',
          core: { type: 'reject' },
        },
      },
    })
    const volume = {
      readFile: async () => config,
      copy: async (_installation: GravitInstallation, source: string, target: string) => {
        order.push(`copy:${source}:${target}`)
      },
      writeFileAtomic: async () => {},
    }
    const modules = {
      install: async () => {
        order.push('module')
        return {} as never
      },
    } as Pick<ModuleManagementService, 'install'>
    const control = {
      executeAuthCommand: async (_installation: GravitInstallation, command: string) => {
        order.push(command)
        config = JSON.stringify({
          auth: {
            std: {
              isDefault: true,
              displayName: 'Default',
              core: { type: 'fileauthsystem' },
            },
          },
        })
        return ['FileSystemAuthCoreProvider installed']
      },
    } as ControlFileService
    const service = new AuthRecipeService(control, volume, modules)

    const result = await service.installFileAuth(installation, 'std', context())

    expect(order[0]).toBe('module')
    expect(order[1]).toStartWith('copy:LaunchServer.json:LaunchServer.json.backup-')
    expect(order[2]).toBe('fileauthsystem install std')
    expect(result).toMatchObject({
      configuredAuthId: 'std',
      alreadyConfigured: false,
    })
    expect(result.configBackupPath).toContain('/launcher/LaunchServer.json.backup-')
  })

  test('is idempotent when FileAuthSystem is already configured', async () => {
    let copies = 0
    let commands = 0
    const volume = {
      readFile: async () =>
        JSON.stringify({
          auth: {
            std: {
              isDefault: true,
              core: { type: 'fileauthsystem' },
            },
          },
        }),
      copy: async () => {
        copies += 1
      },
      writeFileAtomic: async () => {},
    }
    const modules = {
      install: async () => ({} as never),
    } as Pick<ModuleManagementService, 'install'>
    const control = {
      executeAuthCommand: async () => {
        commands += 1
        return []
      },
    } as unknown as ControlFileService
    const service = new AuthRecipeService(control, volume, modules)

    const result = await service.installFileAuth(installation, 'std', context())

    expect(result.alreadyConfigured).toBe(true)
    expect(result.configBackupPath).toBeNull()
    expect(copies).toBe(0)
    expect(commands).toBe(0)
  })
})
