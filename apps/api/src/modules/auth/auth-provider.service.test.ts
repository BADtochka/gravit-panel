import { describe, expect, test } from 'bun:test'
import type { AuthProviderApplyInput, GravitInstallation } from '@gravit-panel/shared'
import type { ControlFileService } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import type { ModuleManagementService } from '../modules/module-management.service'
import { AuthProviderService } from './auth-provider.service'

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

describe('AuthProviderService.applyProvider', () => {
  test('writes a memory auth core after snapshot and verifies the type', async () => {
    let config = JSON.stringify({
      auth: {
        std: {
          isDefault: true,
          displayName: 'Default',
          visible: true,
          core: { type: 'reject' },
        },
      },
    })
    const written: string[] = []
    const volume = {
      readFile: async () => config,
      copy: async () => {},
      writeFileAtomic: async (_installation: GravitInstallation, path: string, bytes: Uint8Array) => {
        expect(path).toBe('LaunchServer.json')
        config = new TextDecoder().decode(bytes)
        written.push(config)
      },
    }
    const modules = { install: async () => ({} as never) } as Pick<
      ModuleManagementService,
      'install'
    >
    const service = new AuthProviderService({} as ControlFileService, volume, modules, {
      restartLaunchServer: async () => {},
    })

    const input: AuthProviderApplyInput = {
      installationId: installation.id,
      authId: 'std',
      recipeId: 'memory',
      displayName: 'Default',
      isDefault: true,
      visible: true,
      confirmConfigWrite: true,
    }
    const result = await service.applyProvider(installation, input, context())

    expect(result.coreType).toBe('memory')
    expect(result.restarted).toBe(true)
    expect(JSON.parse(written[0]!).auth.std.core.type).toBe('memory')
  })

  test('redacts SQL passwords from provider detail responses', async () => {
    const volume = {
      readFile: async () =>
        JSON.stringify({
          auth: {
            std: {
              isDefault: true,
              displayName: 'SQL',
              core: {
                type: 'sql',
                holder: {
                  driverClass: 'org.postgresql.Driver',
                  jdbcUrl: 'jdbc:postgresql://localhost:5432/db',
                  username: 'root',
                  password: 'super-secret',
                },
                passwordVerifier: { type: 'bcrypt', cost: 10 },
              },
            },
          },
        }),
      copy: async () => {},
      writeFileAtomic: async () => {},
    }
    const service = new AuthProviderService({} as ControlFileService, volume)

    const detail = await service.providerDetail(installation, 'std')

    expect(detail.sql?.holder.passwordConfigured).toBe(true)
    expect(JSON.stringify(detail)).not.toContain('super-secret')
  })
})
