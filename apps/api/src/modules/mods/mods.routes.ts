import type {
  JobRecord,
  ModInstallInput,
  ModrinthModpackImportInput,
  OptionalModUpdateInput,
} from '@gravit-panel/shared'
import { Elysia, t } from 'elysia'
import { installationsStore, controlFileService } from '../gravit/gravit.runtime'
import type { InstallationsStore } from '../gravit/installations.store'
import type { JobsRunner } from '../jobs/jobs.runner'
import { activeJobForInstallation, jobsRunner } from '../jobs/jobs.runtime'
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

export interface ModsRoutesDependencies {
  installations: Pick<InstallationsStore, 'get'>
  jobs: Pick<JobsRunner, 'create'>
  activeJob: (installationId: string) => JobRecord | null | undefined
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
  >
  modrinth: Pick<ModrinthService, 'search' | 'searchModpacks' | 'inspectModpack'>
}

export const createModsRoutes = ({
  installations,
  jobs,
  activeJob,
  manager,
  modrinth,
}: ModsRoutesDependencies) => {
  const findInstallation = (id: string, set: { status?: number | string }) => {
    const installation = installations.get(id)
    if (!installation) set.status = 404
    return installation
  }

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
    '/install',
    ({ body, set }) => {
      const input = body as ModInstallInput
      const installation = findInstallation(input.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another mod operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
        'gravit.mods.install',
        { ...input },
        `${input.slugs.length} mod installation queued`,
        async (context) => ({ ...(await manager.install(installation, input, context)) }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
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
      }),
    },
  )
  .post(
    '/optional/update',
    ({ body, set }) => {
      const input = body as OptionalModUpdateInput
      const installation = findInstallation(input.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another mod operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
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
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another mod operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
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
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another mod operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
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
      body: t.Object({
        installationId,
        profile,
        projectId,
        minecraftVersion,
        loader,
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
      }),
    },
  )
  .post(
    '/toggle',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another mod operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
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
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another mod operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
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
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another mod operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
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
  activeJob: activeJobForInstallation,
  manager,
  modrinth,
})
