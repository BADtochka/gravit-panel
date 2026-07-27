import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { ProfileProvisioningService } from './profile-provisioning.service'

const installation: GravitInstallation = {
  id: '0da297da-3055-4785-aa1a-57fba3beba11',
  name: 'default',
  path: '/srv/gravit/default',
  address: 'launcher.example.com:17549',
  projectName: 'MY_PROJECT',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: '2026-07-27T12:00:00.000Z',
  updatedAt: '2026-07-27T12:00:00.000Z',
}

describe('ProfileProvisioningService', () => {
  test('generates encryption and prepares all required integrations in order', async () => {
    const order: string[] = []
    const progress: number[] = []
    let configured = false
    const service = new ProfileProvisioningService(
      {
        get status() {
          return {
            configured,
            source: configured ? 'generated' as const : null,
            canGenerate: !configured,
          }
        },
        generate: async () => {
          configured = true
          order.push('encryption')
          return { configured: true, source: 'generated', canGenerate: false }
        },
      },
      { hasEncryptedCredentials: () => false },
      {
        setup: async (_installation, input, context) => {
          order.push('remote-control')
          expect(input).toEqual({
            installationId: installation.id,
            endpoint: 'http://launcher.example.com:17549',
            replaceExistingTokens: true,
          })
          context.progress(100, 'RemoteControl ready')
          return { step: 'remote-control' } as never
        },
      },
      {
        applyWorkspace: async (_installation, context) => {
          order.push('mirror-helper')
          context.progress(100, 'Workspace ready')
          return { step: 'mirror-helper' } as never
        },
        installPrestarter: async (_installation, context) => {
          order.push('prestarter')
          context.progress(100, 'Prestarter ready')
          return { step: 'prestarter' } as never
        },
      },
    )
    const context: JobTaskContext = {
      signal: new AbortController().signal,
      log: () => {},
      progress: (value) => progress.push(value),
    }

    await service.prepare(installation, context)

    expect(order).toEqual([
      'encryption',
      'remote-control',
      'mirror-helper',
      'prestarter',
    ])
    expect(progress).toEqual([2, 40, 75, 100])
  })

  test('refuses key replacement when encrypted credentials already exist', async () => {
    const service = new ProfileProvisioningService(
      {
        status: { configured: false, source: null, canGenerate: true },
        generate: async () => {
          throw new Error('must not generate')
        },
      },
      { hasEncryptedCredentials: () => true },
      { setup: async () => ({}) as never },
      {
        applyWorkspace: async () => ({}) as never,
        installPrestarter: async () => ({}) as never,
      },
    )

    await expect(service.prepare(installation, {
      signal: new AbortController().signal,
      log: () => {},
      progress: () => {},
    })).rejects.toThrow('Restore the original encryption key')
  })
})
