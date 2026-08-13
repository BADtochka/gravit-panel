import { afterEach, describe, expect, test } from 'bun:test'
import type {
  AuthConfiguration,
  FileAuthInstallResult,
  GravitInstallation,
} from '@gravit-panel/shared'
import { Database } from 'bun:sqlite'
import { Elysia } from 'elysia'
import { schema } from '../../db/schema'
import { JobsEventHub } from '../jobs/jobs.events'
import { JobsRunner } from '../jobs/jobs.runner'
import { JobsStore } from '../jobs/jobs.store'
import type { AuthRoutesDependencies } from './auth.routes'
import { fileAuthRecipeSource } from './auth-recipes'
import { createAuthRoutes } from './auth.routes'

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

const configuration: AuthConfiguration = {
  installationId: installation.id,
  providers: [
    { id: 'std', displayName: 'Default', coreType: 'reject', isDefault: true, visible: true },
  ],
  recipes: [
    {
      id: 'file',
      title: 'FileAuthSystem',
      description: 'File-backed authentication',
      coreType: 'fileauthsystem',
      moduleId: 'FileAuthSystem_module',
      requiresModuleIds: ['FileAuthSystem_module'],
      source: fileAuthRecipeSource,
    },
  ],
}

const result: FileAuthInstallResult = {
  installationId: installation.id,
  requestedAuthId: 'std',
  configuredAuthId: 'std',
  alreadyConfigured: false,
  configBackupPath: '/srv/gravit/default/launcher/LaunchServer.json.backup-test',
  source: fileAuthRecipeSource,
}

const createHarness = (overrides: Partial<AuthRoutesDependencies['providers']> = {}) => {
  const database = new Database(':memory:')
  databases.push(database)
  database.exec(schema)
  const store = new JobsStore(database)
  const runner = new JobsRunner(store, new JobsEventHub())
  const providers = {
    configuration: async () => configuration,
    providerDetail: async () => {
      throw new Error('not used')
    },
    installFileAuth: async () => result,
    applyProvider: async () => {
      throw new Error('not used')
    },
    ...overrides,
  } satisfies AuthRoutesDependencies['providers']
  const app = new Elysia({ prefix: '/api' }).use(
    createAuthRoutes({
      providers,
      users: {
        list: async () => ({
          installationId: installation.id,
          authId: 'std',
          coreType: 'reject',
          managed: false,
          reason: 'not managed',
          users: [],
        }),
        create: async () => ({
          installationId: installation.id,
          authId: 'std',
          username: 'player',
        }),
        setPassword: async () => ({
          installationId: installation.id,
          authId: 'std',
          username: 'player',
        }),
        delete: async () => ({
          installationId: installation.id,
          authId: 'std',
          username: 'player',
        }),
      },
      moduleConfig: {
        getFileAuthConfig: async () => ({ autoSave: true }),
        applyFileAuthConfig: async () => ({
          installationId: installation.id,
          config: { autoSave: true },
          configBackupPath: null,
          source: fileAuthRecipeSource,
        }),
      },
      moduleArtifacts: {
        cleanup: async () => ({ removedFiles: [], removedBytes: 0 }),
      },
      installations: {
        get: (id) => (id === installation.id ? installation : null),
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
      app.handle(new Request(`http://localhost${path}`, init)),
    runner,
  }
}

describe('auth routes', () => {
  test('returns sanitized auth configuration', async () => {
    const { request } = createHarness()
    const response = await request(
      `/api/auth/configuration?installationId=${installation.id}`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(configuration)
  })

  test('queues a FileAuthSystem install job', async () => {
    const { request } = createHarness()
    const response = await request('/api/auth/file/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: installation.id,
        authId: 'std',
        confirmConfigWrite: true,
      }),
    })
    expect(response.status).toBe(202)
    const body = await response.json()
    expect(body.type).toBe('gravit.auth.file.install')
  })

  test('rejects install without confirmation', async () => {
    const { request } = createHarness()
    const response = await request('/api/auth/file/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: installation.id,
        authId: 'std',
        confirmConfigWrite: false,
      }),
    })
    expect(response.status).toBe(422)
  })

  test('queues a provider apply job', async () => {
    const { request } = createHarness({
      applyProvider: async () => ({
        installationId: installation.id,
        authId: 'std',
        coreType: 'memory',
        configBackupPath: null,
        restarted: false,
        source: fileAuthRecipeSource,
      }),
    })
    const apply = await request('/api/auth/providers/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: installation.id,
        authId: 'std',
        recipeId: 'memory',
        displayName: 'Default',
        isDefault: true,
        visible: true,
        confirmConfigWrite: true,
      }),
    })
    expect(apply.status).toBe(202)
    expect((await apply.json()).type).toBe('gravit.auth.provider.apply')
  })
})
