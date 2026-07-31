import { describe, expect, test } from 'bun:test'
import type { GravitInstallation, LaunchServerCommandResult } from '@gravit-panel/shared'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { LaunchServerOperationsService } from './launchserver-operations.service'

const installation = {
  id: crypto.randomUUID(),
  name: 'default',
  path: '/srv/gravit/default',
  address: 'localhost:17549',
  projectName: 'TEST',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} satisfies GravitInstallation

const createContext = () => {
  const logs: string[] = []
  const progress: string[] = []
  return {
    logs,
    progress,
    context: {
      signal: new AbortController().signal,
      log: (message) => logs.push(message),
      progress: (_value, message) => progress.push(message),
    } satisfies JobTaskContext,
  }
}

const commandResult: LaunchServerCommandResult = {
  installationId: installation.id,
  command: 'serverStatus',
  transport: 'remote-control',
  lines: ['Server is running'],
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  source: { repository: 'repo', revision: 'revision', file: 'file' },
}

describe('LaunchServerOperationsService', () => {
  test('writes inspection output into job logs', async () => {
    const { context, logs } = createContext()
    const service = new LaunchServerOperationsService(
      { execute: async () => commandResult },
      { syncProfileProvider: async () => [] },
    )

    expect(await service.inspect(installation, 'serverStatus', context)).toEqual(commandResult)
    expect(logs).toEqual(['Transport: remote-control', 'Server is running'])
  })

  test('synchronizes profiles through the native command without restarting', async () => {
    const { context, logs } = createContext()
    const service = new LaunchServerOperationsService(
      { execute: async () => commandResult },
      { syncProfileProvider: async () => ['Profiles and updates synced'] },
    )
    const result = await service.syncProfiles(installation, context)
    expect(result).toMatchObject({ synchronized: true, lines: ['Profiles and updates synced'] })
    expect(logs).toEqual(['Profiles and updates synced'])
  })
})
