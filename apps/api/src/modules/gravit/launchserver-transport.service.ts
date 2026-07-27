import type {
  GravitInstallation,
  LaunchServerCommandResult,
  LaunchServerInspectionCommand,
} from '@gravit-panel/shared'
import type { RemoteControlCredential } from './remote-control.store'

interface ControlFileTransport {
  execute(
    installation: GravitInstallation,
    command: LaunchServerInspectionCommand,
  ): Promise<LaunchServerCommandResult>
}

interface RemoteControlTransport {
  execute(
    installation: GravitInstallation,
    credential: RemoteControlCredential,
    command: LaunchServerInspectionCommand,
  ): Promise<LaunchServerCommandResult>
}

interface CredentialReader {
  get(installationId: string): RemoteControlCredential | null
}

export class LaunchServerTransportService {
  constructor(
    private readonly controlFile: ControlFileTransport,
    private readonly remoteControl: RemoteControlTransport,
    private readonly credentials: CredentialReader,
  ) {}

  async execute(
    installation: GravitInstallation,
    command: LaunchServerInspectionCommand,
  ): Promise<LaunchServerCommandResult> {
    let credential: RemoteControlCredential | null
    try {
      credential = this.credentials.get(installation.id)
    } catch (error) {
      const fallback = await this.controlFile.execute(installation, command)
      return {
        ...fallback,
        fallbackReason: error instanceof Error ? error.message : String(error),
      }
    }
    if (!credential) return this.controlFile.execute(installation, command)

    try {
      return await this.remoteControl.execute(installation, credential, command)
    } catch (error) {
      const fallback = await this.controlFile.execute(installation, command)
      const reason = error instanceof Error ? error.message : String(error)
      return {
        ...fallback,
        fallbackReason: reason.replaceAll(credential.token, '[redacted]'),
      }
    }
  }
}
