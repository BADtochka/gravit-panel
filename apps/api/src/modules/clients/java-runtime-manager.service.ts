import type {
  GravitInstallation,
  JavaRuntimeArch,
  JavaRuntimeOs,
  JavaRuntimeState,
  LauncherBuildResult,
  ManagedJavaRuntime,
} from '@gravit-panel/shared'
import {
  ContainerVolumeService,
  type VolumeFileOperations,
} from '../docker/container-volume.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import {
  AdoptiumService,
  type TemurinRuntimeRequest,
} from './adoptium.service'
import type { LaunchServerLifecycle } from './client-build.service'

interface JavaVolumeOperations extends Pick<
  VolumeFileOperations,
  'exists' | 'readFile' | 'writeFileAtomic' | 'copy' | 'move' | 'remove'
> {
  extractZipToNewDirectory(
    installation: GravitInstallation,
    archiveRelativePath: string,
    targetRelativePath: string,
    stripSingleRoot?: boolean,
    maximumExpandedBytes?: number,
  ): Promise<void>
  extractTarGzToNewDirectory(
    installation: GravitInstallation,
    archiveRelativePath: string,
    targetRelativePath: string,
    stripSingleRoot?: boolean,
  ): Promise<void>
  prepareJavaRuntimePermissions(
    installation: GravitInstallation,
    relativePath: string,
  ): Promise<void>
}

interface LauncherBuilder {
  buildLauncher(
    installation: GravitInstallation,
    context: JobTaskContext,
  ): Promise<LauncherBuildResult>
}

interface LaunchServerConfig {
  launcher?: {
    customJavaDownload?: Record<string, unknown>
    forceUseCustomJava?: unknown
  }
}

export interface JavaRuntimeInstallInput {
  directory: string
  version: number
  build: number
  os: JavaRuntimeOs
  arch: JavaRuntimeArch
  javafx: boolean
  archiveFormat?: 'zip' | 'tar.gz'
}

export interface TemurinRuntimeInstallInput extends TemurinRuntimeRequest {
  directory: string
}

const directoryPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const descriptorPattern =
  /^Java (?<version>\d+) b(?<build>\d+) (?<os>mustdie|linux|macosx) (?<arch>X86|X86_64|ARM32|ARM64) javafx (?<javafx>true|false)$/
const configPath = 'LaunchServer.json'
const updatesDirectory = 'updates'
const safeTimestamp = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')

export class JavaRuntimeManagerService {
  constructor(
    private readonly lifecycle: LaunchServerLifecycle,
    private readonly builder: LauncherBuilder,
    private readonly volume: JavaVolumeOperations = new ContainerVolumeService(),
    private readonly adoptium: Pick<AdoptiumService, 'downloadLatest'> = new AdoptiumService(),
  ) {}

  async state(installation: GravitInstallation): Promise<JavaRuntimeState> {
    const { config } = await this.readConfig(installation)
    const entries = config.launcher?.customJavaDownload ?? {}
    const items = await Promise.all(
      Object.entries(entries).flatMap(([directory, value]) => {
        if (
          !directoryPattern.test(directory) ||
          typeof value !== 'string'
        ) return []
        const parsed = this.parseDescriptor(directory, value)
        if (!parsed) return []
        return [this.withInstalledState(installation, parsed)]
      }),
    )
    items.sort(
      (left, right) =>
        left.version - right.version ||
        left.os.localeCompare(right.os) ||
        left.arch.localeCompare(right.arch),
    )
    return {
      installationId: installation.id,
      forceUseCustomJava: config.launcher?.forceUseCustomJava === true,
      items,
    }
  }

  async repairRegisteredRuntimes(installation: GravitInstallation) {
    const { config } = await this.readConfig(installation)
    const entries = config.launcher?.customJavaDownload ?? {}
    const repaired: string[] = []
    for (const directory of Object.keys(entries)) {
      if (!directoryPattern.test(directory)) continue
      const target = `${updatesDirectory}/${directory}`
      if (!(await this.volume.exists(installation, target, 'directory'))) continue
      await this.volume.prepareJavaRuntimePermissions(installation, target)
      repaired.push(directory)
    }
    return repaired
  }

  async install(
    installation: GravitInstallation,
    input: JavaRuntimeInstallInput,
    archive: Uint8Array,
    context: JobTaskContext,
  ) {
    this.validateInput(input)
    if (!archive.length || archive.length > 300 * 1024 * 1024) {
      throw new Error('Java runtime archive must be between 1 byte and 300 MiB')
    }
    const target = `${updatesDirectory}/${input.directory}`
    const { raw, config } = await this.readConfig(installation)
    if (config.launcher?.customJavaDownload?.[input.directory] !== undefined) {
      throw new Error(`Java runtime ${input.directory} is already registered`)
    }
    if (await this.volume.exists(installation, target, 'directory')) {
      throw new Error(`Updates directory already exists: ${input.directory}`)
    }

    const archiveFormat = input.archiveFormat ?? 'zip'
    const archivePath = `.gravit-panel-java/${crypto.randomUUID()}.${archiveFormat}`
    const backupPath = `.gravit-panel-config-backups/LaunchServer.java-${safeTimestamp()}.json`
    let extracted = false
    try {
      context.progress(10, `Uploading ${input.directory}`)
      await this.volume.writeFileAtomic(installation, archivePath, archive, '0600')
      if (archiveFormat === 'tar.gz') {
        await this.volume.extractTarGzToNewDirectory(
          installation,
          archivePath,
          target,
          true,
        )
      } else {
        await this.volume.extractZipToNewDirectory(
          installation,
          archivePath,
          target,
          true,
          2 * 1024 * 1024 * 1024,
        )
      }
      extracted = true
      const executable = input.os === 'mustdie' ? 'bin/java.exe' : 'bin/java'
      if (!(await this.volume.exists(installation, `${target}/${executable}`))) {
        throw new Error(
          `Java archive must contain ${executable} at its root or inside one top-level directory`,
        )
      }
      await this.volume.prepareJavaRuntimePermissions(installation, target)

      await this.volume.copy(installation, configPath, backupPath)
      const next = this.withLauncher(config)
      next.launcher!.customJavaDownload![input.directory] = this.descriptor(input)
      await this.writeConfig(installation, next)
      const build = await this.reloadAndBuild(installation, context)
      context.progress(98, `Java runtime ${input.directory} installed`)
      return {
        state: await this.state(installation),
        build,
        backupPath,
      }
    } catch (error) {
      if (extracted) await this.volume.remove(installation, target, true)
      await this.volume.writeFileAtomic(
        installation,
        configPath,
        new TextEncoder().encode(raw),
        '0644',
      ).catch(() => {})
      await this.restoreRuntimeConfig(installation, context)
      throw error
    } finally {
      await this.volume.remove(installation, archivePath).catch(() => {})
    }
  }

  async installTemurin(
    installation: GravitInstallation,
    input: TemurinRuntimeInstallInput,
    context: JobTaskContext,
  ) {
    if (!directoryPattern.test(input.directory)) {
      throw new Error('Java runtime directory contains unsupported characters')
    }
    context.progress(
      5,
      `Resolving latest Temurin ${input.imageType.toUpperCase()} ${input.version}`,
    )
    const release = await this.adoptium.downloadLatest(input)
    context.progress(8, `Verified ${release.filename} from ${release.releaseName}`)
    const result = await this.install(
      installation,
      {
        directory: input.directory,
        version: input.version,
        build: release.build,
        os: input.os,
        arch: input.arch,
        javafx: false,
        archiveFormat: release.archiveFormat,
      },
      release.bytes,
      context,
    )
    return {
      ...result,
      source: {
        provider: 'Eclipse Temurin',
        imageType: input.imageType,
        releaseName: release.releaseName,
        filename: release.filename,
        sha256: release.sha256,
        url: release.sourceUrl,
      },
    }
  }

  async remove(
    installation: GravitInstallation,
    directory: string,
    context: JobTaskContext,
  ) {
    if (!directoryPattern.test(directory)) throw new Error('Invalid Java runtime directory')
    const { raw, config } = await this.readConfig(installation)
    if (config.launcher?.customJavaDownload?.[directory] === undefined) {
      throw new Error(`Java runtime ${directory} is not registered`)
    }
    const target = `${updatesDirectory}/${directory}`
    const trash = `.gravit-panel-java-trash/${safeTimestamp()}-${directory}`
    const installed = await this.volume.exists(installation, target, 'directory')
    const backupPath = `.gravit-panel-config-backups/LaunchServer.java-${safeTimestamp()}.json`
    await this.volume.copy(installation, configPath, backupPath)
    if (installed) await this.volume.move(installation, target, trash)
    try {
      const next = this.withLauncher(config)
      delete next.launcher!.customJavaDownload![directory]
      await this.writeConfig(installation, next)
      const build = await this.reloadAndBuild(installation, context)
      context.progress(98, `Java runtime ${directory} removed`)
      return {
        state: await this.state(installation),
        build,
        trashPath: installed ? trash : null,
        backupPath,
      }
    } catch (error) {
      await this.volume.writeFileAtomic(
        installation,
        configPath,
        new TextEncoder().encode(raw),
        '0644',
      ).catch(() => {})
      if (installed) await this.volume.move(installation, trash, target).catch(() => {})
      await this.restoreRuntimeConfig(installation, context)
      throw error
    }
  }

  async updateSettings(
    installation: GravitInstallation,
    forceUseCustomJava: boolean,
    context: JobTaskContext,
  ) {
    const { raw, config } = await this.readConfig(installation)
    const next = this.withLauncher(config)
    next.launcher!.forceUseCustomJava = forceUseCustomJava
    const backupPath = `.gravit-panel-config-backups/LaunchServer.java-${safeTimestamp()}.json`
    await this.volume.copy(installation, configPath, backupPath)
    await this.writeConfig(installation, next)
    try {
      const build = await this.reloadAndBuild(installation, context)
      return {
        state: await this.state(installation),
        build,
        backupPath,
      }
    } catch (error) {
      await this.volume.writeFileAtomic(
        installation,
        configPath,
        new TextEncoder().encode(raw),
        '0644',
      ).catch(() => {})
      await this.restoreRuntimeConfig(installation, context)
      throw error
    }
  }

  private async reloadAndBuild(
    installation: GravitInstallation,
    context: JobTaskContext,
  ) {
    context.progress(60, 'Reloading LaunchServer Java configuration')
    await this.volume.remove(installation, '.updates-cache')
    await this.lifecycle.restartLaunchServer(installation, context)
    context.progress(75, 'Rebuilding launcher with custom Java catalog')
    return this.builder.buildLauncher(installation, context)
  }

  private async restoreRuntimeConfig(
    installation: GravitInstallation,
    context: JobTaskContext,
  ) {
    await this.volume.remove(installation, '.updates-cache').catch(() => {})
    await this.lifecycle.restartLaunchServer(installation, context).catch(() => {})
  }

  private async readConfig(installation: GravitInstallation) {
    const raw = await this.volume.readFile!(installation, configPath)
    let config: LaunchServerConfig
    try {
      config = JSON.parse(raw) as LaunchServerConfig
    } catch (error) {
      throw new Error('LaunchServer.json contains invalid JSON', { cause: error })
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('LaunchServer.json has an invalid structure')
    }
    return { raw, config }
  }

  private withLauncher(config: LaunchServerConfig) {
    const launcher =
      config.launcher && typeof config.launcher === 'object'
        ? config.launcher
        : {}
    const customJavaDownload =
      launcher.customJavaDownload &&
      typeof launcher.customJavaDownload === 'object' &&
      !Array.isArray(launcher.customJavaDownload)
        ? { ...launcher.customJavaDownload }
        : {}
    return {
      ...config,
      launcher: {
        ...launcher,
        customJavaDownload,
      },
    }
  }

  private writeConfig(installation: GravitInstallation, config: LaunchServerConfig) {
    return this.volume.writeFileAtomic(
      installation,
      configPath,
      new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`),
      '0644',
    )
  }

  private descriptor(input: JavaRuntimeInstallInput) {
    return `Java ${input.version} b${input.build} ${input.os} ${input.arch} javafx ${input.javafx}`
  }

  private parseDescriptor(directory: string, descriptor: string): ManagedJavaRuntime | null {
    const match = descriptor.match(descriptorPattern)
    if (!match?.groups) return null
    return {
      directory,
      version: Number(match.groups.version),
      build: Number(match.groups.build),
      os: match.groups.os as JavaRuntimeOs,
      arch: match.groups.arch as JavaRuntimeArch,
      javafx: match.groups.javafx === 'true',
      descriptor,
      installed: false,
    }
  }

  private async withInstalledState(
    installation: GravitInstallation,
    item: ManagedJavaRuntime,
  ) {
    return {
      ...item,
      installed: await this.volume.exists(
        installation,
        `${updatesDirectory}/${item.directory}`,
        'directory',
      ),
    }
  }

  private validateInput(input: JavaRuntimeInstallInput) {
    if (!directoryPattern.test(input.directory)) {
      throw new Error('Java runtime directory contains unsupported characters')
    }
    if (!Number.isSafeInteger(input.version) || input.version < 8 || input.version > 99) {
      throw new Error('Java version must be between 8 and 99')
    }
    if (!Number.isSafeInteger(input.build) || input.build < 0 || input.build > 999_999) {
      throw new Error('Java build must be between 0 and 999999')
    }
  }
}
