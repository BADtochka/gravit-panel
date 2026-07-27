import { afterEach, describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { Database } from 'bun:sqlite'
import { Elysia } from 'elysia'
import { schema } from '../../db/schema'
import { JobsEventHub } from '../jobs/jobs.events'
import { JobsRunner } from '../jobs/jobs.runner'
import { JobsStore } from '../jobs/jobs.store'
import type { ModuleManagementService } from './module-management.service'
import { createModulesRoutes } from './modules.routes'

const databases: Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

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

const createHarness = (
  management: Pick<ModuleManagementService, 'getState' | 'install' | 'remove'>,
) => {
  const database = new Database(':memory:')
  databases.push(database)
  database.exec(schema)
  const jobsStore = new JobsStore(database)
  const jobs = new JobsRunner(jobsStore, new JobsEventHub())
  const activeJob = (id: string) =>
    jobsStore
      .listByStatuses(['queued', 'running'])
      .find((job) => job.input.installationId === id)
  const app = new Elysia({ prefix: '/api' }).use(
    createModulesRoutes({
      installations: {
        get: (id) => id === installation.id ? installation : null,
      },
      jobs,
      jobsStore,
      activeJob,
      management,
    }),
  )

  return {
    request: (path: string, init?: RequestInit) =>
      app.handle(new Request(`http://127.0.0.1${path}`, init)),
    jobsStore,
  }
}

const waitForTerminalJob = async (store: JobsStore, id: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = store.get(id)
    if (job?.status === 'succeeded' || job?.status === 'failed') return job
    await Bun.sleep(5)
  }
  throw new Error(`Job ${id} did not finish`)
}

const installRequest = (moduleId = 'MirrorHelper_module') => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ installationId: installation.id, moduleId }),
})

const removeRequest = (moduleId = 'MirrorHelper_module') => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ installationId: installation.id, moduleId, confirmRemove: true }),
})

describe('module installation API', () => {
  test('reports state and completes one verified module install job', async () => {
    let calls = 0
    const management = {
      getState: async () => [
        {
          id: 'MirrorHelper_module',
          available: true,
          built: false,
          loaded: false,
          pendingJobId: null,
        },
      ],
      install: async () => {
        calls += 1
        return {
          installationId: installation.id,
          moduleId: 'MirrorHelper_module',
          moduleName: 'MirrorHelper',
          kind: 'server' as const,
          command: 'modules load MirrorHelper' as const,
          alreadyLoaded: false,
          sourceRevision: 'ebe98aa204c3282430cef4dd5bbb75ac1c7d3e0a',
          releaseTag: 'v5.7.9',
        }
      },
      remove: async () => ({
        installationId: installation.id,
        moduleId: 'MirrorHelper_module',
        moduleName: 'MirrorHelper',
        jar: 'MirrorHelper_module.jar',
        restarted: true as const,
      }),
    }
    const { request, jobsStore } = createHarness(management)

    const state = await request(
      `/api/modules/state?installationId=${installation.id}`,
    )
    const response = await request('/api/modules/install', installRequest())
    const queued = await response.json()
    const completed = await waitForTerminalJob(jobsStore, queued.id)

    expect(state.status).toBe(200)
    expect((await state.json()).items).toEqual([
      expect.objectContaining({ id: 'MirrorHelper_module', available: true }),
    ])
    expect(response.status).toBe(202)
    expect(completed).toMatchObject({
      status: 'succeeded',
      result: {
        installationId: installation.id,
        moduleId: 'MirrorHelper_module',
      },
    })
    expect(calls).toBe(1)
  })

  test('rejects duplicate, unknown module, and unknown installation requests', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const management = {
      getState: async () => [],
      install: async () => {
        await gate
        return {
          installationId: installation.id,
          moduleId: 'MirrorHelper_module',
        } as never
      },
      remove: async () => ({}) as never,
    }
    const { request, jobsStore } = createHarness(management)
    const first = await request('/api/modules/install', installRequest())
    const firstJob = await first.json()
    const duplicate = await request('/api/modules/install', installRequest())
    const unknownModule = await request(
      '/api/modules/install',
      installRequest('Missing_module'),
    )
    const unknownInstallation = await request('/api/modules/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: crypto.randomUUID(),
        moduleId: 'MirrorHelper_module',
      }),
    })

    expect(first.status).toBe(202)
    expect(duplicate.status).toBe(409)
    expect(unknownModule.status).toBe(404)
    expect(unknownInstallation.status).toBe(404)

    release?.()
    expect((await waitForTerminalJob(jobsStore, firstJob.id)).status).toBe('succeeded')
  })

  test('queues a confirmed module removal job', async () => {
    let removed = 0
    const management = {
      getState: async () => [],
      install: async () => ({}) as never,
      remove: async () => {
        removed += 1
        return {
          installationId: installation.id,
          moduleId: 'MirrorHelper_module',
          moduleName: 'MirrorHelper',
          jar: 'MirrorHelper_module.jar',
          restarted: true as const,
        }
      },
    }
    const { request, jobsStore } = createHarness(management)

    const response = await request('/api/modules/remove', removeRequest())
    const queued = await response.json()
    const completed = await waitForTerminalJob(jobsStore, queued.id)

    expect(response.status).toBe(202)
    expect(completed).toMatchObject({
      status: 'succeeded',
      result: { moduleId: 'MirrorHelper_module', restarted: true },
    })
    expect(removed).toBe(1)
  })
})
