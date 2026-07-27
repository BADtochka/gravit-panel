import type {
  GravitInstallation,
  GravitModuleCatalogItem,
  GravitModuleInstallResult,
  GravitModuleRuntimeItem,
  JobRecord,
} from '@gravit-panel/shared'
import type { ModuleControlCommand } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import {
  moduleCatalogItems,
  moduleCatalogSource,
  moduleRelease,
} from './module-catalog'

interface ModuleControlTransport {
  executeModuleCommand(
    installation: GravitInstallation,
    command: ModuleControlCommand,
  ): Promise<string[]>
}

export interface ModuleInstallProgress {
  checking: number
  loading: number
  verifying: number
  completed: number
}

const defaultInstallProgress: ModuleInstallProgress = {
  checking: 10,
  loading: 45,
  verifying: 75,
  completed: 95,
}

const normalized = (line: string) => line.toLowerCase()

const firstTokenAfter = (line: string, marker: string) => {
  const value = normalized(line)
  const markerIndex = value.indexOf(marker)
  if (markerIndex === -1) return null
  return value
    .slice(markerIndex + marker.length)
    .trim()
    .split(/\s+/, 1)[0] ?? null
}

const isAvailable = (item: GravitModuleCatalogItem, lines: string[]) => {
  const marker = item.kind === 'server' ? 'found launchserver module' : 'found launcher module'
  return lines.some((line) => firstTokenAfter(line, marker) === item.name.toLowerCase())
}

const isLoaded = (item: GravitModuleCatalogItem, lines: string[]) => {
  const marker = item.kind === 'server' ? '[module]' : '[launcher module]'
  const identity = item.kind === 'server' ? item.name.toLowerCase() : item.jar.toLowerCase()
  return lines.some((line) => firstTokenAfter(line, marker) === identity)
}

const pendingJobFor = (
  installationId: string,
  moduleId: string,
  activeJobs: JobRecord[],
) =>
  activeJobs.find(
    (job) =>
      job.type === 'gravit.module.install' &&
      job.input.installationId === installationId &&
      job.input.moduleId === moduleId,
  )?.id ?? null

export class ModuleManagementService {
  constructor(private readonly control: ModuleControlTransport) {}

  async getState(
    installation: GravitInstallation,
    activeJobs: JobRecord[] = [],
  ): Promise<GravitModuleRuntimeItem[]> {
    const availableLines = await this.control.executeModuleCommand(
      installation,
      'modules available',
    )
    const loadedLines = await this.control.executeModuleCommand(installation, 'modules list')

    return moduleCatalogItems.map((item) => ({
      id: item.id,
      available: isAvailable(item, availableLines),
      loaded: isLoaded(item, loadedLines),
      pendingJobId: pendingJobFor(installation.id, item.id, activeJobs),
    }))
  }

  async install(
    installation: GravitInstallation,
    item: GravitModuleCatalogItem,
    context: JobTaskContext,
    progress: ModuleInstallProgress = defaultInstallProgress,
  ): Promise<GravitModuleInstallResult> {
    context.progress(progress.checking, `Checking ${item.name} runtime availability`)
    const availableLines = await this.control.executeModuleCommand(
      installation,
      'modules available',
    )
    availableLines.forEach(context.log)
    if (!isAvailable(item, availableLines)) {
      throw new Error(
        `${item.name} is not available in this LaunchServer image; unsupported artifacts cannot be installed`,
      )
    }

    const beforeLoad = await this.control.executeModuleCommand(installation, 'modules list')
    beforeLoad.forEach(context.log)
    if (isLoaded(item, beforeLoad)) {
      context.progress(progress.completed, `${item.name} is already loaded`)
      return this.result(installation, item, this.loadCommand(item), true)
    }

    const command = this.loadCommand(item)
    context.progress(progress.loading, `Loading ${item.name} through LaunchServer`)
    const loadLines = await this.control.executeModuleCommand(installation, command)
    loadLines.forEach(context.log)

    context.progress(progress.verifying, `Verifying ${item.name} loaded state`)
    const afterLoad = await this.control.executeModuleCommand(installation, 'modules list')
    afterLoad.forEach(context.log)
    if (!isLoaded(item, afterLoad)) {
      throw new Error(`LaunchServer did not report ${item.name} as loaded`)
    }

    context.progress(progress.completed, `${item.name} loaded and persisted in modules.json`)
    return this.result(installation, item, command, false)
  }

  private loadCommand(item: GravitModuleCatalogItem): ModuleControlCommand {
    return item.kind === 'server'
      ? `modules load ${item.name}`
      : `modules launcher-load ${item.name}`
  }

  private result(
    installation: GravitInstallation,
    item: GravitModuleCatalogItem,
    command: ModuleControlCommand,
    alreadyLoaded: boolean,
  ): GravitModuleInstallResult {
    return {
      installationId: installation.id,
      moduleId: item.id,
      moduleName: item.name,
      kind: item.kind,
      command,
      alreadyLoaded,
      sourceRevision: moduleCatalogSource.revision,
      releaseTag: moduleRelease.tag,
    }
  }
}
