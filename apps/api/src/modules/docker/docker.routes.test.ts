import { afterEach, describe, expect, test } from 'bun:test'
import type {
  DockerPreflightResponse,
  LauncherDockeredInstallInput,
  LauncherDockeredInstallResult,
} from '@gravit-panel/shared'
import { Database } from 'bun:sqlite'
import { Elysia } from 'elysia'
import { schema } from '../../db/schema'
import { InstallationsStore } from '../gravit/installations.store'
import { JobsEventHub } from '../jobs/jobs.events'
import { JobsRunner } from '../jobs/jobs.runner'
import { JobsStore } from '../jobs/jobs.store'
import { createDockerRoutes } from './docker.routes'
import type { LauncherDockeredService } from './launcherdockered.service'

const databases: Database[] = []
const revision = '723203b56f8d58f2447edd20ac8a5b84a31ef816'

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const installResult = (
  input: LauncherDockeredInstallInput,
): LauncherDockeredInstallResult => ({
  installationPath: `/srv/gravit/${input.installationName}`,
  mode: input.mode,
  address: input.address,
  projectName: input.projectName,
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  environmentBackupPath: null,
})

const preflightResult: DockerPreflightResponse = {
  ready: true,
  checkedAt: '2026-07-27T12:00:00.000Z',
  port: 17_549,
  checks: [],
  source: {
    repository: 'https://github.com/GravitLauncher/LauncherDockered',
    revision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
    file: 'docker-compose.yml',
  },
}

const createHarness = (
  install: LauncherDockeredService['install'],
  removeInstallation: LauncherDockeredService['removeInstallation'] = async (installation) => ({
    installationId: installation.id,
    installationPath: installation.path,
    composeResourcesRemoved: true,
    filesRemoved: true,
  }),
  prepare: Parameters<typeof createDockerRoutes>[0]['provisioning']['prepare'] = async () => ({
    remoteControl: {},
    workspace: {},
    prestarter: {},
  }) as never,
) => {
  const database = new Database(':memory:')
  databases.push(database)
  database.exec(schema)
  const installations = new InstallationsStore(database)
  const jobsStore = new JobsStore(database)
  const jobs = new JobsRunner(jobsStore, new JobsEventHub())
  const app = new Elysia({ prefix: '/api' }).use(
    createDockerRoutes({
      preflight: {
        run: async (port = 17_549) => ({ ...preflightResult, port }),
      },
      installer: {
        installationsRoot: '/srv/gravit',
        install,
        removeInstallation,
      },
      installations,
      provisioning: {
        prepare,
      },
      jobs,
      activeJob: (installationId) =>
        jobsStore
          .listByStatuses(['queued', 'running'])
          .find((job) => job.input.installationId === installationId),
    }),
  )

  return {
    request: (path: string, init?: RequestInit) =>
      app.handle(new Request(`http://127.0.0.1${path}`, init)),
    database,
    installations,
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

const installRequest = (
  mode: 'clone' | 'import' | 'attach',
) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    mode,
    ...(mode !== 'clone' ? { importPath: '/srv/imported' } : {}),
    address: 'localhost:17549',
    projectName: 'TEST_PROJECT',
    confirmInstallation: true,
  }),
})

describe('Docker installation API', () => {
  test.each(['clone', 'import', 'attach'] as const)(
    'queues, completes, and registers a %s installation',
    async (mode) => {
      let calls = 0
      const { request, installations, jobsStore } = createHarness(async (input) => {
        calls += 1
        return installResult(input)
      })

      const response = await request('/api/docker/install', installRequest(mode))
      const queued = await response.json()
      const completed = await waitForTerminalJob(jobsStore, queued.id)
      const currentResponse = await request('/api/docker/launchserver')
      const current = await currentResponse.json()

      expect(response.status).toBe(202)
      expect(queued.type).toBe('docker.launcherdockered.install')
      expect(completed.status).toBe('succeeded')
      expect(completed.result?.installationId).toBeString()
      expect(installations.list()).toEqual([
        expect.objectContaining({
          name: 'LaunchServer',
          path: '/srv/gravit/default',
        }),
      ])
      expect(currentResponse.status).toBe(200)
      expect(current.item).toMatchObject({
        name: 'LaunchServer',
        path: '/srv/gravit/default',
      })
      expect(calls).toBe(1)
    },
  )

  test('rejects a duplicate installation request while one is active', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { request, jobsStore } = createHarness(async (input) => {
      await gate
      return installResult(input)
    })

    const first = await request('/api/docker/install', installRequest('clone'))
    const firstJob = await first.json()
    const duplicate = await request('/api/docker/install', installRequest('clone'))

    expect(first.status).toBe(202)
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({
      message: 'A LaunchServer setup job is already active.',
    })

    release?.()
    expect((await waitForTerminalJob(jobsStore, firstJob.id)).status).toBe('succeeded')
  })

  test('rejects a second installation because the panel manages a single LaunchServer', async () => {
    const { request, installations, jobsStore } = createHarness(async (input) =>
      installResult(input),
    )

    const first = await request('/api/docker/install', installRequest('clone'))
    const firstJob = await first.json()
    expect((await waitForTerminalJob(jobsStore, firstJob.id)).status).toBe('succeeded')
    expect(installations.list()).toHaveLength(1)

    const second = await request('/api/docker/install', installRequest('clone'))
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({
      message:
        'This panel manages a single LaunchServer. Remove the existing installation before creating another one.',
    })
  })

  test('serves installation configuration and validates explicit confirmation', async () => {
    const { request, jobsStore } = createHarness(async (input) => installResult(input))
    const configuration = await request('/api/docker/install/configuration')
    const invalid = await request('/api/docker/install', {
      ...installRequest('clone'),
      body: JSON.stringify({
        mode: 'clone',
        address: 'localhost:17549',
        projectName: 'TEST_PROJECT',
        confirmInstallation: false,
      }),
    })

    expect(configuration.status).toBe(200)
    expect(await configuration.json()).toMatchObject({
      launchServerPath: '/srv/gravit/default',
      defaultAddress: 'localhost:9274',
    })
    expect(invalid.status).toBe(422)
    expect(jobsStore.list()).toHaveLength(0)
  })

  test('runs automatic integration provisioning before completing LaunchServer setup', async () => {
    const order: string[] = []
    const { request, jobsStore } = createHarness(
      async (input) => {
        order.push('launcher-dockered')
        return installResult(input)
      },
      undefined,
      async (installation) => {
        order.push(`integrations:${installation.name}`)
        return {
          remoteControl: {},
          workspace: {},
          prestarter: {},
        } as never
      },
    )

    const response = await request('/api/docker/install', installRequest('clone'))
    const queued = await response.json()
    const completed = await waitForTerminalJob(jobsStore, queued.id)

    expect(completed.status).toBe('succeeded')
    expect(order).toEqual(['launcher-dockered', 'integrations:LaunchServer'])
    expect(completed.result).toHaveProperty('setup')
  })

  test('rolls back a fresh clone when automatic profile provisioning fails', async () => {
    let cleanupCalls = 0
    const { request, installations, jobsStore } = createHarness(
      async (input) => installResult(input),
      async (installation) => {
        cleanupCalls += 1
        return {
          installationId: installation.id,
          installationPath: installation.path,
          composeResourcesRemoved: true,
          filesRemoved: true,
        }
      },
      async () => {
        throw new Error('RemoteControl verification failed')
      },
    )

    const response = await request('/api/docker/install', installRequest('clone'))
    const queued = await response.json()
    const failed = await waitForTerminalJob(jobsStore, queued.id)

    expect(failed).toMatchObject({
      status: 'failed',
      error: 'RemoteControl verification failed',
    })
    expect(cleanupCalls).toBe(1)
    expect(installations.list()).toEqual([])
  })

  test('removes Compose resources, files, registration, and dependent credentials', async () => {
    let removedPath = ''
    const { request, database, installations, jobsStore } = createHarness(
      async (input) => installResult(input),
      async (installation) => {
        removedPath = installation.path
        return {
          installationId: installation.id,
          installationPath: installation.path,
          composeResourcesRemoved: true,
          filesRemoved: true,
        }
      },
    )
    const installedResponse = await request('/api/docker/install', installRequest('clone'))
    const installedJob = await installedResponse.json()
    await waitForTerminalJob(jobsStore, installedJob.id)
    const installation = installations.list()[0]!
    database.query(`
      INSERT INTO remote_control_credentials (
        installation_id, endpoint, token_ciphertext, token_iv,
        token_auth_tag, source_revision, configured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      installation.id,
      'http://localhost:9274',
      'ciphertext',
      'iv',
      'tag',
      revision,
      new Date().toISOString(),
    )

    const response = await request('/api/docker/launchserver', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmDeletion: true }),
    })
    const queued = await response.json()
    const completed = await waitForTerminalJob(jobsStore, queued.id)

    expect(response.status).toBe(202)
    expect(queued.type).toBe('docker.launcherdockered.delete')
    expect(completed).toMatchObject({
      status: 'succeeded',
      result: {
        installationId: installation.id,
        composeResourcesRemoved: true,
        filesRemoved: true,
        registrationRemoved: true,
      },
    })
    expect(removedPath).toBe(installation.path)
    expect(installations.list()).toEqual([])
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) AS count FROM remote_control_credentials',
        )
        .get()?.count,
    ).toBe(0)
    expect(jobsStore.get(queued.id)?.status).toBe('succeeded')
  })

  test('requires confirmation, a configured LaunchServer, and no active operation', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { request, installations, jobsStore } = createHarness(
      async (input) => installResult(input),
      async (installation) => {
        await gate
        return {
          installationId: installation.id,
          installationPath: installation.path,
          composeResourcesRemoved: true,
          filesRemoved: true,
        }
      },
    )
    const installedResponse = await request('/api/docker/install', installRequest('clone'))
    const installedJob = await installedResponse.json()
    await waitForTerminalJob(jobsStore, installedJob.id)
    const installation = installations.list()[0]!

    const invalid = await request('/api/docker/launchserver', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmDeletion: false }),
    })
    const first = await request('/api/docker/launchserver', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmDeletion: true }),
    })
    const firstJob = await first.json()
    const duplicate = await request('/api/docker/launchserver', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmDeletion: true }),
    })

    expect(invalid.status).toBe(422)
    expect(first.status).toBe(202)
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({
      message: 'Another operation is active for LaunchServer.',
    })

    release?.()
    expect((await waitForTerminalJob(jobsStore, firstJob.id)).status).toBe('succeeded')
    const missing = await request('/api/docker/launchserver', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmDeletion: true }),
    })
    expect(missing.status).toBe(404)
  })
})
