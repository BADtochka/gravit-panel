import type {
  GravitInstallation,
  LauncherRuntimeInstallResult,
} from '@gravit-panel/shared'
import {
  ContainerVolumeService,
  type VolumeFileOperations,
} from '../docker/container-volume.service'
import type {
  ControlFileService,
  ModuleControlCommand,
} from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { launcherRuntimeRelease } from './client-sources'
import {
  fetchVerifiedArtifact,
  type VerifiedArtifactFetcher,
} from './verified-artifact'

interface RuntimeControlTransport {
  executeModuleCommand(
    installation: GravitInstallation,
    command: ModuleControlCommand,
  ): Promise<string[]>
}

interface RuntimeVolumeOperations extends Pick<
  VolumeFileOperations,
  'exists' | 'writeFileAtomic' | 'move' | 'remove'
> {
  extractZipToNewDirectory(
    installation: GravitInstallation,
    archiveRelativePath: string,
    targetRelativePath: string,
  ): Promise<void>
}

const runtimeModuleLine = '[launcher module] javaruntime.jar'
const runtimeSentinels = [
  'runtime/runtime_en.properties',
  'runtime/scenes/login/login.fxml',
] as const
const isRuntimeLoaded = (lines: string[]) =>
  lines.some((line) => line.toLowerCase().startsWith(runtimeModuleLine))
const safeTimestamp = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')

export class LauncherRuntimeService {
  constructor(
    private readonly control: RuntimeControlTransport,
    private readonly volume: RuntimeVolumeOperations = new ContainerVolumeService(),
    private readonly artifactFetcher: VerifiedArtifactFetcher = fetchVerifiedArtifact,
  ) {}

  async ensureInstalled(
    installation: GravitInstallation,
    context: JobTaskContext,
  ): Promise<LauncherRuntimeInstallResult> {
    context.progress(5, `Checking LauncherRuntime ${launcherRuntimeRelease.tag}`)
    const [moduleExists, resourcesDirectoryExists, ...runtimeFiles] = await Promise.all([
      this.volume.exists(installation, launcherRuntimeRelease.module.filename),
      this.volume.exists(
        installation,
        launcherRuntimeRelease.resources.directory,
        'directory',
      ),
      ...runtimeSentinels.map((path) => this.volume.exists(installation, path)),
    ])
    const resourcesExist =
      resourcesDirectoryExists && runtimeFiles.every((present) => present)
    const alreadyInstalled = moduleExists && resourcesExist
    let moduleCreated = false
    let resourcesCreated = false
    let resourcesBackupPath: string | null = null
    const archivePath = `.gravit-panel-${launcherRuntimeRelease.resources.filename}`

    try {
      if (!moduleExists) {
        context.progress(10, `Downloading ${launcherRuntimeRelease.module.filename}`)
        const moduleBytes = await this.artifactFetcher(
          launcherRuntimeRelease.module.url,
          launcherRuntimeRelease.module.sha256,
          2 * 1024 * 1024,
        )
        await this.volume.writeFileAtomic(
          installation,
          launcherRuntimeRelease.module.filename,
          moduleBytes,
          '0644',
        )
        moduleCreated = true
        context.log(
          `Verified ${launcherRuntimeRelease.module.filename}: sha256:${launcherRuntimeRelease.module.sha256}`,
        )
      }

      if (!resourcesExist) {
        if (resourcesDirectoryExists) {
          resourcesBackupPath =
            `${launcherRuntimeRelease.resources.directory}.backup-${safeTimestamp()}`
          await this.volume.move(
            installation,
            launcherRuntimeRelease.resources.directory,
            resourcesBackupPath,
          )
          context.log(`Incomplete runtime snapshot created: ${resourcesBackupPath}`)
        }
        context.progress(15, `Downloading ${launcherRuntimeRelease.resources.filename}`)
        const resourcesBytes = await this.artifactFetcher(
          launcherRuntimeRelease.resources.url,
          launcherRuntimeRelease.resources.sha256,
          4 * 1024 * 1024,
        )
        await this.volume.writeFileAtomic(installation, archivePath, resourcesBytes, '0600')
        context.log(
          `Verified ${launcherRuntimeRelease.resources.filename}: sha256:${launcherRuntimeRelease.resources.sha256}`,
        )
        await this.volume.extractZipToNewDirectory(
          installation,
          archivePath,
          launcherRuntimeRelease.resources.directory,
        )
        resourcesCreated = true
        context.log(
          `LauncherRuntime resources installed: ${launcherRuntimeRelease.resources.directory}`,
        )
      }
    } catch (error) {
      if (resourcesCreated) {
        await this.volume.remove(
          installation,
          launcherRuntimeRelease.resources.directory,
          true,
        )
      }
      if (resourcesBackupPath) {
        await this.volume.move(
          installation,
          resourcesBackupPath,
          launcherRuntimeRelease.resources.directory,
        )
      }
      if (moduleCreated) {
        await this.volume.remove(installation, launcherRuntimeRelease.module.filename)
      }
      throw error
    } finally {
      await this.volume.remove(installation, archivePath)
    }

    context.progress(25, 'Checking LauncherRuntime module state')
    const beforeLoad = await this.control.executeModuleCommand(installation, 'modules list')
    beforeLoad.forEach(context.log)
    const alreadyLoaded = isRuntimeLoaded(beforeLoad)
    if (!alreadyLoaded) {
      const command =
        `modules launcher-load ${launcherRuntimeRelease.module.filename}` satisfies ModuleControlCommand
      const loadLines = await this.control.executeModuleCommand(installation, command)
      loadLines.forEach(context.log)
      const afterLoad = await this.control.executeModuleCommand(installation, 'modules list')
      afterLoad.forEach(context.log)
      if (!isRuntimeLoaded(afterLoad)) {
        throw new Error('LaunchServer did not report JavaRuntime.jar as loaded')
      }
    }

    context.progress(30, `LauncherRuntime ${launcherRuntimeRelease.tag} is ready`)
    return {
      repository: launcherRuntimeRelease.repository,
      tag: launcherRuntimeRelease.tag,
      revision: launcherRuntimeRelease.revision,
      compatibleLauncherVersion: launcherRuntimeRelease.compatibleLauncherVersion,
      moduleSha256: launcherRuntimeRelease.module.sha256,
      resourcesSha256: launcherRuntimeRelease.resources.sha256,
      alreadyInstalled,
      alreadyLoaded,
    }
  }
}

export type { RuntimeVolumeOperations }
