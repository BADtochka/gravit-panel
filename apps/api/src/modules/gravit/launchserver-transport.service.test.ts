import { describe, expect, test } from 'bun:test'
import type {
  GravitInstallation,
  LaunchServerCommandResult,
} from '@gravit-panel/shared'
import { LaunchServerTransportService } from './launchserver-transport.service'

const installation: GravitInstallation = {
  id: crypto.randomUUID(),
  name: 'test',
  path: '/srv/test',
  address: 'localhost:17549',
  projectName: 'TEST',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const controlResult: LaunchServerCommandResult = {
  installationId: installation.id,
  command: 'serverStatus',
  transport: 'control-file',
  lines: ['fallback output'],
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  source: {
    repository: 'https://github.com/GravitLauncher/Launcher',
    revision: 'fef9bae63da1afc0518d32e3333db20f409ab196',
    file: 'SocketCommandServer.java',
  },
}

describe('LaunchServerTransportService', () => {
  test('falls back to control-file and redacts a token from HTTP errors', async () => {
    const token = 'super-secret-token'
    const service = new LaunchServerTransportService(
      { execute: async () => controlResult },
      {
        execute: async () => {
          throw new Error(`Request with token=${token} failed`)
        },
      },
      {
        get: () => ({
          installationId: installation.id,
          endpoint: 'http://localhost:17549',
          token,
          sourceRevision: 'source',
          configuredAt: new Date().toISOString(),
        }),
      },
    )

    const result = await service.execute(installation, 'serverStatus')

    expect(result.transport).toBe('control-file')
    expect(result.fallbackReason).toContain('[redacted]')
    expect(result.fallbackReason).not.toContain(token)
  })

  test('falls back when an encrypted credential cannot be read', async () => {
    const service = new LaunchServerTransportService(
      { execute: async () => controlResult },
      { execute: async () => controlResult },
      {
        get: () => {
          throw new Error('Credential authentication failed')
        },
      },
    )

    const result = await service.execute(installation, 'serverStatus')
    expect(result).toMatchObject({
      transport: 'control-file',
      fallbackReason: 'Credential authentication failed',
    })
  })
})
