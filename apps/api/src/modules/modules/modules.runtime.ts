import { controlFileService } from '../gravit/gravit.runtime'
import { ModuleManagementService } from './module-management.service'

export const moduleManagement = new ModuleManagementService(controlFileService)
