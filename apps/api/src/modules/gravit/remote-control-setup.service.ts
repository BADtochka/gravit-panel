import type { GravitInstallation, RemoteControlSetupInput } from '@gravit-panel/shared'
import { join } from 'node:path'
import {
  ContainerVolumeService,
  type VolumeFileOperations,
} from '../docker/container-volume.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import type { ControlFileService } from './control-file.service'
import type { RemoteControlHttpService } from './remote-control-http.service'
import { remoteControlSource } from './remote-control-http.service'
import type { RemoteControlStore } from './remote-control.store'

const safeConfig = (token?: string) => ({
  list: token
    ? [
        {
          token,
          permissions: 0,
          allowAll: false,
          startWithMode: false,
          commands: ['serverStatus', 'securitycheck'],
        },
      ]
    : [],
  enabled: Boolean(token),
})

export class RemoteControlSetupService {
  constructor(
    private readonly controlFile: ControlFileService,
    private readonly http: RemoteControlHttpService,
    private readonly credentials: RemoteControlStore,
    private readonly volume: VolumeFileOperations = new ContainerVolumeService(),
  ) {}

  async setup(
    installation: GravitInstallation,
    input: RemoteControlSetupInput,
    context: JobTaskContext,
  ) {
    const endpoint = this.http.validateEndpoint(input.endpoint)
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const configRelativePath = 'config/RemoteControl/Config.json'
    let backupRelativePath: string | null = null
    let configWritten = false

    context.progress(5, 'RemoteControl setup request validated')
    const availableModules = await this.controlFile.executeSetupCommand(
      installation,
      'modules available',
    )
    availableModules.forEach(context.log)
    const remoteControlAvailable = availableModules.some((line) => {
      const value = line.toLowerCase()
      return value.includes('found launchserver module') && value.includes('remotecontrol')
    })
    if (!remoteControlAvailable) {
      throw new Error('RemoteControl is not available in this LaunchServer image')
    }
    context.progress(30, 'Bundled RemoteControl module artifact verified')

    if (await this.volume.exists(installation, configRelativePath)) {
      backupRelativePath = `${configRelativePath}.backup-${new Date().toISOString().replaceAll(':', '-')}`
      await this.volume.copy(installation, configRelativePath, backupRelativePath)
      context.log(
        `RemoteControl config snapshot created: ${join(installation.path, 'launcher', backupRelativePath)}`,
      )
    }

    try {
      await this.writeConfig(installation, configRelativePath, safeConfig(token))
      configWritten = true
      context.progress(50, 'Restricted RemoteControl token config written')

      const modules = await this.controlFile.executeSetupCommand(installation, 'modules list')
      modules.forEach(context.log)
      const alreadyLoaded = modules.some((line) => line.toLowerCase().includes('remotecontrol'))
      const command = alreadyLoaded ? 'remotecontrol reload' : 'modules load RemoteControl'
      const loadOutput = await this.controlFile.executeSetupCommand(installation, command)
      loadOutput.forEach(context.log)
      context.progress(70, 'RemoteControl module loaded with restricted token')

      await this.http.execute(installation, { endpoint, token }, 'serverStatus')
      context.progress(90, 'RemoteControl HTTP transport verified')

      this.credentials.save(installation.id, endpoint, token, remoteControlSource.revision)
      context.log('Encrypted RemoteControl credential stored')
      return {
        installationId: installation.id,
        endpoint,
        allowedCommands: ['serverStatus', 'securitycheck'],
        sourceRevision: remoteControlSource.revision,
        configBackupPath: backupRelativePath
          ? join(installation.path, 'launcher', backupRelativePath)
          : null,
      }
    } catch (error) {
      if (configWritten) {
        await this.writeConfig(installation, configRelativePath, safeConfig())
        this.credentials.delete(installation.id)
        context.log('RemoteControl disabled and token list cleared after setup failure')
        try {
          const output = await this.controlFile.executeSetupCommand(
            installation,
            'remotecontrol reload',
          )
          output.forEach(context.log)
        } catch {
          context.log('RemoteControl config will remain disabled on the next module load')
        }
      }
      throw error
    }
  }

  private async writeConfig(
    installation: GravitInstallation,
    relativePath: string,
    value: ReturnType<typeof safeConfig>,
  ) {
    await this.volume.writeFileAtomic(
      installation,
      relativePath,
      new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
      '0600',
    )
  }
}
