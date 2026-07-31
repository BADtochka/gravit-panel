import { afterEach, describe, expect, test } from 'bun:test'
import type {
  GravitInstallation,
  LaunchServerCommandResult,
  LaunchServerInspectionCommand,
} from '@gravit-panel/shared'
import { Database } from 'bun:sqlite'
import { Elysia } from 'elysia'
import type { CredentialKeyStatus } from '../../core/credential-key.service'
import { schema } from '../../db/schema'
import { JobsEventHub } from '../jobs/jobs.events'
import { JobsRunner } from '../jobs/jobs.runner'
import { JobsStore } from '../jobs/jobs.store'
import { createGravitRoutes } from './gravit.routes'

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

interface HarnessOptions {
  configured?: boolean
  encryptedCredentials?: boolean
  generate?: () => Promise<CredentialKeyStatus>
  setup?: (...args: never[]) => Promise<Record<string, unknown>>
  execute?: (
    installation: GravitInstallation,
    command: LaunchServerInspectionCommand,
  ) => Promise<LaunchServerCommandResult>
  syncProfiles?: () => Promise<{
    installationId: string
    synchronized: boolean
    lines: string[]
  }>
}

const commandResult = (
  command: LaunchServerInspectionCommand,
): LaunchServerCommandResult => ({
  installationId: installation.id,
  command,
  transport: 'control-file',
  lines: [`${command} complete`],
  startedAt: '2026-07-27T12:00:00.000Z',
  finishedAt: '2026-07-27T12:00:01.000Z',
  source: {
    repository: 'https://github.com/GravitLauncher/Launcher',
    revision: 'fef9bae63da1afc0518d32e3333db20f409ab196',
    file: 'SocketCommandServer.java',
  },
})

const createHarness = (options: HarnessOptions = {}) => {
  const database = new Database(':memory:')
  databases.push(database)
  database.exec(schema)
  const jobsStore = new JobsStore(database)
  const jobs = new JobsRunner(jobsStore, new JobsEventHub())
  const configured = options.configured ?? true
  const status: CredentialKeyStatus = {
    configured,
    source: configured ? 'memory' : null,
    canGenerate: !configured,
  }
  const app = new Elysia({ prefix: '/api' }).use(
    createGravitRoutes({
      cipher: { configured },
      keyService: {
        status,
        generate: options.generate ?? (async () => ({
          configured: true,
          source: 'memory',
          canGenerate: false,
        })),
      },
      installations: {
        get: (id) => id === installation.id ? installation : null,
      },
      operations: {
        inspect: async (_installation, command) => ({
          ...await (options.execute ?? (async (_value, selected) => commandResult(selected)))(
            installation,
            command,
          ),
        }),
        syncProfiles: options.syncProfiles ?? (async () => ({
          installationId: installation.id,
          synchronized: true,
          lines: [],
        })),
      },
      remoteSetup: {
        setup: (options.setup ?? (async () => ({
          installationId: installation.id,
          endpoint: 'http://localhost:17549',
        }))) as never,
      },
      remoteStore: {
        listConfiguredInstallationIds: () => configured ? [installation.id] : [],
        hasEncryptedCredentials: () => options.encryptedCredentials ?? false,
      },
      jobs,
      activeJob: (id) =>
        jobsStore
          .listByStatuses(['queued', 'running'])
          .find((job) => job.input.installationId === id),
    }),
  )

  return {
    request: (path: string, init?: RequestInit) =>
      app.handle(new Request(`http://127.0.0.1${path}`, init)),
    jobsStore,
  }
}

const post = (body: Record<string, unknown>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const waitForTerminalJob = async (store: JobsStore, id: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = store.get(id)
    if (job?.status === 'succeeded' || job?.status === 'failed') return job
    await Bun.sleep(5)
  }
  throw new Error(`Job ${id} did not finish`)
}

describe('Gravit configuration API', () => {
  test('reports encryption configuration and generates a key without exposing it', async () => {
    let generations = 0
    const { request } = createHarness({
      configured: false,
      generate: async () => {
        generations += 1
        return {
          configured: true,
          source: 'memory',
          canGenerate: false,
        }
      },
    })

    const before = await request('/api/gravit/remote-control/configuration')
    const generated = await request(
      '/api/gravit/remote-control/encryption-key',
      post({ confirmGeneration: true }),
    )
    const body = await generated.json()

    expect(before.status).toBe(200)
    expect(await before.json()).toMatchObject({
      encryptionConfigured: false,
      canGenerateEncryptionKey: true,
    })
    expect(generated.status).toBe(201)
    expect(body).toEqual({
      encryptionConfigured: true,
      encryptionSource: 'memory',
      canGenerateEncryptionKey: false,
    })
    expect(JSON.stringify(body)).not.toContain('key')
    expect(generations).toBe(1)
  })

  test('blocks unsafe encryption-key replacement states', async () => {
    const configured = createHarness({ configured: true })
    const encrypted = createHarness({
      configured: false,
      encryptedCredentials: true,
    })

    const configuredResponse = await configured.request(
      '/api/gravit/remote-control/encryption-key',
      post({ confirmGeneration: true }),
    )
    const encryptedResponse = await encrypted.request(
      '/api/gravit/remote-control/encryption-key',
      post({ confirmGeneration: true }),
    )

    expect(configuredResponse.status).toBe(409)
    expect(encryptedResponse.status).toBe(409)
  })

  test('queues and completes RemoteControl setup once', async () => {
    let calls = 0
    const { request, jobsStore } = createHarness({
      setup: async () => {
        calls += 1
        return {
          installationId: installation.id,
          endpoint: 'http://localhost:17549',
        }
      },
    })

    const response = await request(
      '/api/gravit/remote-control/setup',
      post({
        installationId: installation.id,
        endpoint: 'http://localhost:17549',
        replaceExistingTokens: true,
      }),
    )
    const queued = await response.json()
    const completed = await waitForTerminalJob(jobsStore, queued.id)

    expect(response.status).toBe(202)
    expect(queued.type).toBe('gravit.remote-control.setup')
    expect(completed).toMatchObject({
      status: 'succeeded',
      result: {
        installationId: installation.id,
        endpoint: 'http://localhost:17549',
      },
    })
    expect(calls).toBe(1)
  })

  test('rejects RemoteControl setup when encryption, installation, or job state is invalid', async () => {
    const disabled = createHarness({ configured: false })
    const disabledResponse = await disabled.request(
      '/api/gravit/remote-control/setup',
      post({
        installationId: installation.id,
        endpoint: 'http://localhost:17549',
        replaceExistingTokens: true,
      }),
    )

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const active = createHarness({
      setup: async () => {
        await gate
        return { installationId: installation.id }
      },
    })
    const setupBody = {
      installationId: installation.id,
      endpoint: 'http://localhost:17549',
      replaceExistingTokens: true,
    }
    const first = await active.request(
      '/api/gravit/remote-control/setup',
      post(setupBody),
    )
    const firstJob = await first.json()
    const duplicate = await active.request(
      '/api/gravit/remote-control/setup',
      post(setupBody),
    )
    const unknown = await active.request(
      '/api/gravit/remote-control/setup',
      post({ ...setupBody, installationId: crypto.randomUUID() }),
    )

    expect(disabledResponse.status).toBe(503)
    expect(first.status).toBe(202)
    expect(duplicate.status).toBe(409)
    expect(unknown.status).toBe(404)

    release?.()
    expect((await waitForTerminalJob(active.jobsStore, firstJob.id)).status).toBe('succeeded')
  })

  test.each([
    ['status', 'serverStatus'],
    ['securitycheck', 'securitycheck'],
  ] as const)('queues the %s inspection endpoint', async (path, command) => {
    const executed: LaunchServerInspectionCommand[] = []
    const { request, jobsStore } = createHarness({
      execute: async (_installation, value) => {
        executed.push(value)
        return commandResult(value)
      },
    })

    const response = await request(
      `/api/gravit/${path}`,
      post({ installationId: installation.id }),
    )
    const queued = await response.json()
    const completed = await waitForTerminalJob(jobsStore, queued.id)

    expect(response.status).toBe(202)
    expect(queued.type).toBe(
      command === 'serverStatus'
        ? 'gravit.launchserver.status'
        : 'gravit.launchserver.securitycheck',
    )
    expect(completed.result?.command).toBe(command)
    expect(executed).toEqual([command])
  })

  test('queues the sync-profiles maintenance endpoint', async () => {
    const { request, jobsStore } = createHarness()
    const response = await request(
      '/api/gravit/sync-profiles',
      post({ installationId: installation.id }),
    )
    const queued = await response.json()
    const completed = await waitForTerminalJob(jobsStore, queued.id)

    expect(response.status).toBe(202)
    expect(queued.type).toBe('gravit.launchserver.profiles.sync')
    expect(completed.status).toBe('succeeded')
  })
})
