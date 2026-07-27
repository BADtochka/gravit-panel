import { env } from '../../core/env'
import { ContainerVolumeService } from '../docker/container-volume.service'
import { LauncherDockeredService } from '../docker/launcherdockered.service'
import { controlFileService } from '../gravit/gravit.runtime'
import { ModuleManagementService } from './module-management.service'

export const moduleManagement = new ModuleManagementService(
  controlFileService,
  new ContainerVolumeService(),
  new LauncherDockeredService(env.INSTALLATIONS_ROOT),
)
