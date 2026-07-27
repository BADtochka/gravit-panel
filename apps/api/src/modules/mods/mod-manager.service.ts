import type {
  GravitInstallation,
  InstalledMod,
  ModInstallInput,
} from '@gravit-panel/shared'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import {
  ContainerVolumeService,
  type VolumeFileOperations,
} from '../docker/container-volume.service'
import type { ClientControlCommand, ControlFileService } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { ModrinthService, modrinthSource } from './modrinth.service'

const profilePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const filenamePattern = /^[^/\\\0]{1,255}\.jar(?:\.disabled)?$/
const safeTimestamp = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')

const sha1File = async (path: string) =>
  createHash('sha1').update(await readFile(path)).digest('hex')

export class ModManagerService {
  constructor(
    private readonly control: ControlFileService,
    private readonly modrinth: ModrinthService,
    private readonly volume: VolumeFileOperations = new ContainerVolumeService(),
  ) {}

  async list(installation: GravitInstallation, profile: string) {
    const directory = this.modsDirectory(installation, profile)
    try {
      if (!(await lstat(directory)).isDirectory()) {
        throw new Error('Profile mods path is not a directory')
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { items: [] as InstalledMod[], source: modrinthSource }
      }
      throw error
    }
    const files = (await readdir(directory))
      .filter((filename) => filename.endsWith('.jar') || filename.endsWith('.jar.disabled'))
      .sort()
    const local = await Promise.all(
      files.map(async (filename) => {
        const path = join(directory, filename)
        const metadata = await lstat(path)
        if (!metadata.isFile()) return null
        return {
          filename,
          disabled: filename.endsWith('.disabled'),
          size: metadata.size,
          sha1: await sha1File(path),
        }
      }),
    )
    const valid = local.filter((item): item is NonNullable<typeof item> => Boolean(item))
    const versions = await this.modrinth.versionsFromHashes(valid.map((item) => item.sha1))
    return {
      items: valid.map(
        (item): InstalledMod => ({
          ...item,
          projectId: versions[item.sha1]?.project_id ?? null,
          versionId: versions[item.sha1]?.id ?? null,
          versionName: versions[item.sha1]?.version_number ?? null,
        }),
      ),
      source: modrinthSource,
    }
  }

  async install(
    installation: GravitInstallation,
    input: ModInstallInput,
    context: JobTaskContext,
  ) {
    this.validateProfile(input.profile)
    context.progress(10, 'Verifying selected mods against Modrinth')
    const expectedProjects = await this.modrinth.assertInstallable(
      input.slugs,
      input.minecraftVersion,
      input.loader,
    )
    context.progress(35, `Installing ${input.slugs.length} selected mods through MirrorHelper`)
    const command =
      `installMods ${input.profile} ${input.minecraftVersion} ${input.loader.toLowerCase()} ${input.slugs.join(',')}` as ClientControlCommand
    const lines = await this.control.executeClientCommand(installation, command)
    lines.forEach(context.log)
    context.progress(90, 'Detecting installed mod files by hash')
    const state = await this.list(installation, input.profile)
    const detectedProjects = new Set(state.items.map((item) => item.projectId).filter(Boolean))
    const missing = expectedProjects.filter((item) => !detectedProjects.has(item.projectId))
    if (missing.length) {
      throw new Error(
        `MirrorHelper did not install the requested mods: ${missing.map((item) => item.slug).join(', ')}`,
      )
    }
    return {
      installationId: installation.id,
      profile: input.profile,
      installed: state.items,
      requestedSlugs: input.slugs,
      source: modrinthSource,
    }
  }

  async toggle(
    installation: GravitInstallation,
    profile: string,
    filename: string,
    enabled: boolean,
    context: JobTaskContext,
  ) {
    const directory = this.modsDirectory(installation, profile)
    const relativeDirectory = this.modsRelativeDirectory(profile)
    const current = this.safeFilename(filename)
    const source = join(directory, current)
    await this.assertRegularMod(source)
    const targetName = enabled
      ? current.replace(/\.disabled$/, '')
      : current.endsWith('.disabled')
        ? current
        : `${current}.disabled`
    if (source === join(directory, targetName)) {
      return { installationId: installation.id, profile, filename: targetName, enabled }
    }
    try {
      await lstat(join(directory, targetName))
      throw new Error(`Target mod file already exists: ${targetName}`)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await this.volume.move(
      installation,
      posix.join(relativeDirectory, current),
      posix.join(relativeDirectory, targetName),
    )
    context.log(`${enabled ? 'Enabled' : 'Disabled'} ${current}`)
    context.progress(95, 'Mod state updated')
    return { installationId: installation.id, profile, filename: targetName, enabled }
  }

  async remove(
    installation: GravitInstallation,
    profile: string,
    filename: string,
    context: JobTaskContext,
  ) {
    const directory = this.modsDirectory(installation, profile)
    const relativeDirectory = this.modsRelativeDirectory(profile)
    const safeName = this.safeFilename(filename)
    const trashRelativePath = posix.join(
      relativeDirectory,
      '.gravit-panel-trash',
      `${safeTimestamp()}-${crypto.randomUUID()}-${safeName}`,
    )
    const trashPath = join(installation.path, 'launcher', trashRelativePath)
    const sourcePath = join(directory, safeName)
    await this.assertRegularMod(sourcePath)
    await this.volume.move(
      installation,
      posix.join(relativeDirectory, safeName),
      trashRelativePath,
    )
    context.log(`Moved ${safeName} to recoverable trash: ${trashPath}`)
    context.progress(95, 'Mod removed from active profile')
    return { installationId: installation.id, profile, filename: safeName, trashPath }
  }

  async update(
    installation: GravitInstallation,
    profile: string,
    filename: string,
    minecraftVersion: string,
    loader: string,
    context: JobTaskContext,
  ) {
    const directory = this.modsDirectory(installation, profile)
    const relativeDirectory = this.modsRelativeDirectory(profile)
    const safeName = this.safeFilename(filename)
    const sourcePath = join(directory, safeName)
    await this.assertRegularMod(sourcePath)
    const hash = await sha1File(sourcePath)
    context.progress(15, 'Resolving latest compatible Modrinth version')
    const version = await this.modrinth.latestFromHash(hash, minecraftVersion, loader)
    if (!version) throw new Error('The selected file is not recognized by Modrinth')
    const file = version.files.find((item) => item.primary) ?? version.files[0]
    if (!file) throw new Error('Modrinth version does not contain a downloadable file')
    if (file.hashes.sha1 === hash) {
      context.progress(95, 'Mod is already current')
      return { installationId: installation.id, profile, filename: safeName, alreadyCurrent: true }
    }
    const downloadedName = this.safeFilename(file.filename)
    const targetName = safeName.endsWith('.disabled')
      ? `${downloadedName}.disabled`
      : downloadedName
    const targetPath = join(directory, targetName)
    if (targetPath !== sourcePath) {
      try {
        await lstat(targetPath)
        throw new Error(`Update target already exists: ${targetName}`)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    context.progress(45, `Downloading ${version.version_number}`)
    const bytes = await this.modrinth.download(file)
    const pendingRelativePath = posix.join(
      relativeDirectory,
      `.gravit-panel-${crypto.randomUUID()}.pending`,
    )
    await this.volume.writeFileAtomic(installation, pendingRelativePath, bytes, '0644')
    const backupRelativePath = posix.join(
      relativeDirectory,
      '.gravit-panel-trash',
      `${safeTimestamp()}-${crypto.randomUUID()}-${safeName}`,
    )
    const backupPath = join(installation.path, 'launcher', backupRelativePath)
    await this.volume.move(
      installation,
      posix.join(relativeDirectory, safeName),
      backupRelativePath,
    )
    try {
      await this.volume.move(
        installation,
        pendingRelativePath,
        posix.join(relativeDirectory, targetName),
      )
    } catch (error) {
      await this.volume.move(
        installation,
        backupRelativePath,
        posix.join(relativeDirectory, safeName),
      )
      await this.volume.remove(installation, pendingRelativePath)
      throw error
    }
    context.log(`Updated ${safeName} to ${targetName}; previous file: ${backupPath}`)
    context.progress(95, 'Mod update verified and installed')
    return {
      installationId: installation.id,
      profile,
      filename: targetName,
      versionId: version.id,
      versionName: version.version_number,
      previousFile: backupPath,
      source: modrinthSource,
    }
  }

  private modsDirectory(installation: GravitInstallation, profile: string) {
    return join(installation.path, 'launcher', this.modsRelativeDirectory(profile))
  }

  private modsRelativeDirectory(profile: string) {
    this.validateProfile(profile)
    return posix.join('updates', profile, 'mods')
  }

  private validateProfile(profile: string) {
    if (!profilePattern.test(profile)) throw new Error('Profile name contains unsupported characters')
  }

  private safeFilename(filename: string) {
    if (!filenamePattern.test(filename) || basename(filename) !== filename) {
      throw new Error('Unsafe mod filename')
    }
    return filename
  }

  private async assertRegularMod(path: string) {
    if (!(await lstat(path)).isFile()) throw new Error('Mod target must be a regular file')
  }
}
