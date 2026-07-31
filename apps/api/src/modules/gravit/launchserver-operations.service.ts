import type {
  GravitInstallation,
  LaunchServerCommandResult,
  LaunchServerInspectionCommand,
} from '@gravit-panel/shared'
import type { JobTaskContext } from '../jobs/jobs.runner'

interface InspectionTransport {
  execute(
    installation: GravitInstallation,
    command: LaunchServerInspectionCommand,
  ): Promise<LaunchServerCommandResult>
}

interface ProfileSyncControl {
  syncProfileProvider(installation: GravitInstallation): Promise<string[]>
}

export class LaunchServerOperationsService {
  constructor(
    private readonly transport: InspectionTransport,
    private readonly control: ProfileSyncControl,
  ) {}

  async inspect(
    installation: GravitInstallation,
    command: LaunchServerInspectionCommand,
    context: JobTaskContext,
  ) {
    context.progress(20, `Executing ${command}`)
    const result = await this.transport.execute(installation, command)
    context.log(`Transport: ${result.transport}`)
    if (result.fallbackReason) {
      context.log(`RemoteControl fallback: ${result.fallbackReason}`)
    }
    result.lines.forEach(context.log)
    context.progress(90, `${command} completed`)
    return { ...result }
  }

  async syncProfiles(installation: GravitInstallation, context: JobTaskContext) {
    context.progress(20, 'Synchronizing LaunchServer profiles and updates')
    const lines = await this.control.syncProfileProvider(installation)
    lines.forEach(context.log)
    context.progress(90, 'LaunchServer profiles and updates synchronized')

    return {
      installationId: installation.id,
      synchronized: true,
      lines,
    }
  }
}
