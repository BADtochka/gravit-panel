import { describe, expect, test } from 'bun:test'
import type { GravitInstallation, JobRecord } from '@gravit-panel/shared'
import type { ModuleControlCommand } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { findCatalogModule } from './module-catalog'
import { ModuleManagementService } from './module-management.service'

const installation: GravitInstallation = {
  id: '95c85155-8abc-4e96-8835-9ce6cb9d5345',
  name: 'test',
  path: '/srv/LauncherDockered',
  address: 'localhost:17549',
  projectName: 'TEST',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
}

const context: JobTaskContext = {
  signal: new AbortController().signal,
  log: () => {},
  progress: () => {},
}

describe('ModuleManagementService', () => {
  test('loads a source-verified server module and verifies the resulting state', async () => {
    const commands: ModuleControlCommand[] = []
    let loaded = false
    const service = new ModuleManagementService({
      executeModuleCommand: async (_installation, command) => {
        commands.push(command)
        if (command === 'modules available') {
          return ['Found LaunchServer module \tMirrorHelper']
        }
        if (command === 'modules load MirrorHelper') {
          loaded = true
          return ['Module MirrorHelper loaded']
        }
        return loaded ? ['[MODULE] MirrorHelper v: 1.0'] : ['[MODULE] LaunchServerCore']
      },
    })
    const item = findCatalogModule('MirrorHelper_module')
    if (!item) throw new Error('Fixture module is missing')

    const result = await service.install(installation, item, context)

    expect(result).toMatchObject({
      moduleId: 'MirrorHelper_module',
      kind: 'server',
      command: 'modules load MirrorHelper',
      alreadyLoaded: false,
      releaseTag: 'v5.7.9',
    })
    expect(commands).toEqual([
      'modules available',
      'modules list',
      'modules load MirrorHelper',
      'modules list',
    ])
  })

  test('uses launcher-load and exposes an active job as pending state', async () => {
    const commands: ModuleControlCommand[] = []
    const service = new ModuleManagementService({
      executeModuleCommand: async (_installation, command) => {
        commands.push(command)
        if (command === 'modules available') {
          return ['Found launcher module \tDiscordGame']
        }
        if (command === 'modules launcher-load DiscordGame') {
          return ['Launcher module DiscordGame_lmodule.jar loaded']
        }
        return commands.includes('modules launcher-load DiscordGame')
          ? ['[LAUNCHER MODULE] DiscordGame_lmodule.jar sig: SUCCESS']
          : []
      },
    })
    const item = findCatalogModule('DiscordGame_lmodule')
    if (!item) throw new Error('Fixture module is missing')
    await service.install(installation, item, context)

    const pendingJob = {
      id: 'pending-job',
      type: 'gravit.module.install',
      status: 'running',
      progress: 50,
      input: {
        installationId: installation.id,
        moduleId: item.id,
      },
      result: null,
      error: null,
      createdAt: '2026-07-27T00:00:00.000Z',
      startedAt: '2026-07-27T00:00:01.000Z',
      finishedAt: null,
    } satisfies JobRecord
    const state = await service.getState(installation, [pendingJob])

    expect(commands).toContain('modules launcher-load DiscordGame')
    expect(state.find((module) => module.id === item.id)).toEqual({
      id: item.id,
      available: true,
      loaded: true,
      pendingJobId: pendingJob.id,
    })
  })

  test('rejects modules that are absent from runtime discovery', async () => {
    const service = new ModuleManagementService({
      executeModuleCommand: async () => [],
    })
    const item = findCatalogModule('Prestarter_module')
    if (!item) throw new Error('Fixture module is missing')

    await expect(service.install(installation, item, context)).rejects.toThrow(
      'unsupported artifacts cannot be installed',
    )
  })

  test('does not confuse Sentry with SentryProGuardUpload', async () => {
    const service = new ModuleManagementService({
      executeModuleCommand: async (_installation, command) =>
        command === 'modules available'
          ? [
              'Found LaunchServer module \tSentry',
              'Found LaunchServer module \tSentryProGuardUpload',
            ]
          : ['[MODULE] SentryProGuardUpload v: 1.0'],
    })

    const state = await service.getState(installation)

    expect(state.find((module) => module.id === 'Sentry_module')).toMatchObject({
      available: true,
      loaded: false,
    })
    expect(state.find((module) => module.id === 'SentryProGuardUpload_module')).toMatchObject({
      available: true,
      loaded: true,
    })
  })
})
