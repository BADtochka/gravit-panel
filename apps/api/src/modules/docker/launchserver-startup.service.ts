import type { GravitInstallation } from '@gravit-panel/shared'
import { logger } from '../../core/logger'
import type { InstallationsStore } from '../gravit/installations.store'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { LauncherDockeredService } from './launcherdockered.service'

type LaunchServerLifecycle = Pick<
  LauncherDockeredService,
  'checkLaunchServer' | 'restartLaunchServer'
>

const startupContext = (): JobTaskContext => ({
  signal: new AbortController().signal,
  log: (message) => logger.info(`[LaunchServer startup recovery] ${message}`),
  progress: (value, message) => logger.info(`[LaunchServer startup recovery] ${value}% ${message}`),
})

export class LaunchServerStartupService {
  constructor(
    private readonly installations: Pick<InstallationsStore, 'list'>,
    private readonly lifecycle: LaunchServerLifecycle,
  ) {}

  async recoverUnhealthyInstallations() {
    const installations = this.installations.list()
    for (const installation of installations) {
      await this.recoverInstallation(installation)
    }
  }

  private async recoverInstallation(installation: GravitInstallation) {
    const health = await this.lifecycle.checkLaunchServer(installation)
    if (health.status === 'healthy') {
      logger.info(`LaunchServer ${installation.name} is healthy at API startup`)
      return
    }

    logger.warn(`LaunchServer ${installation.name} is unhealthy at API startup; restarting`, {
      installationId: installation.id,
      reason: health.message,
    })
    try {
      await this.lifecycle.restartLaunchServer(installation, startupContext())
      logger.info(`LaunchServer ${installation.name} restarted successfully at API startup`)
    } catch (error) {
      logger.error(`LaunchServer ${installation.name} startup recovery failed`, error)
    }
  }
}
