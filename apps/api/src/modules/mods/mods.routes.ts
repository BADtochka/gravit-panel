import type {
  ModInstallInput,
  ModrinthModpackImportInput,
  OptionalModUpdateInput,
} from '@gravit-panel/shared'
import { Elysia, t } from 'elysia'
import { installationsStore, controlFileService } from '../gravit/gravit.runtime'
import type { InstallationsStore } from '../gravit/installations.store'
import type { JobsRunner } from '../jobs/jobs.runner'
import { jobsRunner } from '../jobs/jobs.runtime'
import { ModManagerService } from './mod-manager.service'
import { ModrinthService, modrinthSource } from './modrinth.service'
import { clientBuildService } from '../clients/clients.routes'
import {
  serverBindingsStore,
  serverPackService,
} from '../servers/servers.runtime'

const modrinth = new ModrinthService()
const manager = new ModManagerService(
  controlFileService,
  modrinth,
  undefined,
  clientBuildService,
  serverPackService,
  serverBindingsStore,
)
const installationId = t.String({ format: 'uuid' })
const profile = t.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
})
const minecraftVersion = t.String({
  minLength: 1,
  maxLength: 32,
  pattern: '^[0-9]+(?:\\.[0-9]+){1,3}$',
})
const loader = t.Union([
  t.Literal('FABRIC'),
  t.Literal('FORGE'),
  t.Literal('NEOFORGE'),
  t.Literal('QUILT'),
])
const slug = t.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z0-9][a-z0-9_-]*$',
})
const filename = t.String({ minLength: 5, maxLength: 255 })
const projectId = t.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9_-]+$',
})
const packPath = t.String({ minLength: 1, maxLength: 512 })
const modInstallBody = t.Object({
  installationId,
  profile,
  minecraftVersion,
  loader,
  slugs: t.Array(slug, { minItems: 1, maxItems: 64 }),
  selections: t.Optional(t.Array(t.Object({
    slug,
    clientMode: t.Union([
      t.Literal('required'),
      t.Literal('optional'),
      t.Literal('none'),
    ]),
    optionalEnabledByDefault: t.Optional(t.Boolean()),
    optionalName: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
    optionalDescription: t.Optional(t.String({ maxLength: 500 })),
    serverBindingIds: t.Array(t.String({ format: 'uuid' }), { maxItems: 32 }),
  }), { minItems: 1, maxItems: 64 })),
})
const serverModInstallBody = t.Object({
  installationId,
  profile,
  minecraftVersion,
  loader,
  slugs: t.Array(slug, { minItems: 1, maxItems: 200, uniqueItems: true }),
  serverBindingIds: t.Array(t.String({ minLength: 1, maxLength: 128 }), {
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
  }),
})
const modpackImportInput = t.Object({
  installationId,
  profile,
  projectId,
  minecraftVersion,
  loader,
  loaderVersion: t.String({
    minLength: 1,
    maxLength: 128,
    pattern: '^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$',
  }),
  serverBindingIds: t.Array(t.String({ format: 'uuid' }), { maxItems: 32 }),
  files: t.Array(t.Object({
    path: packPath,
    clientMode: t.Union([
      t.Literal('required'),
      t.Literal('optional'),
      t.Literal('none'),
    ]),
    enabledByDefault: t.Boolean(),
    installOnServer: t.Boolean(),
    name: t.String({ minLength: 1, maxLength: 80 }),
    description: t.String({ maxLength: 500 }),
  }), { minItems: 1, maxItems: 2_000 }),
})

export interface ModsRoutesDependencies {
  installations: Pick<InstallationsStore, 'get'>
  jobs: Pick<JobsRunner, 'createQueued'>
  manager: Pick<
    ModManagerService,
    | 'list'
    | 'install'
    | 'toggle'
    | 'remove'
    | 'update'
    | 'listOptional'
    | 'updateOptional'
    | 'removeOptional'
    | 'importModpack'
    | 'importLocalModpack'
    | 'bulk'
  >
  modrinth: Pick<
    ModrinthService,
    'search' | 'searchModpacks' | 'inspectModpack' | 'inspectLocalModpack'
  >
}

export const createModsRoutes = ({
  installations,
  jobs,
  manager,
  modrinth,
}: ModsRoutesDependencies) => {
  const findInstallation = (id: string, set: { status?: number | string }) => {
    const installation = installations.get(id)
    if (!installation) set.status = 404
    return installation
  }
  const enqueue = (
    installationIdValue: string,
    type: Parameters<JobsRunner['createQueued']>[1],
    input: Record<string, unknown>,
    queuedMessage: string,
    task: Parameters<JobsRunner['createQueued']>[4],
  ) => jobs.createQueued(
    `mods:${installationIdValue}`,
    type,
    input,
    queuedMessage,
    task,
  )

  return new Elysia({ prefix: '/mods' })
  .get('/providers', () => ({
    primary: 'modrinth',
    supported: ['modrinth'],
    source: modrinthSource,
  }))
  .get(
    '/search',
    ({ query }) => modrinth.search(query.query, query.minecraftVersion, query.loader),
    {
      query: t.Object({
        query: t.String({ minLength: 1, maxLength: 100 }),
        minecraftVersion,
        loader,
      }),
    },
  )
  .get(
    '/installed',
    ({ query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return manager.list(installation, query.profile)
    },
    { query: t.Object({ installationId, profile }) },
  )
  .get(
    '/optional',
    ({ query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return manager.listOptional(installation, query.profile)
    },
    { query: t.Object({ installationId, profile }) },
  )
  .get(
    '/modpacks/search',
    ({ query }) =>
      modrinth.searchModpacks(query.query, query.minecraftVersion, query.loader),
    {
      query: t.Object({
        query: t.String({ minLength: 1, maxLength: 100 }),
        minecraftVersion,
        loader,
      }),
    },
  )
  .get(
    '/modpacks/inspect',
    ({ query }) =>
      modrinth.inspectModpack(
        query.projectId,
        query.minecraftVersion,
        query.loader,
      ),
    {
      query: t.Object({ projectId, minecraftVersion, loader }),
    },
  )
  .post(
    '/modpacks/local/inspect',
    async ({ body }) => {
      const archive = new Uint8Array(await body.file.arrayBuffer())
      return modrinth.inspectLocalModpack(
        archive,
        body.minecraftVersion,
        body.loader,
      )
    },
    {
      body: t.Object({
        minecraftVersion,
        loader,
        file: t.File({ maxSize: 100 * 1024 * 1024 }),
      }),
    },
  )
  .post(
    '/install',
    ({ body, set }) => {
      const input = body as ModInstallInput
      const installation = findInstallation(input.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const job = enqueue(
        installation.id,
        'gravit.mods.install',
        { ...input },
        `${input.slugs.length} mod installation queued`,
        async (context) => ({ ...(await manager.install(installation, input, context)) }),
      )
      set.status = 202
      return job
    },
    {
      body: modInstallBody,
    },
  )
  .post(
    '/server/install',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const input: ModInstallInput = {
        ...body,
        selections: body.slugs.map((selectedSlug) => ({
          slug: selectedSlug,
          clientMode: 'none',
          serverBindingIds: body.serverBindingIds,
        })),
      }
      const job = enqueue(
        installation.id,
        'gravit.mods.server.install',
        { ...input },
        `${input.slugs.length} mod server installation queued for ${body.serverBindingIds.length} server(s)`,
        async (context) => ({ ...(await manager.install(installation, input, context)) }),
      )
      set.status = 202
      return job
    },
    { body: serverModInstallBody },
  )
  .post(
    '/optional/update',
    ({ body, set }) => {
      const input = body as OptionalModUpdateInput
      const installation = findInstallation(input.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const job = enqueue(
        installation.id,
        'gravit.mods.optional.update',
        { ...input },
        `Optional mod ${input.name} update queued`,
        async (context) => ({ ...(await manager.updateOptional(installation, input, context)) }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        profile,
        projectId,
        name: t.String({ minLength: 1, maxLength: 80 }),
        description: t.String({ maxLength: 500 }),
        category: t.String({ minLength: 1, maxLength: 40 }),
        enabledByDefault: t.Boolean(),
      }),
    },
  )
  .post(
    '/optional/remove',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const job = enqueue(
        installation.id,
        'gravit.mods.optional.remove',
        { ...body },
        'Optional mod removal queued',
        async (context) => ({
          ...(await manager.removeOptional(
            installation,
            body.profile,
            body.projectId,
            context,
          )),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        profile,
        projectId,
        confirmRemoval: t.Literal(true),
      }),
    },
  )
  .post(
    '/modpacks/import',
    ({ body, set }) => {
      const input = body as ModrinthModpackImportInput
      const installation = findInstallation(input.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const job = enqueue(
        installation.id,
        'gravit.mods.modpack.import',
        { ...input },
        'Modrinth modpack import queued',
        async (context) => ({
          ...(await manager.importModpack(installation, input, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: modpackImportInput,
    },
  )
  .post(
    '/modpacks/local/import',
    async ({ body, set }) => {
      const input = body.input as ModrinthModpackImportInput
      const installation = findInstallation(input.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const archive = new Uint8Array(await body.file.arrayBuffer())
      const job = enqueue(
        installation.id,
        'gravit.mods.modpack.import',
        {
          ...input,
          source: 'local',
          filename: body.file.name,
          archiveSize: archive.length,
        },
        'Local Modrinth modpack import queued',
        async (context) => ({
          ...(await manager.importLocalModpack(
            installation,
            input,
            archive,
            context,
          )),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        input: modpackImportInput,
        file: t.File({ maxSize: 100 * 1024 * 1024 }),
      }),
    },
  )
  .post(
    '/bulk',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      if (body.action === 'remove' && body.confirmRemoval !== true) {
        set.status = 422
        return { message: 'Bulk removal requires explicit confirmation.' }
      }
      if (body.action === 'update' && (!body.minecraftVersion || !body.loader)) {
        set.status = 422
        return { message: 'Bulk update requires Minecraft version and loader.' }
      }
      const job = enqueue(
        installation.id,
        'gravit.mods.bulk',
        { ...body },
        `Bulk ${body.action} queued for ${body.filenames.length} mods`,
        async (context) => ({
          ...(await manager.bulk(installation, body, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        profile,
        filenames: t.Array(filename, { minItems: 1, maxItems: 200, uniqueItems: true }),
        action: t.Union([
          t.Literal('enable'),
          t.Literal('disable'),
          t.Literal('update'),
          t.Literal('remove'),
        ]),
        minecraftVersion: t.Optional(minecraftVersion),
        loader: t.Optional(loader),
        confirmRemoval: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/toggle',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const job = enqueue(
        installation.id,
        'gravit.mods.toggle',
        { ...body },
        `${body.enabled ? 'Enable' : 'Disable'} mod queued`,
        async (context) => ({
          ...(await manager.toggle(
            installation,
            body.profile,
            body.filename,
            body.enabled,
            context,
          )),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({ installationId, profile, filename, enabled: t.Boolean() }),
    },
  )
  .post(
    '/remove',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const job = enqueue(
        installation.id,
        'gravit.mods.remove',
        { ...body },
        'Recoverable mod removal queued',
        async (context) => ({
          ...(await manager.remove(installation, body.profile, body.filename, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        profile,
        filename,
        confirmRemoval: t.Literal(true),
      }),
    },
  )
  .post(
    '/update',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const job = enqueue(
        installation.id,
        'gravit.mods.update',
        { ...body },
        'Modrinth mod update queued',
        async (context) => ({
          ...(await manager.update(
            installation,
            body.profile,
            body.filename,
            body.minecraftVersion,
            body.loader,
            context,
          )),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        profile,
        filename,
        minecraftVersion,
        loader,
      }),
    },
  )
}

export const modsRoutes = createModsRoutes({
  installations: installationsStore,
  jobs: jobsRunner,
  manager,
  modrinth,
})
