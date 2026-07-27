import type {
  JobRecord,
  LaunchServerInspectionCommand,
  RemoteControlSetupInput,
} from '@gravit-panel/shared'
import { Elysia, t } from 'elysia'
import type { CredentialCipher } from '../../core/credential-cipher'
import type { CredentialKeyService } from '../../core/credential-key.service'
import type { JobsRunner } from '../jobs/jobs.runner'
import { activeJobForInstallation, jobsRunner } from '../jobs/jobs.runtime'
import { launchServerCommands } from './commands'
import { ControlFileBusyError } from './control-file.service'
import {
  credentialCipher,
  credentialKeyService,
  installationsStore,
  launchServerTransport,
  remoteControlSetup,
  remoteControlStore,
} from './gravit.runtime'
import type { InstallationsStore } from './installations.store'
import type { LaunchServerTransportService } from './launchserver-transport.service'
import { remoteControlSource } from './remote-control-http.service'
import type { RemoteControlSetupService } from './remote-control-setup.service'
import type { RemoteControlStore } from './remote-control.store'

const installationBody = t.Object({
  installationId: t.String({ format: 'uuid' }),
})

export interface GravitRoutesDependencies {
  cipher: Pick<CredentialCipher, 'configured'>
  keyService: Pick<CredentialKeyService, 'status' | 'generate'>
  installations: Pick<InstallationsStore, 'get'>
  transport: Pick<LaunchServerTransportService, 'execute'>
  remoteSetup: Pick<RemoteControlSetupService, 'setup'>
  remoteStore: Pick<
    RemoteControlStore,
    'listConfiguredInstallationIds' | 'hasEncryptedCredentials'
  >
  jobs: Pick<JobsRunner, 'create'>
  activeJob: (installationId: string) => JobRecord | null | undefined
}

export const createGravitRoutes = ({
  cipher,
  keyService,
  installations,
  transport,
  remoteSetup,
  remoteStore,
  jobs,
  activeJob,
}: GravitRoutesDependencies) => {
  const executeInspection = async (
    installationId: string,
    command: LaunchServerInspectionCommand,
    set: { status?: number | string },
  ) => {
    const installation = installations.get(installationId)
    if (!installation) {
      set.status = 404
      return { message: 'LauncherDockered installation not found.' }
    }

    try {
      return await transport.execute(installation, command)
    } catch (error) {
      set.status = error instanceof ControlFileBusyError ? 409 : 503
      return {
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return new Elysia({ prefix: '/gravit' })
  .get('/commands', () => launchServerCommands)
  .get('/remote-control/configuration', () => ({
    encryptionConfigured: keyService.status.configured,
    encryptionSource: keyService.status.source,
    canGenerateEncryptionKey: keyService.status.canGenerate,
    configuredInstallationIds: remoteStore.listConfiguredInstallationIds(),
    allowedCommands: ['serverStatus', 'securitycheck'],
    source: remoteControlSource,
  }))
  .post(
    '/remote-control/encryption-key',
    async ({ set }) => {
      if (cipher.configured) {
        set.status = 409
        return { message: 'Credential encryption is already configured.' }
      }
      if (remoteStore.hasEncryptedCredentials()) {
        set.status = 409
        return {
          message:
            'Encrypted RemoteControl credentials already exist. Restore the original encryption key instead of generating a new one.',
        }
      }

      try {
        const status = await keyService.generate()
        set.status = 201
        return {
          encryptionConfigured: status.configured,
          encryptionSource: status.source,
          canGenerateEncryptionKey: status.canGenerate,
        }
      } catch (error) {
        set.status = 500
        return { message: error instanceof Error ? error.message : String(error) }
      }
    },
    {
      body: t.Object({
        confirmGeneration: t.Literal(true),
      }),
    },
  )
  .post(
    '/remote-control/setup',
    ({ body, set }) => {
      if (!cipher.configured) {
        set.status = 503
        return {
          message: 'Generate a credential encryption key in the panel before configuring RemoteControl.',
        }
      }
      const installation = installations.get(body.installationId)
      if (!installation) {
        set.status = 404
        return { message: 'LauncherDockered installation not found.' }
      }
      const conflictingJob = activeJob(installation.id)
      if (conflictingJob) {
        set.status = 409
        return {
          message: 'Another machine operation is already active for this installation.',
          jobId: conflictingJob.id,
        }
      }

      const input = body as RemoteControlSetupInput
      const job = jobs.create(
        'gravit.remote-control.setup',
        { ...input },
        'RemoteControl setup queued',
        async (context) => remoteSetup.setup(installation, input, context),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId: t.String({ format: 'uuid' }),
        endpoint: t.String({ minLength: 1, maxLength: 2_048 }),
        replaceExistingTokens: t.Literal(true),
      }),
    },
  )
  .post(
    '/status',
    ({ body, set }) => executeInspection(body.installationId, 'serverStatus', set),
    { body: installationBody },
  )
  .post(
    '/securitycheck',
    ({ body, set }) => executeInspection(body.installationId, 'securitycheck', set),
    { body: installationBody },
  )
}

export const gravitRoutes = createGravitRoutes({
  cipher: credentialCipher,
  keyService: credentialKeyService,
  installations: installationsStore,
  transport: launchServerTransport,
  remoteSetup: remoteControlSetup,
  remoteStore: remoteControlStore,
  jobs: jobsRunner,
  activeJob: activeJobForInstallation,
})
