import type {
  GravitInstallation,
  GravitModuleCatalogItem,
  GravitModuleInstallResult,
  GravitModuleRemoveResult,
  GravitModuleRuntimeItem,
  JobRecord,
} from '@gravit-panel/shared'
import type { ModuleControlCommand } from '../gravit/control-file.service'
import type { VolumeFileOperations } from '../docker/container-volume.service'
import type { LauncherDockeredService } from '../docker/launcherdockered.service'
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

type ModuleVolumeOperations = Pick<
  VolumeFileOperations,
  'exists' | 'readFile' | 'writeFileAtomic' | 'move' | 'remove'
>

type ModuleLifecycle = Pick<LauncherDockeredService, 'restartLaunchServer'>

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

const isLocallyBuiltModule = (item: GravitModuleCatalogItem) =>
  item.id === 'DiscordAuthSystem_module'

const pendingJobFor = (
  installationId: string,
  moduleId: string,
  activeJobs: JobRecord[],
) =>
  activeJobs.find(
    (job) =>
      (job.type === 'gravit.module.install' || job.type === 'gravit.module.remove') &&
      job.input.installationId === installationId &&
      job.input.moduleId === moduleId,
  )?.id ?? null

export class ModuleManagementService {
  constructor(
    private readonly control: ModuleControlTransport,
    private readonly volume?: ModuleVolumeOperations,
    private readonly lifecycle?: ModuleLifecycle,
  ) {}

  async getState(
    installation: GravitInstallation,
    activeJobs: JobRecord[] = [],
  ): Promise<GravitModuleRuntimeItem[]> {
    const availableLines = await this.control.executeModuleCommand(
      installation,
      'modules available',
    )
    const loadedLines = await this.control.executeModuleCommand(installation, 'modules list')

    return Promise.all(moduleCatalogItems.map(async (item) => {
      const built = await this.isBuiltLocally(installation, item)
      return {
        id: item.id,
        available: isAvailable(item, availableLines) || built,
        built,
        loaded: isLoaded(item, loadedLines),
        pendingJobId: pendingJobFor(installation.id, item.id, activeJobs),
      }
    }))
  }

  async install(
    installation: GravitInstallation,
    item: GravitModuleCatalogItem,
    context: JobTaskContext,
    progress: ModuleInstallProgress = defaultInstallProgress,
  ): Promise<GravitModuleInstallResult> {
    context.progress(progress.checking, `Checking ${item.name} runtime availability`)
    if (isLocallyBuiltModule(item)) {
      if (!(await this.isBuiltLocally(installation, item))) {
        throw new Error(
          `${item.name} has not been built for this installation. Build and publish the module first.`,
        )
      }
      context.log(`Using locally built module JAR: modules/${item.jar}`)
    } else {
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

  async remove(
    installation: GravitInstallation,
    item: GravitModuleCatalogItem,
    context: JobTaskContext,
  ): Promise<GravitModuleRemoveResult> {
    if (!this.volume || !this.lifecycle || !this.volume.readFile) {
      throw new Error('Module removal service is not configured')
    }

    const jarPath = `modules/${item.jar}`
    const modulesConfigPath = 'modules.json'
    context.progress(10, `Checking ${item.name} module files`)
    if (!(await this.volume.exists(installation, jarPath))) {
      throw new Error(`${item.name} module JAR is not installed in this LaunchServer volume`)
    }

    const modulesConfig = await this.volume.readFile(installation, modulesConfigPath)
    const nextModulesConfig = this.withoutModuleReference(modulesConfig, item)
    const backupPath = `modules/.${item.jar}.remove-${crypto.randomUUID()}`

    context.progress(30, `Removing ${item.name} from LaunchServer startup configuration`)
    await this.volume.writeFileAtomic(
      installation,
      modulesConfigPath,
      new TextEncoder().encode(`${JSON.stringify(nextModulesConfig, null, 2)}\n`),
      '0644',
    )

    try {
      context.progress(45, `Staging ${item.jar} for removal`)
      await this.volume.move(installation, jarPath, backupPath)
    } catch (error) {
      await this.volume.writeFileAtomic(
        installation,
        modulesConfigPath,
        new TextEncoder().encode(modulesConfig),
        '0644',
      )
      throw error
    }

    try {
      context.progress(60, 'Restarting LaunchServer to unload the module')
      await this.lifecycle.restartLaunchServer(installation, context)
    } catch (error) {
      const recoveryErrors: string[] = []
      try {
        await this.volume.move(installation, backupPath, jarPath)
      } catch (recoveryError) {
        recoveryErrors.push(`JAR restore failed: ${this.errorMessage(recoveryError)}`)
      }
      try {
        await this.volume.writeFileAtomic(
          installation,
          modulesConfigPath,
          new TextEncoder().encode(modulesConfig),
          '0644',
        )
      } catch (recoveryError) {
        recoveryErrors.push(`modules.json restore failed: ${this.errorMessage(recoveryError)}`)
      }
      try {
        await this.lifecycle.restartLaunchServer(installation, context)
      } catch (recoveryError) {
        recoveryErrors.push(`recovery restart failed: ${this.errorMessage(recoveryError)}`)
      }
      const recoveryDetails = recoveryErrors.length ? ` Recovery issues: ${recoveryErrors.join('; ')}` : ''
      throw new Error(`Unable to remove ${item.name}; the previous module state was restored.${recoveryDetails}`, {
        cause: error,
      })
    }

    context.progress(92, `Finalizing ${item.name} removal`)
    await this.volume.remove(installation, backupPath)
    context.progress(95, `${item.name} removed and LaunchServer restarted`)
    return {
      installationId: installation.id,
      moduleId: item.id,
      moduleName: item.name,
      jar: item.jar,
      restarted: true,
    }
  }

  private loadCommand(item: GravitModuleCatalogItem): ModuleControlCommand {
    if (isLocallyBuiltModule(item)) {
      return `modules load /app/data/modules/${item.jar}`
    }
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

  private withoutModuleReference(config: string, item: GravitModuleCatalogItem) {
    let parsed: unknown
    try {
      parsed = JSON.parse(config)
    } catch (error) {
      throw new Error(`Unable to parse modules.json: ${this.errorMessage(error)}`, { cause: error })
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Unable to parse modules.json: expected an object')
    }

    const source = parsed as Record<string, unknown>
    const jarPath = `modules/${item.jar}`
    const references = new Set([item.id, item.name, item.jar, jarPath, `/app/data/${jarPath}`])
    const withoutReference = (value: unknown, key: string) => {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        throw new Error(`Unable to parse modules.json: ${key} must be an array of strings`)
      }
      return value.filter((entry) => !references.has(entry))
    }

    return {
      ...source,
      loadModules: withoutReference(source.loadModules ?? [], 'loadModules'),
      loadLauncherModules: withoutReference(source.loadLauncherModules ?? [], 'loadLauncherModules'),
    }
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }

  private async isBuiltLocally(installation: GravitInstallation, item: GravitModuleCatalogItem) {
    if (!isLocallyBuiltModule(item) || !this.volume) return false
    return this.volume.exists(installation, `modules/${item.jar}`)
  }
}
