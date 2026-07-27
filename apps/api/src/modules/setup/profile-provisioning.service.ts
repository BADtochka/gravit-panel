import type { GravitInstallation, RemoteControlSetupInput } from '@gravit-panel/shared'
import type { CredentialKeyService } from '../../core/credential-key.service'
import type { ClientBuildService } from '../clients/client-build.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import type { RemoteControlSetupService } from '../gravit/remote-control-setup.service'
import type { RemoteControlStore } from '../gravit/remote-control.store'

const stageContext = (
  context: JobTaskContext,
  start: number,
  end: number,
): JobTaskContext => ({
  signal: context.signal,
  log: context.log,
  progress: (progress, message) => {
    const mapped = start + Math.round((Math.max(0, Math.min(100, progress)) / 100) * (end - start))
    context.progress(mapped, message)
  },
})

export class ProfileProvisioningService {
  constructor(
    private readonly keyService: Pick<CredentialKeyService, 'status' | 'generate'>,
    private readonly remoteStore: Pick<RemoteControlStore, 'hasEncryptedCredentials'>,
    private readonly remoteSetup: Pick<RemoteControlSetupService, 'setup'>,
    private readonly clients: Pick<ClientBuildService, 'applyWorkspace' | 'installPrestarter'>,
  ) {}

  async prepare(
    installation: GravitInstallation,
    context: JobTaskContext,
  ) {
    context.progress(2, 'Preparing required panel integrations')
    if (!this.keyService.status.configured) {
      if (this.remoteStore.hasEncryptedCredentials()) {
        throw new Error(
          'Encrypted RemoteControl credentials already exist. Restore the original encryption key before setup.',
        )
      }
      await this.keyService.generate()
      context.log('Persistent credential encryption key generated')
    } else {
      context.log('Credential encryption key is ready')
    }

    const remoteInput: RemoteControlSetupInput = {
      installationId: installation.id,
      endpoint: `http://${installation.address}`,
      replaceExistingTokens: true,
    }
    const remoteControl = await this.remoteSetup.setup(
      installation,
      remoteInput,
      stageContext(context, 5, 40),
    )
    const workspace = await this.clients.applyWorkspace(
      installation,
      stageContext(context, 40, 75),
    )
    const prestarter = await this.clients.installPrestarter(
      installation,
      stageContext(context, 75, 100),
    )

    return {
      remoteControl,
      workspace,
      prestarter,
    }
  }
}
