import type { JobRecord, ModInstallInput } from '@gravit-panel/shared'
import { Elysia, t } from 'elysia'
import { installationsStore, controlFileService } from '../gravit/gravit.runtime'
import type { InstallationsStore } from '../gravit/installations.store'
import type { JobsRunner } from '../jobs/jobs.runner'
import { activeJobForInstallation, jobsRunner } from '../jobs/jobs.runtime'
import { ModManagerService } from './mod-manager.service'
import { ModrinthService, modrinthSource } from './modrinth.service'

const modrinth = new ModrinthService()
const manager = new ModManagerService(controlFileService, modrinth)
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

export interface ModsRoutesDependencies {
  installations: Pick<InstallationsStore, 'get'>
  jobs: Pick<JobsRunner, 'create'>
  activeJob: (installationId: string) => JobRecord | null | undefined
  manager: Pick<ModManagerService, 'list' | 'install' | 'toggle' | 'remove' | 'update'>
  modrinth: Pick<ModrinthService, 'search'>
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
