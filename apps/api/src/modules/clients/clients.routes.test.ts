import { afterEach, describe, expect, test } from 'bun:test'
import type {
  GravitInstallation,
  LaunchServerRuntimeHealth,
  WorkspaceApplyResult,
} from '@gravit-panel/shared'
import { Database } from 'bun:sqlite'
import { Elysia } from 'elysia'
import { schema } from '../../db/schema'
import { JobsEventHub } from '../jobs/jobs.events'
import { JobsRunner } from '../jobs/jobs.runner'
import { JobsStore } from '../jobs/jobs.store'
import type { ClientBuildService } from './client-build.service'
import { createClientsRoutes } from './clients.routes'

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

const workspaceResult: WorkspaceApplyResult = {
  installationId: installation.id,
  manifestUrl: 'https://mirror.gravitlauncher.com/5.7.x/workspace.json',
  manifestSha256: '51772ff2d1f3326862ca2cfa8f6e91d3d86a0406cd65a4eb0abaa114b43b7728',
  snapshotPath: null,
  source: {
    repository: 'https://github.com/GravitLauncher/LauncherModules',
    revision: '0fcdfade1960c353a9f0bbb2f92055f05e22867d',
  },
}

const launchServerHealth: LaunchServerRuntimeHealth = {
  installationId: installation.id,
  status: 'healthy',
  checkedAt: '2026-07-27T12:00:00.000Z',
  message: 'LaunchServer control socket is ready.',
}

const createHarness = (
  overrides: Partial<ClientBuildService> = {},
  lifecycleOverrides: {
    checkLaunchServer?: () => Promise<LaunchServerRuntimeHealth>
    restartLaunchServer?: () => Promise<void>
  } = {},
) => {
  const database = new Database(':memory:')
  databases.push(database)
  database.exec(schema)
  const store = new JobsStore(database)
  const runner = new JobsRunner(store, new JobsEventHub())
  const service = {
    compatibility: () => ({}),
    preparationState: async () => ({
      installationId: installation.id,
      workspaceApplied: true,
      prestarterInstalled: true,
      launcherBuilt: true,
    }),
    profileState: async (_installation: GravitInstallation, name: string) => ({
      installationId: installation.id,
      name,
      built: name === 'main',
    }),
    listProfiles: async () => ({
      items: [
        {
          name: 'main',
          uuid: '65f6ac32-f8d2-4c63-8ebb-733e50d613d5',
          title: 'Main',
          description: 'Primary profile',
          sortIndex: 0,
          minecraftVersion: '1.21.1',
          loader: 'NEOFORGE',
        },
      ],
    }),
    updateProfile: async () => ({}),
    removeProfile: async () => ({}),
    listLauncherArtifacts: async () => [],
    artifactPath: async () => null,
    customizationState: async () => ({
      installationId: installation.id,
      customized: false,
      assets: [],
      source: {
        repository: 'https://github.com/GravitLauncher/LauncherRuntime',
        revision: '755e5509b1f573817a977b4180a2f84517619025',
      },
    }),
    customizeLauncher: async () => ({}),
    applyWorkspace: async () => workspaceResult,
    installPrestarter: async () => ({}),
    buildLauncher: async () => ({}),
    buildClient: async () => ({}),
    ...overrides,
  } as unknown as ClientBuildService
  const app = new Elysia({ prefix: '/api' }).use(
    createClientsRoutes({
      service,
      lifecycle: {
        checkLaunchServer: lifecycleOverrides.checkLaunchServer ?? (async () => launchServerHealth),
        restartLaunchServer: lifecycleOverrides.restartLaunchServer ?? (async () => {}),
      },
      versions: {
        list: async () => ({
          items: [
            { id: '1.21.4', releaseTime: '2024-12-03T10:00:00.000Z' },
            { id: '1.21.1', releaseTime: '2024-08-08T10:00:00.000Z' },
          ],
          latestRelease: '1.21.4',
          source: {
            manifestUrl: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
            fetchedAt: '2026-07-27T12:00:00.000Z',
          },
        }),
      },
      installations: {
        get: (id) => id === installation.id ? installation : null,
      },
      jobs: runner,
      activeJob: (id) =>
        store
          .listByStatuses(['queued', 'running'])
          .find((job) => job.input.installationId === id),
    }),
  )

  return {
    request: (path: string, init?: RequestInit) =>
      app.handle(new Request(`http://127.0.0.1${path}`, init)),
    store,
  }
}

const workspaceRequest = (installationId = installation.id) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ installationId, confirmDestructive: true }),
})

const waitForTerminalJob = async (store: JobsStore, id: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = store.get(id)
    if (job?.status === 'succeeded' || job?.status === 'failed') return job
    await Bun.sleep(5)
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('clients workspace API', () => {
  test('reports LaunchServer health and queues a restart through the lifecycle service', async () => {
    let restarts = 0
    const { request, store } = createHarness({}, {
      restartLaunchServer: async () => { restarts += 1 },
    })

    const health = await request(`/api/clients/launcher/health?installationId=${installation.id}`)
    const restart = await request('/api/clients/launcher/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: installation.id }),
    })
    const queued = await restart.json()
    const completed = await waitForTerminalJob(store, queued.id)

    expect(health.status).toBe(200)
    expect(await health.json()).toEqual(launchServerHealth)
    expect(restart.status).toBe(202)
    expect(queued).toMatchObject({ type: 'gravit.launchserver.restart' })
    expect(completed).toMatchObject({
      status: 'succeeded',
      result: { installationId: installation.id, restarted: true },
    })
    expect(restarts).toBe(1)
  })

  test('reports preparation completion for the selected installation', async () => {
    const { request } = createHarness()
    const response = await request(`/api/clients/state?installationId=${installation.id}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      installationId: installation.id,
      workspaceApplied: true,
      prestarterInstalled: true,
      launcherBuilt: true,
    })
  })

  test('reports whether a named client profile has complete outputs', async () => {
    const { request } = createHarness()
    const response = await request(
      `/api/clients/profile-state?installationId=${installation.id}&name=main`,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      installationId: installation.id,
      name: 'main',
      built: true,
    })
  })

  test('returns searchable Minecraft releases and detected client profile parameters', async () => {
    const { request } = createHarness()
    const [versionsResponse, profilesResponse] = await Promise.all([
      request('/api/clients/minecraft-versions'),
      request(`/api/clients/profiles?installationId=${installation.id}`),
    ])

    expect(versionsResponse.status).toBe(200)
    expect(await versionsResponse.json()).toMatchObject({
      latestRelease: '1.21.4',
      items: [{ id: '1.21.4' }, { id: '1.21.1' }],
    })
    expect(profilesResponse.status).toBe(200)
    expect(await profilesResponse.json()).toEqual({
      items: [
        {
          name: 'main',
          uuid: '65f6ac32-f8d2-4c63-8ebb-733e50d613d5',
          title: 'Main',
          description: 'Primary profile',
          sortIndex: 0,
          minecraftVersion: '1.21.1',
          loader: 'NEOFORGE',
        },
      ],
    })
  })

  test.each([
    {
      name: 'profile metadata update',
      path: `/api/clients/profiles/main/update`,
      body: {
        installationId: installation.id,
        title: 'Main server',
        description: 'Updated description',
        sortIndex: 10,
      },
      type: 'gravit.profile.update',
      method: 'updateProfile',
    },
    {
      name: 'profile removal',
      path: `/api/clients/profiles/main/remove`,
      body: {
        installationId: installation.id,
        confirmRemove: true,
      },
      type: 'gravit.profile.remove',
      method: 'removeProfile',
    },
  ])('queues and completes $name', async ({ path, body, type, method }) => {
    let receivedName = ''
    const { request, store } = createHarness({
      [method]: async (_installation: GravitInstallation, input: { name: string }) => {
        receivedName = input.name
        return { installationId: installation.id, name: input.name }
      },
    } as Partial<ClientBuildService>)

    const response = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const queued = await response.json()
    const completed = await waitForTerminalJob(store, queued.id)

    expect(response.status).toBe(202)
    expect(queued.type).toBe(type)
    expect(receivedName).toBe('main')
    expect(completed.status).toBe('succeeded')
  })

  test('returns customization state and queues a PNG customization rebuild', async () => {
    let receivedLogo: Uint8Array | undefined
    const { request, store } = createHarness({
      customizeLauncher: async (_installation, files) => {
        receivedLogo = files.logo
        return {
          installationId: installation.id,
          customized: true,
          assets: [],
          backups: [],
          build: {},
          source: {
            repository: 'https://github.com/GravitLauncher/LauncherRuntime',
            revision: '755e5509b1f573817a977b4180a2f84517619025',
          },
        } as never
      },
    })
    const stateResponse = await request(
      `/api/clients/launcher/customization?installationId=${installation.id}`,
    )
    const body = new FormData()
    body.append('installationId', installation.id)
    body.append(
      'logo',
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        'logo.png',
        { type: 'image/png' },
      ),
    )
    const response = await request('/api/clients/launcher/customization', {
      method: 'POST',
      body,
    })
    const queued = await response.json()
    if (!queued.id) {
      throw new Error(`Customization response ${response.status}: ${JSON.stringify(queued)}`)
    }
    const completed = await waitForTerminalJob(store, queued.id)

    expect(stateResponse.status).toBe(200)
    expect(await stateResponse.json()).toMatchObject({ customized: false })
    expect(response.status).toBe(202)
    expect(queued).toMatchObject({ type: 'gravit.launcher.customize' })
    expect(completed.status).toBe('succeeded')
    expect(receivedLogo?.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  })
  test('queues one workspace job and rejects a duplicate while it is active', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const { request, store } = createHarness({
      applyWorkspace: async () => {
        calls += 1
        await gate
        return workspaceResult
      },
    })

    const first = await request('/api/clients/workspace/apply', workspaceRequest())
    const firstJob = await first.json()
    const duplicate = await request('/api/clients/workspace/apply', workspaceRequest())
    const duplicateBody = await duplicate.json()

    expect(first.status).toBe(202)
    expect(firstJob).toMatchObject({
      type: 'gravit.workspace.apply',
      status: 'queued',
    })
    expect(duplicate.status).toBe(409)
    expect(duplicateBody).toMatchObject({
      message: 'Another client operation is active.',
      jobId: firstJob.id,
    })

    release?.()
    const completed = await waitForTerminalJob(store, firstJob.id)
    expect(completed).toMatchObject({
      status: 'succeeded',
      progress: 100,
      result: workspaceResult,
    })
    expect(calls).toBe(1)
  })

  test('persists a workspace failure as a terminal job without requeueing it', async () => {
    let calls = 0
    const { request, store } = createHarness({
      applyWorkspace: async () => {
        calls += 1
        throw new Error('LaunchServer rejected command "applyworkspace": Error when execute command')
      },
    })

    const response = await request('/api/clients/workspace/apply', workspaceRequest())
    const queued = await response.json()
    const failed = await waitForTerminalJob(store, queued.id)

    expect(response.status).toBe(202)
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'LaunchServer rejected command "applyworkspace": Error when execute command',
    })
    expect(store.listEvents(queued.id).map((event) => event.type)).toEqual([
      'queued',
      'started',
      'failed',
    ])
    expect(calls).toBe(1)
  })

  test('validates confirmation and installation identity before queueing', async () => {
    const { request, store } = createHarness()
    const invalidConfirmation = await request('/api/clients/workspace/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: installation.id,
        confirmDestructive: false,
      }),
    })
    const unknownInstallation = await request(
      '/api/clients/workspace/apply',
      workspaceRequest(crypto.randomUUID()),
    )

    expect(invalidConfirmation.status).toBe(422)
    expect(unknownInstallation.status).toBe(404)
    expect(store.list()).toHaveLength(0)
  })

  test.each([
    {
      name: 'Prestarter install',
      path: '/api/clients/prestarter/install',
      body: {
        installationId: installation.id,
        confirmInstallation: true,
      },
      type: 'gravit.prestarter.install',
      method: 'installPrestarter',
    },
    {
      name: 'launcher build',
      path: '/api/clients/launcher/build',
      body: { installationId: installation.id },
      type: 'gravit.launcher.build',
      method: 'buildLauncher',
    },
    {
      name: 'client build',
      path: '/api/clients/build',
      body: {
        installationId: installation.id,
        name: 'fabric-1214',
        minecraftVersion: '1.21.4',
        loader: 'FABRIC',
        mods: ['fabric-api'],
      },
      type: 'gravit.client.build',
      method: 'buildClient',
    },
  ])('queues and completes $name through the API', async ({ path, body, type, method }) => {
    let calls = 0
    const operation = async () => {
      calls += 1
      return { installationId: installation.id, operation: method }
    }
    const { request, store } = createHarness({
      [method]: operation,
    } as Partial<ClientBuildService>)

    const response = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const queued = await response.json()
    const completed = await waitForTerminalJob(store, queued.id)

    expect(response.status).toBe(202)
    expect(queued.type).toBe(type)
    expect(completed).toMatchObject({
      status: 'succeeded',
      result: { installationId: installation.id, operation: method },
    })
    expect(calls).toBe(1)
  })
})
