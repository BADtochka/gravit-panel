import type {
  DiscordAuthSystemBuildInput,
  GravitModuleInstallInput,
  GravitModuleRemoveInput,
  JobRecord,
} from '@gravit-panel/shared'
import { Elysia, t } from 'elysia'
import { env } from '../../core/env'
import { LauncherDockeredService } from '../docker/launcherdockered.service'
import { ControlFileBusyError } from '../gravit/control-file.service'
import { installationsStore } from '../gravit/gravit.runtime'
import type { InstallationsStore } from '../gravit/installations.store'
import type { JobsRunner } from '../jobs/jobs.runner'
import type { JobsStore } from '../jobs/jobs.store'
import { activeJobForInstallation, jobsRunner, jobsStore } from '../jobs/jobs.runtime'
import { DiscordAuthSystemBuildService } from './discord-auth-system-build.service'
import { findCatalogModule, moduleCatalog } from './module-catalog'
import { moduleManagement } from './modules.runtime'

const lifecycle = new LauncherDockeredService(
  env.INSTALLATIONS_ROOT,
  undefined,
  undefined,
  env.LAUNCHSERVER_PUBLIC_URL,
)

const installationId = t.String({ format: 'uuid' })
const moduleId = t.String({
  minLength: 1,
  maxLength: 96,
  pattern: '^[a-zA-Z0-9]+_(module|lmodule)$',
})

export interface ModulesRoutesDependencies {
  installations: Pick<InstallationsStore, 'get'>
  jobs: Pick<JobsRunner, 'create'>
  jobsStore: Pick<JobsStore, 'listByStatuses'>
  activeJob: (installationId: string) => JobRecord | null | undefined
  management: Pick<typeof moduleManagement, 'getState' | 'install' | 'remove'>
  buildService?: DiscordAuthSystemBuildService
  lifecycle?: Pick<LauncherDockeredService, 'restartLaunchServer'>
}

export const createModulesRoutes = ({
  installations,
  jobs,
  jobsStore,
  activeJob,
  management,
  buildService = new DiscordAuthSystemBuildService(),
  lifecycle: managedLifecycle = lifecycle,
}: ModulesRoutesDependencies) => {
  const activeModuleJobs = () => jobsStore.listByStatuses(['queued', 'running'])

  return new Elysia({ prefix: '/modules' })
  .get('/catalog', () => moduleCatalog)
  .get(
    '/state',
    async ({ query, set }) => {
      const installation = installations.get(query.installationId)
      if (!installation) {
        set.status = 404
        return { message: 'LauncherDockered installation not found.' }
      }

      const conflictingJob = activeJob(installation.id)
      if (conflictingJob) {
        return {
          installationId: installation.id,
          checkedAt: new Date().toISOString(),
          items: [],
          busy: true,
          activeJob: {
            id: conflictingJob.id,
            type: conflictingJob.type,
            status: conflictingJob.status,
          },
        }
      }

      try {
        const items = await management.getState(installation, activeModuleJobs())
        return {
          installationId: installation.id,
          checkedAt: new Date().toISOString(),
          items,
          busy: false,
          activeJob: null,
        }
      } catch (error) {
        if (error instanceof ControlFileBusyError) {
          return {
            installationId: installation.id,
            checkedAt: new Date().toISOString(),
            items: [],
            busy: true,
            activeJob: null,
          }
        }
        set.status = 503
        return { message: error instanceof Error ? error.message : String(error) }
      }
    },
    {
      query: t.Object({ installationId }),
    },
  )
  .post(
    '/install',
    ({ body, set }) => {
      const input = body as GravitModuleInstallInput
      const installation = installations.get(input.installationId)
      if (!installation) {
        set.status = 404
        return { message: 'LauncherDockered installation not found.' }
      }

      const item = findCatalogModule(input.moduleId)
      if (!item) {
        set.status = 404
        return { message: 'Module is not present in the source-verified release catalog.' }
      }

      const conflictingJob = activeJob(installation.id)
      if (conflictingJob) {
        set.status = 409
        return {
          message: 'Another LaunchServer operation is already active for this installation.',
          jobId: conflictingJob.id,
        }
      }

      const job = jobs.create(
        'gravit.module.install',
        { ...input },
        `${item.name} module install queued`,
        async (context) => ({ ...(await management.install(installation, item, context)) }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({ installationId, moduleId }),
    },
  )
  .post(
    '/remove',
    ({ body, set }) => {
      const input = body as GravitModuleRemoveInput
      const installation = installations.get(input.installationId)
      if (!installation) {
        set.status = 404
        return { message: 'LauncherDockered installation not found.' }
      }

      const item = findCatalogModule(input.moduleId)
      if (!item) {
        set.status = 404
        return { message: 'Module is not present in the source-verified release catalog.' }
      }

      const conflictingJob = activeJob(installation.id)
      if (conflictingJob) {
        set.status = 409
        return {
          message: 'Another LaunchServer operation is already active for this installation.',
          jobId: conflictingJob.id,
        }
      }

      const job = jobs.create(
        'gravit.module.remove',
        { ...input },
        `${item.name} module removal queued`,
        async (context) => ({ ...(await management.remove(installation, item, context)) }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({ installationId, moduleId, confirmRemove: t.Literal(true) }),
    },
  )
  .post(
    '/discordauthsystem/build',
    ({ body, set }) => {
      const input = body as DiscordAuthSystemBuildInput
      const installation = installations.get(input.installationId)
      if (!installation) {
        set.status = 404
        return { message: 'LauncherDockered installation not found.' }
      }

      const conflictingJob = activeJob(installation.id)
      if (conflictingJob) {
        set.status = 409
        return {
          message: 'Another LaunchServer operation is already active for this installation.',
          jobId: conflictingJob.id,
        }
      }

      const job = jobs.create(
        'gravit.module.discordauthsystem.build',
        { ...input },
        'DiscordAuthSystem module Docker build queued',
        async (context) => {
          const result = await buildService.build(context, installation)
          context.progress(96, 'Restarting LaunchServer with the rebuilt DiscordAuthSystem module')
          await managedLifecycle.restartLaunchServer(installation, context)
          return { ...result }
        },
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({ installationId }),
    },
  )
}

export const modulesRoutes = createModulesRoutes({
  installations: installationsStore,
  jobs: jobsRunner,
  jobsStore,
  activeJob: activeJobForInstallation,
  management: moduleManagement,
})
