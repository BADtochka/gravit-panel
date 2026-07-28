import type {
  LauncherDockeredInstallInput,
  LauncherDockeredInstallRequest,
  LauncherDockeredRemovalResult,
} from '@gravit-panel/shared'
import { Elysia, t } from 'elysia'
import { join } from 'node:path'
import { env } from '../../core/env'
import { clientBuildService } from '../clients/clients.routes'
import {
  credentialKeyService,
  installationsStore,
  remoteControlSetup,
  remoteControlStore,
} from '../gravit/gravit.runtime'
import type { InstallationsStore } from '../gravit/installations.store'
import type { JobsRunner } from '../jobs/jobs.runner'
import { activeJobForInstallation, jobsRunner } from '../jobs/jobs.runtime'
import { ProfileProvisioningService } from '../setup/profile-provisioning.service'
import {
  defaultLauncherPort,
  DockerPreflightService,
  launcherDockeredSource,
} from './docker.service'
import { LauncherDockeredService } from './launcherdockered.service'

const preflight = new DockerPreflightService()
const installer = new LauncherDockeredService(env.INSTALLATIONS_ROOT)
const provisioning = new ProfileProvisioningService(
  credentialKeyService,
  remoteControlStore,
  remoteControlSetup,
  clientBuildService,
  env.REMOTE_CONTROL_ENDPOINT,
)

const launchServerInstallationName = 'default'
const launchServerDisplayName = 'LaunchServer'

const launchServerFields = {
  address: t.String({ minLength: 1, maxLength: 255 }),
  projectName: t.String({
    minLength: 1,
    maxLength: 64,
    pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$',
  }),
}

export interface DockerRoutesDependencies {
  preflight: Pick<DockerPreflightService, 'run'>
  installer: Pick<
    LauncherDockeredService,
    'installationsRoot' | 'install' | 'removeInstallation'
  >
  installations: Pick<InstallationsStore, 'list' | 'upsert' | 'delete'>
  provisioning: Pick<ProfileProvisioningService, 'prepare'>
  jobs: Pick<JobsRunner, 'create' | 'hasActiveType'>
  activeJob: (installationId: string) => unknown
}

export const createDockerRoutes = ({
  preflight,
  installer,
  installations,
  provisioning,
  jobs,
  activeJob,
}: DockerRoutesDependencies) =>
  new Elysia({ prefix: '/docker' })
  .get(
    '/preflight',
    ({ query }) =>
      preflight.run(query.port ?? defaultLauncherPort, installations.list()),
    {
      query: t.Object({
        port: t.Optional(t.Numeric({ minimum: 1, maximum: 65_535 })),
      }),
    },
  )
  .get('/install/configuration', () => ({
    launchServerPath: join(installer.installationsRoot, launchServerInstallationName),
    defaultAddress: env.LAUNCHSERVER_PUBLIC_ADDRESS,
    source: launcherDockeredSource,
  }))
  .get('/launchserver', () => ({ item: installations.list()[0] ?? null }))
  .post(
    '/install',
    ({ body, set }) => {
      if (jobs.hasActiveType('docker.launcherdockered.install')) {
        set.status = 409
        return { message: 'A LaunchServer setup job is already active.' }
      }
      // One panel manages exactly one LaunchServer. Additional game clients
      // are created as profiles on that server, not as new installations.
      if (installations.list().length > 0) {
        set.status = 409
        return {
          message:
            'This panel manages a single LaunchServer. Remove the existing installation before creating another one.',
        }
      }

      const { confirmInstallation: _, ...requestInput } = body as LauncherDockeredInstallRequest
      const input: LauncherDockeredInstallInput = {
        ...requestInput,
        installationName: launchServerInstallationName,
      }
      const job = jobs.create(
        'docker.launcherdockered.install',
        { ...input, confirmInstallation: true },
        'LaunchServer setup queued',
        async (context) => {
          const installationContext = {
            signal: context.signal,
            log: context.log,
            progress: (progress: number, message: string) =>
              context.progress(Math.round(progress * 0.45), message),
          }
          const result = await installer.install(input, installationContext)
          const installation = installations.upsert(launchServerDisplayName, result)
          context.log(`LaunchServer registered: ${installation.id}`)
          try {
            const setup = await provisioning.prepare(installation, {
              signal: context.signal,
              log: context.log,
              progress: (progress, message) =>
                context.progress(45 + Math.round(progress * 0.5), message),
            })
            context.progress(98, 'LaunchServer setup completed')
            return { ...result, installationId: installation.id, setup }
          } catch (error) {
            installations.delete(installation.id)
            context.log('Incomplete LaunchServer registration removed')
            if (input.mode === 'clone') {
              try {
                await installer.removeInstallation(installation, context)
              } catch (cleanupError) {
                const reason = cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError)
                context.log(`Automatic installation cleanup failed: ${reason}`)
              }
            }
            throw error
          }
        },
      )
      set.status = 202
      return job
    },
    {
      body: t.Union([
        t.Object({
          mode: t.Literal('clone'),
          confirmInstallation: t.Literal(true),
          ...launchServerFields,
        }),
        t.Object({
          mode: t.Literal('import'),
          confirmInstallation: t.Literal(true),
          importPath: t.String({ minLength: 1, maxLength: 4_096 }),
          ...launchServerFields,
        }),
        t.Object({
          mode: t.Literal('attach'),
          confirmInstallation: t.Literal(true),
          importPath: t.String({ minLength: 1, maxLength: 4_096 }),
          ...launchServerFields,
        }),
      ]),
    },
  )
  .delete(
    '/launchserver',
    ({ set }) => {
      const installation = installations.list()[0]
      if (!installation) {
        set.status = 404
        return { message: 'LaunchServer is not configured.' }
      }
      if (activeJob(installation.id)) {
        set.status = 409
        return { message: 'Another operation is active for LaunchServer.' }
      }

      const job = jobs.create(
        'docker.launcherdockered.delete',
        {
          installationId: installation.id,
          installationName: installation.name,
          confirmDeletion: true,
        },
        `${installation.name} installation removal queued`,
        async (context) => {
          const removed = await installer.removeInstallation(installation, context)
          if (!installations.delete(installation.id)) {
            throw new Error('Installation files were removed but registration cleanup failed')
          }
          context.log(`Installation registration and encrypted credentials removed: ${installation.id}`)
          return {
            ...removed,
            registrationRemoved: true,
          } satisfies LauncherDockeredRemovalResult
        },
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({ confirmDeletion: t.Literal(true) }),
    },
  )

export const dockerRoutes = createDockerRoutes({
  preflight,
  installer,
  installations: installationsStore,
  provisioning,
  jobs: jobsRunner,
  activeJob: activeJobForInstallation,
})
