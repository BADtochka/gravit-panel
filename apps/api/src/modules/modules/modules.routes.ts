import type { GravitModuleInstallInput, JobRecord } from '@gravit-panel/shared'
import { Elysia, t } from 'elysia'
import { ControlFileBusyError } from '../gravit/control-file.service'
import { installationsStore } from '../gravit/gravit.runtime'
import type { InstallationsStore } from '../gravit/installations.store'
import type { JobsRunner } from '../jobs/jobs.runner'
import type { JobsStore } from '../jobs/jobs.store'
import { activeJobForInstallation, jobsRunner, jobsStore } from '../jobs/jobs.runtime'
import { findCatalogModule, moduleCatalog } from './module-catalog'
import { moduleManagement } from './modules.runtime'

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
  management: Pick<typeof moduleManagement, 'getState' | 'install'>
}

export const createModulesRoutes = ({
  installations,
  jobs,
  jobsStore,
  activeJob,
  management,
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

      try {
        const items = await management.getState(installation, activeModuleJobs())
        return {
          installationId: installation.id,
          checkedAt: new Date().toISOString(),
          items,
        }
      } catch (error) {
        set.status = error instanceof ControlFileBusyError ? 409 : 503
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
          message: 'Another module operation is already active for this installation.',
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
}

export const modulesRoutes = createModulesRoutes({
  installations: installationsStore,
  jobs: jobsRunner,
  jobsStore,
  activeJob: activeJobForInstallation,
  management: moduleManagement,
})
