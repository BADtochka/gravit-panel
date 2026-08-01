import { afterEach, describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { Database } from 'bun:sqlite'
import { Elysia } from 'elysia'
import { schema } from '../../db/schema'
import { JobsEventHub } from '../jobs/jobs.events'
import { JobsRunner } from '../jobs/jobs.runner'
import { JobsStore } from '../jobs/jobs.store'
import type { ModManagerService } from './mod-manager.service'
import { modrinthSource, type ModrinthService } from './modrinth.service'
import { createModsRoutes } from './mods.routes'

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
  overrides: Partial<ModManagerService> = {},
  search: ModrinthService['search'] = async () => ({
    items: [],
    source: modrinthSource,
  }),
  modrinthOverrides: Partial<ModrinthService> = {},
) => {
  const database = new Database(':memory:')
  databases.push(database)
  database.exec(schema)
  const jobsStore = new JobsStore(database)
  const jobs = new JobsRunner(jobsStore, new JobsEventHub())
  const manager = {
    list: async () => ({ items: [], source: modrinthSource }),
    install: async () => ({}),
    toggle: async () => ({}),
    remove: async () => ({}),
    update: async () => ({}),
    listOptional: async () => ({ items: [] }),
    updateOptional: async () => ({}),
    removeOptional: async () => ({}),
    importModpack: async () => ({}),
    importLocalModpack: async () => ({}),
    bulk: async () => ({}),
    ...overrides,
  } as unknown as ModManagerService
  const app = new Elysia({ prefix: '/api' }).use(
    createModsRoutes({
      installations: {
        get: (id) => id === installation.id ? installation : null,
      },
      jobs,
      manager,
      modrinth: {
        search,
        searchModpacks: search,
        inspectModpack: async () => ({} as never),
        inspectLocalModpack: async () => ({} as never),
        ...modrinthOverrides,
      },
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

const post = (body: Record<string, unknown>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('mod management API', () => {
  test.each([
    {
      name: 'install',
      path: '/api/mods/install',
      method: 'install',
      type: 'gravit.mods.install',
      body: {
        installationId: installation.id,
        profile: 'fabric',
        minecraftVersion: '1.21.4',
        loader: 'FABRIC',
        slugs: ['sodium'],
      },
    },
    {
      name: 'server install',
      path: '/api/mods/server/install',
      method: 'install',
      type: 'gravit.mods.server.install',
      body: {
        installationId: installation.id,
        profile: 'fabric',
        minecraftVersion: '1.21.4',
        loader: 'FABRIC',
        slugs: ['lithium'],
        serverBindingIds: ['f60b5c42-9420-4135-b894-8a87d3805504'],
      },
    },
    {
      name: 'toggle',
      path: '/api/mods/toggle',
      method: 'toggle',
      type: 'gravit.mods.toggle',
      body: {
        installationId: installation.id,
        profile: 'fabric',
        filename: 'sodium.jar',
        enabled: false,
      },
    },
    {
      name: 'recoverable remove',
      path: '/api/mods/remove',
      method: 'remove',
      type: 'gravit.mods.remove',
      body: {
        installationId: installation.id,
        profile: 'fabric',
        filename: 'sodium.jar',
        confirmRemoval: true,
      },
    },
    {
      name: 'update',
      path: '/api/mods/update',
      method: 'update',
      type: 'gravit.mods.update',
      body: {
        installationId: installation.id,
        profile: 'fabric',
        filename: 'sodium.jar',
        minecraftVersion: '1.21.4',
        loader: 'FABRIC',
      },
    },
    {
      name: 'optional metadata update',
      path: '/api/mods/optional/update',
      method: 'updateOptional',
      type: 'gravit.mods.optional.update',
      body: {
        installationId: installation.id,
        profile: 'fabric',
        projectId: 'sodium',
        name: 'Sodium',
        description: 'Fast renderer',
        category: 'Performance',
        enabledByDefault: true,
      },
    },
    {
      name: 'optional removal',
      path: '/api/mods/optional/remove',
      method: 'removeOptional',
      type: 'gravit.mods.optional.remove',
      body: {
        installationId: installation.id,
        profile: 'fabric',
        projectId: 'sodium',
        confirmRemoval: true,
      },
    },
    {
      name: 'bulk disable',
      path: '/api/mods/bulk',
      method: 'bulk',
      type: 'gravit.mods.bulk',
      body: {
        installationId: installation.id,
        profile: 'fabric',
        filenames: ['sodium.jar', 'iris.jar'],
        action: 'disable',
      },
    },
    {
      name: 'Modrinth modpack import',
      path: '/api/mods/modpacks/import',
      method: 'importModpack',
      type: 'gravit.mods.modpack.import',
      body: {
        installationId: installation.id,
        profile: 'fabric',
        projectId: 'pack-id',
        minecraftVersion: '1.21.4',
        loader: 'FABRIC',
        loaderVersion: '0.16.10',
        serverBindingIds: [],
        files: [{
          path: 'mods/sodium.jar',
          clientMode: 'required',
          enabledByDefault: false,
          installOnServer: false,
          name: 'Sodium',
          description: 'Renderer',
        }],
      },
    },
  ])('queues and completes $name exactly once', async ({ path, method, type, body }) => {
    let calls = 0
    const operation = async () => {
      calls += 1
      return { installationId: installation.id, operation: method }
    }
    const { request, jobsStore } = createHarness({
      [method]: operation,
    } as Partial<ModManagerService>)

    const response = await request(path, post(body))
    const queued = await response.json()
    const completed = await waitForTerminalJob(jobsStore, queued.id)

    expect(response.status).toBe(202)
    expect(queued.type).toBe(type)
    expect(completed).toMatchObject({
      status: 'succeeded',
      result: { installationId: installation.id, operation: method },
    })
    expect(calls).toBe(1)
  })

  test('serves provider, search, and installed-mod read APIs', async () => {
    const { request } = createHarness(
      {
        list: async () => ({
          items: [
            {
              filename: 'sodium.jar',
              disabled: false,
              size: 1,
              sha1: 'hash',
              projectId: null,
              versionId: null,
              versionName: null,
              name: null,
              description: null,
              slug: null,
              serverSide: null,
            },
          ],
          source: modrinthSource,
        }),
      },
      async () => ({
        items: [
          {
            projectId: 'project',
            slug: 'sodium',
            title: 'Sodium',
            description: 'Renderer',
            author: 'author',
            iconUrl: null,
            downloads: 1,
            versions: ['1.21.4'],
            loaders: ['fabric'],
          },
        ],
        source: modrinthSource,
      }),
    )

    const [providers, search, installed] = await Promise.all([
      request('/api/mods/providers'),
      request('/api/mods/search?query=sodium&minecraftVersion=1.21.4&loader=FABRIC'),
      request(`/api/mods/installed?installationId=${installation.id}&profile=fabric`),
    ])

    expect(providers.status).toBe(200)
    expect((await providers.json()).primary).toBe('modrinth')
    expect((await search.json()).items[0]?.slug).toBe('sodium')
    expect((await installed.json()).items[0]?.filename).toBe('sodium.jar')
  })

  test('accepts server-only selections on the legacy install endpoint', async () => {
    const { request, jobsStore } = createHarness()
    const response = await request('/api/mods/install', post({
      installationId: installation.id,
      profile: 'fabric',
      minecraftVersion: '1.21.4',
      loader: 'FABRIC',
      slugs: ['lithium'],
      selections: [{
        slug: 'lithium',
        clientMode: 'none',
        serverBindingIds: ['f60b5c42-9420-4135-b894-8a87d3805504'],
      }],
    }))
    const queued = await response.json()

    expect(response.status).toBe(202)
    expect(queued.type).toBe('gravit.mods.install')
    expect(await waitForTerminalJob(jobsStore, queued.id)).toMatchObject({ status: 'succeeded' })
  })

  test('normalizes the simple server install payload into a persisted job', async () => {
    let received: unknown = null
    const { request, jobsStore } = createHarness({
      install: async (_installation, input) => {
        received = input
        return {
          installationId: installation.id,
          profile: input.profile,
          selections: input.selections ?? [],
          source: modrinthSource,
        }
      },
    })
    const response = await request('/api/mods/server/install', post({
      installationId: installation.id,
      profile: 'fabric',
      minecraftVersion: '1.21.4',
      loader: 'FABRIC',
      slugs: ['lithium'],
      serverBindingIds: ['legacy-server-binding'],
    }))
    const queued = await response.json()
    const completed = await waitForTerminalJob(jobsStore, queued.id)

    expect(response.status).toBe(202)
    expect(completed?.type).toBe('gravit.mods.server.install')
    expect(completed?.input).toMatchObject({
      slugs: ['lithium'],
      selections: [{
        slug: 'lithium',
        clientMode: 'none',
        serverBindingIds: ['legacy-server-binding'],
      }],
    })
    expect(received).toMatchObject(completed?.input ?? {})
  })

  test('inspects an uploaded local mrpack', async () => {
    let received: Uint8Array<ArrayBufferLike> = new Uint8Array()
    const { request } = createHarness({}, undefined, {
      inspectLocalModpack: async (archive) => {
        received = archive
        return { name: 'Local pack' } as never
      },
    })
    const body = new FormData()
    body.set('minecraftVersion', '1.21.4')
    body.set('loader', 'FABRIC')
    body.set('file', new File([new Uint8Array([1, 2, 3])], 'local.mrpack'))

    const response = await request('/api/mods/modpacks/local/inspect', {
      method: 'POST',
      body,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ name: 'Local pack' })
    expect([...received]).toEqual([1, 2, 3])
  })

  test('queues a local mrpack import with its archive', async () => {
    let received: Uint8Array<ArrayBufferLike> = new Uint8Array()
    const input = {
      installationId: installation.id,
      profile: 'fabric',
      projectId: 'local-0123456789abcdef',
      minecraftVersion: '1.21.4',
      loader: 'FABRIC',
      loaderVersion: '0.16.10',
      serverBindingIds: [],
      files: [{
        path: 'mods/sodium.jar',
        clientMode: 'required',
        enabledByDefault: false,
        installOnServer: false,
        name: 'Sodium',
        description: '',
      }],
    }
    const { request, jobsStore } = createHarness({
      importLocalModpack: async (_installation, _input, archive) => {
        received = archive
        return { installationId: installation.id } as never
      },
    })
    const body = new FormData()
    body.set('input', JSON.stringify(input))
    body.set('file', new File([new Uint8Array([4, 5, 6])], 'local.mrpack'))

    const response = await request('/api/mods/modpacks/local/import', {
      method: 'POST',
      body,
    })
    const queued = await response.json()

    expect(response.status).toBe(202)
    const completed = await waitForTerminalJob(jobsStore, queued.id)
    expect(completed.status).toBe('succeeded')
    expect([...received]).toEqual([4, 5, 6])
  })

  test('queues concurrent operations while rejecting invalid requests', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { request, jobsStore } = createHarness({
      install: async () => {
        await gate
        return { installationId: installation.id } as never
      },
    })
    const installBody = {
      installationId: installation.id,
      profile: 'fabric',
      minecraftVersion: '1.21.4',
      loader: 'FABRIC',
      slugs: ['sodium'],
    }
    const first = await request('/api/mods/install', post(installBody))
    const firstJob = await first.json()
    const duplicate = await request('/api/mods/install', post(installBody))
    const duplicateJob = await duplicate.json()
    const invalidRemoval = await request('/api/mods/remove', post({
      installationId: installation.id,
      profile: 'fabric',
      filename: 'sodium.jar',
      confirmRemoval: false,
    }))
    const unknown = await request('/api/mods/toggle', post({
      installationId: crypto.randomUUID(),
      profile: 'fabric',
      filename: 'sodium.jar',
      enabled: true,
    }))
    expect(first.status).toBe(202)
    expect(duplicate.status).toBe(202)
    expect(jobsStore.get(duplicateJob.id)?.status).toBe('queued')
    expect(invalidRemoval.status).toBe(422)
    expect(unknown.status).toBe(404)

    release?.()
    expect((await waitForTerminalJob(jobsStore, firstJob.id)).status).toBe('succeeded')
    expect((await waitForTerminalJob(jobsStore, duplicateJob.id)).status).toBe('succeeded')
    const unconfirmedBulkRemoval = await request('/api/mods/bulk', post({
      installationId: installation.id,
      profile: 'fabric',
      filenames: ['sodium.jar'],
      action: 'remove',
    }))
    expect(unconfirmedBulkRemoval.status).toBe(422)
  })
})
