import { describe, expect, test } from 'bun:test'
import type { GravitInstallation, LaunchServerRuntimeHealth } from '@gravit-panel/shared'
import { LaunchServerStartupService } from './launchserver-startup.service'

const installation: GravitInstallation = {
  id: '0da297da-3055-4785-aa1a-57fba3beba11',
  name: 'default',
  path: '/srv/gravit/default',
  address: 'localhost:17549',
  projectName: 'DEFAULT',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: '2026-07-27T12:00:00.000Z',
  updatedAt: '2026-07-27T12:00:00.000Z',
}

const health = (status: LaunchServerRuntimeHealth['status']): LaunchServerRuntimeHealth => ({
  installationId: installation.id,
  status,
  checkedAt: '2026-07-27T12:00:00.000Z',
  message: status === 'healthy' ? 'ready' : 'not ready',
})

describe('LaunchServerStartupService', () => {
  test('restarts only installations that fail the startup health check', async () => {
    let restarts = 0
    const service = new LaunchServerStartupService(
      { list: () => [installation] },
      {
        checkLaunchServer: async () => health('unhealthy'),
        restartLaunchServer: async () => { restarts += 1 },
      },
    )

    await service.recoverUnhealthyInstallations()
    expect(restarts).toBe(1)
  })

  test('leaves healthy installations running', async () => {
    let restarts = 0
    const service = new LaunchServerStartupService(
      { list: () => [installation] },
      {
        checkLaunchServer: async () => health('healthy'),
        restartLaunchServer: async () => { restarts += 1 },
      },
    )

    await service.recoverUnhealthyInstallations()
    expect(restarts).toBe(0)
  })
})
