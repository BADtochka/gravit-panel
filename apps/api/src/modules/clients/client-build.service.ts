import type {
  ClientBuildInput,
  ClientBuildResult,
  ClientPreparationState,
  ClientProfileDescriptor,
  ClientProfileJavaUpdateInput,
  ClientProfileRemoveInput,
  ClientProfileRemoveResult,
  ClientProfileState,
  ClientProfileUpdateInput,
  ClientProfileUpdateResult,
  GravitInstallation,
  LauncherArtifact,
  LauncherBuildResult,
  LauncherCustomizationAsset,
  LauncherCustomizationResult,
  LauncherCustomizationState,
  LauncherRuntimeInstallResult,
  OptionalMod,
  PrestarterInstallResult,
  ProfileServer,
  WorkspaceApplyResult,
} from '@gravit-panel/shared'
import {
  lstat,
  readFile,
} from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import type {
  BuildControlCommand,
  ClientControlCommand,
  ControlFileService,
} from '../gravit/control-file.service'
import {
  ContainerVolumeService,
  type VolumeFileOperations,
} from '../docker/container-volume.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { findCatalogModule } from '../modules/module-catalog'
import { ModuleManagementService } from '../modules/module-management.service'
import { resolveClientCompatibility } from './compatibility.service'
import {
  launcherBuildSource,
  launcherRuntimeRelease,
  mirrorHelperSource,
  prestarterRelease,
  workspaceManifest,
} from './client-sources'
import { LauncherRuntimeService } from './launcher-runtime.service'
import {
  fetchVerifiedArtifact,
  sha256Bytes,
  type VerifiedArtifactFetcher,
} from './verified-artifact'
import {
  LoaderInstallerService,
  type LoaderInstallerProvider,
} from './loader-installer.service'
import {
  MinecraftAssetsService,
  type MinecraftAssetsProvider,
} from './minecraft-assets.service'

export interface LaunchServerLifecycle {
  restartLaunchServer(
    installation: GravitInstallation,
    context: JobTaskContext,
  ): Promise<void>
}

const safeTimestamp = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const profilePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const assetPathSegmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const versionPattern = /^[0-9]+(?:\.[0-9]+){1,3}$/
const modPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/
const mirrorHelperModule = (() => {
  const item = findCatalogModule('MirrorHelper_module')
  if (!item) throw new Error('MirrorHelper is missing from the verified module catalog')
  return item
})()
const prestarterModule = (() => {
  const item = findCatalogModule('Prestarter_module')
  if (!item) throw new Error('Prestarter is missing from the verified module catalog')
  return item
})()
const customizationManifestPath = '.gravit-panel-launcher-customization.json'
const customizationAssets = {
  logo: {
    path: 'runtime/images/logo.png',
    maxBytes: 2 * 1024 * 1024,
  },
  background: {
    path: 'runtime/images/background.png',
    maxBytes: 8 * 1024 * 1024,
  },
  favicon: {
    path: 'runtime/favicon.png',
    maxBytes: 2 * 1024 * 1024,
  },
} as const
type LauncherCustomizationAssetId = keyof typeof customizationAssets
const launcherRuntimeReleaseSource = () => ({
  repository: launcherRuntimeRelease.repository,
  revision: launcherRuntimeRelease.revision,
  file: 'runtime',
})
export type LauncherCustomizationFiles = Partial<
  Record<LauncherCustomizationAssetId, Uint8Array>
>

const exists = async (path: string) => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

const launcherRoot = (installation: GravitInstallation) => join(installation.path, 'launcher')

interface LaunchProfileConfig {
  uuid?: unknown
  title?: unknown
  info?: unknown
  dir?: unknown
  sortIndex?: unknown
  servers?: unknown
  version?: unknown
  mainClass?: unknown
  clientArgs?: unknown
  classPath?: unknown
  assetDir?: unknown
  assetIndex?: unknown
  updateOptional?: unknown
  recommendJavaVersion?: unknown
  minJavaVersion?: unknown
  maxJavaVersion?: unknown
}

interface LaunchProfileServer {
  name?: unknown
  serverAddress?: unknown
  serverPort?: unknown
  isDefault?: unknown
  protocol?: unknown
  socketPing?: unknown
}

const optionalFileAction = (item: Record<string, unknown>) => {
  if (!Array.isArray(item.actions)) return null
  for (const action of item.actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) continue
    const files = (action as Record<string, unknown>).files
    if (!files || typeof files !== 'object' || Array.isArray(files)) continue
    for (const [sourcePath, destination] of Object.entries(files)) {
      if (
        sourcePath.startsWith('.gravit-panel-optional/') &&
        typeof destination === 'string'
      ) {
        return {
          sourcePath,
          filename: basename(destination),
          destinationPath: destination,
        }
      }
    }
  }
  return null
}

const optionalProjectId = (item: Record<string, unknown>) => {
  const file = optionalFileAction(item)
  if (!file) return null
  const parts = file.sourcePath.split('/')
  const marker = parts.indexOf('mods')
  return marker >= 0 && parts[marker + 1] ? parts[marker + 1] : null
}

const profileUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const profileDescriptor = (
  name: string,
  profile: LaunchProfileConfig,
): ClientProfileDescriptor => ({
  name,
  uuid:
    typeof profile.uuid === 'string' && profileUuidPattern.test(profile.uuid)
      ? profile.uuid
      : null,
  title:
    typeof profile.title === 'string' && profile.title.trim()
      ? profile.title
      : name,
  description: typeof profile.info === 'string' ? profile.info : '',
  sortIndex:
    typeof profile.sortIndex === 'number' && Number.isSafeInteger(profile.sortIndex)
      ? profile.sortIndex
      : 0,
  minecraftVersion:
    typeof profile.version === 'string' && versionPattern.test(profile.version)
      ? profile.version
      : null,
  loader: inferProfileLoader(profile),
  loaderVersion: inferProfileLoaderVersion(profile),
  recommendJavaVersion:
    typeof profile.recommendJavaVersion === 'number' &&
    Number.isSafeInteger(profile.recommendJavaVersion)
      ? profile.recommendJavaVersion
      : 8,
  minJavaVersion:
    typeof profile.minJavaVersion === 'number' && Number.isSafeInteger(profile.minJavaVersion)
      ? profile.minJavaVersion
      : 8,
  maxJavaVersion:
    typeof profile.maxJavaVersion === 'number' && Number.isSafeInteger(profile.maxJavaVersion)
      ? profile.maxJavaVersion
      : 999,
  servers: parseProfileServers(profile.servers),
})

const parseProfileServers = (value: unknown): ClientProfileDescriptor['servers'] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const server = item as LaunchProfileServer
    if (
      typeof server.name !== 'string' ||
      !server.name.trim() ||
      typeof server.serverAddress !== 'string' ||
      !server.serverAddress.trim() ||
      typeof server.serverPort !== 'number' ||
      !Number.isSafeInteger(server.serverPort) ||
      server.serverPort < 1 ||
      server.serverPort > 65_535
    ) return []
    return [{
      name: server.name,
      serverAddress: server.serverAddress,
      serverPort: server.serverPort,
      isDefault: server.isDefault === true,
      protocol:
        typeof server.protocol === 'number' && Number.isSafeInteger(server.protocol)
          ? server.protocol
          : -1,
      socketPing: server.socketPing !== false,
    }]
  })
}

const profileAssetIndexPath = (profile: LaunchProfileConfig) => {
  const assetDir =
    typeof profile.assetDir === 'string' &&
    assetPathSegmentPattern.test(profile.assetDir)
      ? profile.assetDir
      : null
  const assetIndex =
    typeof profile.assetIndex === 'string' &&
    assetPathSegmentPattern.test(profile.assetIndex)
      ? profile.assetIndex
      : null
  if (!assetDir || !assetIndex) return null
  return join('updates', assetDir, 'indexes', `${assetIndex}.json`)
}

export const inferProfileLoader = (
  profile: LaunchProfileConfig,
): ClientProfileDescriptor['loader'] => {
  const mainClass = typeof profile.mainClass === 'string' ? profile.mainClass : ''
  const clientArgs = Array.isArray(profile.clientArgs)
    ? profile.clientArgs.filter((item): item is string => typeof item === 'string')
    : []
  const classPath = Array.isArray(profile.classPath)
    ? profile.classPath.filter((item): item is string => typeof item === 'string')
    : []
  const signals = [mainClass, ...clientArgs, ...classPath].join('\n').toLowerCase()

  if (
    signals.includes('org.quiltmc.loader') ||
    signals.includes('quilt-loader') ||
    signals.includes('quilt_loader')
  ) return 'QUILT'
  if (
    signals.includes('--fml.neoforgeversion') ||
    signals.includes('/net/neoforged/') ||
    signals.includes('net.neoforged.')
  ) return 'NEOFORGE'
  if (
    signals.includes('net.fabricmc.loader') ||
    signals.includes('/net/fabricmc/fabric-loader/')
  ) return 'FABRIC'
  if (
    signals.includes('--fml.forgeversion') ||
    signals.includes('/net/minecraftforge/forge/') ||
    signals.includes('net.minecraftforge.')
  ) return 'FORGE'
  return 'VANILLA'
}

export const inferProfileLoaderVersion = (
  profile: LaunchProfileConfig,
): string | null => {
  const values = [
    ...(Array.isArray(profile.classPath) ? profile.classPath : []),
    ...(Array.isArray(profile.clientArgs) ? profile.clientArgs : []),
  ].filter((value): value is string => typeof value === 'string')
  const joined = values.join('\n')
  const patterns = [
    /fabric-loader[/:\\]([0-9][0-9A-Za-z.+_-]*)/i,
    /net[/:\\]neoforged[/:\\]neoforge[/:\\]([0-9][0-9A-Za-z.+_-]*)/i,
    /net[/:\\]minecraftforge[/:\\]forge[/:\\](?:[0-9.]+-)?([0-9][0-9A-Za-z.+_-]*)/i,
    /--fml\.neoForgeVersion(?:=|\s+)([0-9][0-9A-Za-z.+_-]*)/i,
    /--fml\.forgeVersion(?:=|\s+)([0-9][0-9A-Za-z.+_-]*)/i,
  ]
  for (const pattern of patterns) {
    const match = joined.match(pattern)
    if (match?.[1]) return match[1]
  }
  return inferProfileLoader(profile) === 'VANILLA' ? null : null
}

const assertInside = (root: string, path: string) => {
  const child = relative(resolve(root), resolve(path))
  if (child.startsWith('..') || child === '') {
    throw new Error('Resolved artifact path escapes the Launcher data directory')
  }
  return path
}

interface LaunchServerLocalConfig {
  updatesProvider?: {
    updatesDir?: string
    binaryName?: string
  }
}

export class ClientBuildService {
  constructor(
    private readonly control: ControlFileService,
    private readonly volume: VolumeFileOperations = new ContainerVolumeService(),
    private readonly modules: Pick<ModuleManagementService, 'install'> =
      new ModuleManagementService(control),
    private readonly artifactFetcher: VerifiedArtifactFetcher = fetchVerifiedArtifact,
    private readonly runtime: Pick<LauncherRuntimeService, 'ensureInstalled'> =
      new LauncherRuntimeService(control),
    private readonly loaderInstallers: LoaderInstallerProvider =
      new LoaderInstallerService(),
    private readonly lifecycle?: LaunchServerLifecycle,
    private readonly minecraftAssets: MinecraftAssetsProvider =
      new MinecraftAssetsService(),
  ) {}

  compatibility(minecraftVersion: string) {
    this.validateVersion(minecraftVersion)
    return resolveClientCompatibility(minecraftVersion)
  }

  async preparationState(
    installation: GravitInstallation,
  ): Promise<ClientPreparationState> {
    const [workspaceDirectory, workspaceDigest, prestarterDigest, artifacts] =
      await Promise.all([
        this.volume.exists(
          installation,
          'config/MirrorHelper/workspace',
          'directory',
        ),
        this.volume.sha256?.(
          installation,
          'config/MirrorHelper/workspace.panel.json',
        ) ?? Promise.resolve(null),
        this.volume.sha256?.(installation, prestarterRelease.asset) ??
          Promise.resolve(null),
        this.listLauncherArtifacts(installation),
      ])
    return {
      installationId: installation.id,
      workspaceApplied:
        workspaceDirectory && workspaceDigest === workspaceManifest.sha256,
      prestarterInstalled: prestarterDigest === prestarterRelease.sha256,
      launcherBuilt: artifacts.length > 0,
    }
  }

  async profileState(
    installation: GravitInstallation,
    name: string,
  ): Promise<ClientProfileState> {
    this.validateProfile(name)
    const [hasProfile, hasUpdates] = await Promise.all([
      this.volume.exists(installation, join('profiles', `${name}.json`)),
      this.volume.exists(installation, join('updates', name), 'directory'),
    ])
    return {
      installationId: installation.id,
      name,
      built: hasProfile && hasUpdates,
    }
  }

  async listProfiles(
    installation: GravitInstallation,
  ): Promise<{ items: ClientProfileDescriptor[] }> {
    if (!this.volume.listFiles || !this.volume.readFile) {
      throw new Error('Container volume profile discovery is unavailable')
    }
    const files = (await this.volume.listFiles(installation, 'profiles'))
      .filter((file) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(file))

    const items = await Promise.all(files.map(async (file): Promise<ClientProfileDescriptor> => {
      const name = file.slice(0, -'.json'.length)
      try {
        const profile = JSON.parse(
          await this.volume.readFile!(installation, join('profiles', file)),
        ) as LaunchProfileConfig
        return profileDescriptor(name, profile)
      } catch {
        return {
          name,
          uuid: null,
          title: name,
          description: '',
          sortIndex: 0,
          minecraftVersion: null,
          loader: null,
          loaderVersion: null,
          recommendJavaVersion: 8,
          minJavaVersion: 8,
          maxJavaVersion: 999,
          servers: [],
        }
      }
    }))
    items.sort(
      (left, right) =>
        left.sortIndex - right.sortIndex ||
        left.title.localeCompare(right.title) ||
        left.name.localeCompare(right.name),
    )
    return { items }
  }

  async getProfile(
    installation: GravitInstallation,
    name: string,
  ): Promise<ClientProfileDescriptor> {
    this.validateProfile(name)
    const current = await this.readProfileConfig(installation, name)
    return profileDescriptor(name, current.profile)
  }

  async replaceProfileServers(
    installation: GravitInstallation,
    name: string,
    servers: ProfileServer[],
    context: JobTaskContext,
  ): Promise<{ profile: ClientProfileDescriptor; backupPath: string }> {
    this.validateProfile(name)
    const path = join('profiles', `${name}.json`)
    const current = await this.readProfileConfig(installation, name)
    const backupRelativePath = join(
      '.gravit-panel-profile-backups',
      `${name}.servers-${safeTimestamp()}.json`,
    )
    await this.volume.copy(installation, path, backupRelativePath)
    context.progress(25, `Snapshotting ${name} server list`)
    const next = { ...current.profile, servers }
    await this.volume.writeFileAtomic(
      installation,
      path,
      new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
      '0644',
    )
    try {
      await this.reloadProfilesAndUpdates(installation, context, 65)
    } catch (error) {
      await this.volume.writeFileAtomic(
        installation,
        path,
        new TextEncoder().encode(current.raw),
        '0644',
      )
      await this.reloadProfilesAndUpdates(installation, context, 80).catch(() => {})
      throw error
    }
    return {
      profile: profileDescriptor(name, next),
      backupPath: join(launcherRoot(installation), backupRelativePath),
    }
  }

  async upsertOptionalMods(
    installation: GravitInstallation,
    name: string,
    inputs: Array<{
      projectId: string
      title: string
      filename: string
      sourcePath: string
      destinationPath?: string
      enabledByDefault?: boolean
      description?: string
      category?: string
    }>,
    context: JobTaskContext,
  ) {
    this.validateProfile(name)
    const path = join('profiles', `${name}.json`)
    const current = await this.readProfileConfig(installation, name)
    const existing = Array.isArray(current.profile.updateOptional)
      ? current.profile.updateOptional.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item && typeof item === 'object' && !Array.isArray(item)),
        )
      : []
    const projectIds = new Set(inputs.map((input) => input.projectId))
    const nextOptional = existing.filter(
      (item) => {
        const projectId = optionalProjectId(item)
        return !projectId || !projectIds.has(projectId)
      },
    )
    const usedNames = new Set(
      nextOptional.flatMap((item) =>
        typeof item.name === 'string' ? [item.name.toLowerCase()] : []),
    )
    for (const input of inputs) {
      const requestedTitle = input.title.trim() || input.projectId
      let title = requestedTitle
      if (usedNames.has(title.toLowerCase())) {
        title = `${requestedTitle} (${input.projectId.slice(0, 8)})`
      }
      usedNames.add(title.toLowerCase())
      nextOptional.push({
        name: title,
        info: input.description ?? '',
        category: input.category ?? 'Mods',
        visible: true,
        mark: input.enabledByDefault ?? false,
        actions: [{
          type: 'file',
          files: {
            [input.sourcePath]: input.destinationPath ?? `mods/${input.filename}`,
          },
        }],
      })
    }
    const next = { ...current.profile, updateOptional: nextOptional }
    const backupRelativePath = join(
      '.gravit-panel-profile-backups',
      `${name}.optional-${safeTimestamp()}.json`,
    )
    await this.volume.copy(installation, path, backupRelativePath)
    await this.volume.writeFileAtomic(
      installation,
      path,
      new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
      '0644',
    )
    try {
      await this.reloadProfilesAndUpdates(installation, context, 80)
    } catch (error) {
      await this.volume.writeFileAtomic(
        installation,
        path,
        new TextEncoder().encode(current.raw),
        '0644',
      )
      await this.reloadProfilesAndUpdates(installation, context, 90).catch(() => {})
      throw error
    }
    return { profile: profileDescriptor(name, next) }
  }

  async upsertOptionalMod(
    installation: GravitInstallation,
    name: string,
    input: {
      projectId: string
      title: string
      filename: string
      sourcePath: string
      destinationPath?: string
      enabledByDefault?: boolean
      description?: string
      category?: string
    },
    context: JobTaskContext,
  ) {
    return this.upsertOptionalMods(installation, name, [input], context)
  }

  async listOptionalMods(
    installation: GravitInstallation,
    name: string,
  ): Promise<{ items: OptionalMod[] }> {
    this.validateProfile(name)
    const current = await this.readProfileConfig(installation, name)
    const optional = Array.isArray(current.profile.updateOptional)
      ? current.profile.updateOptional
      : []
    return {
      items: optional.flatMap((value): OptionalMod[] => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return []
        const item = value as Record<string, unknown>
        const projectId = optionalProjectId(item)
        const file = optionalFileAction(item)
        if (!projectId || !file) return []
        return [{
          projectId,
          name: typeof item.name === 'string' ? item.name : file.filename,
          description: typeof item.info === 'string' ? item.info : '',
          category: typeof item.category === 'string' ? item.category : 'Mods',
          enabledByDefault: item.mark === true,
          filename: file.filename,
          sourcePath: file.sourcePath,
          destinationPath: file.destinationPath,
        }]
      }),
    }
  }

  async updateOptionalMod(
    installation: GravitInstallation,
    name: string,
    input: {
      projectId: string
      title: string
      description: string
      category: string
      enabledByDefault: boolean
    },
    context: JobTaskContext,
  ) {
    const current = await this.readProfileConfig(installation, name)
    const title = input.title.trim()
    const description = input.description.trim()
    const category = input.category.trim()
    if (!title || title.length > 80) throw new Error('Optional mod name must be 1-80 characters')
    if (description.length > 500) throw new Error('Optional mod description is too long')
    if (!category || category.length > 40) {
      throw new Error('Optional mod category must be 1-40 characters')
    }
    const optional = Array.isArray(current.profile.updateOptional)
      ? current.profile.updateOptional
      : []
    if (optional.some((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const item = value as Record<string, unknown>
      return optionalProjectId(item) !== input.projectId &&
        typeof item.name === 'string' &&
        item.name.toLowerCase() === title.toLowerCase()
    })) throw new Error('Another optional mod already uses this name')
    let found = false
    const nextOptional = optional.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      const item = value as Record<string, unknown>
      if (optionalProjectId(item) !== input.projectId) return item
      found = true
      return {
        ...item,
        name: title,
        info: description,
        category,
        mark: input.enabledByDefault,
      }
    })
    if (!found) throw new Error('Optional mod was not found in this profile')
    await this.writeOptionalProfile(
      installation,
      name,
      current,
      nextOptional,
      context,
    )
    return this.listOptionalMods(installation, name)
  }

  async removeOptionalMod(
    installation: GravitInstallation,
    name: string,
    projectId: string,
    context: JobTaskContext,
  ) {
    const current = await this.readProfileConfig(installation, name)
    const optional = Array.isArray(current.profile.updateOptional)
      ? current.profile.updateOptional
      : []
    const removed = optional.find(
      (value) =>
        Boolean(value && typeof value === 'object' && optionalProjectId(
          value as Record<string, unknown>,
        ) === projectId),
    )
    if (!removed || typeof removed !== 'object') {
      throw new Error('Optional mod was not found in this profile')
    }
    const file = optionalFileAction(removed as Record<string, unknown>)
    const nextOptional = optional.filter(
      (value) =>
        !value ||
        typeof value !== 'object' ||
        optionalProjectId(value as Record<string, unknown>) !== projectId,
    )
    await this.writeOptionalProfile(
      installation,
      name,
      current,
      nextOptional,
      context,
    )
    if (file) {
      await this.volume.remove(
        installation,
        join('updates', name, file.sourcePath),
      )
    }
    return { projectId }
  }

  private async writeOptionalProfile(
    installation: GravitInstallation,
    name: string,
    current: { profile: LaunchProfileConfig; raw: string },
    updateOptional: unknown[],
    context: JobTaskContext,
  ) {
    const path = join('profiles', `${name}.json`)
    const backupRelativePath = join(
      '.gravit-panel-profile-backups',
      `${name}.optional-${safeTimestamp()}.json`,
    )
    await this.volume.copy(installation, path, backupRelativePath)
    await this.volume.writeFileAtomic(
      installation,
      path,
      new TextEncoder().encode(`${JSON.stringify({
        ...current.profile,
        updateOptional,
      }, null, 2)}\n`),
      '0644',
    )
    try {
      await this.reloadProfilesAndUpdates(installation, context, 80)
    } catch (error) {
      await this.volume.writeFileAtomic(
        installation,
        path,
        new TextEncoder().encode(current.raw),
        '0644',
      )
      await this.reloadProfilesAndUpdates(installation, context, 90).catch(() => {})
      throw error
    }
  }

  async reloadProfileUpdates(
    installation: GravitInstallation,
    context: JobTaskContext,
    progress = 90,
  ) {
    await this.reloadProfilesAndUpdates(installation, context, progress)
  }

  async updateProfile(
    installation: GravitInstallation,
    input: ClientProfileUpdateInput,
    context: JobTaskContext,
  ): Promise<ClientProfileUpdateResult> {
    this.validateProfile(input.name)
    const title = input.title.trim()
    const description = input.description.trim()
    if (!title || title.length > 64) {
      throw new Error('Profile title must be between 1 and 64 characters')
    }
    if (!description || description.length > 512) {
      throw new Error('Profile description must be between 1 and 512 characters')
    }
    if (!Number.isSafeInteger(input.sortIndex) || Math.abs(input.sortIndex) > 10_000) {
      throw new Error('Profile sort index must be an integer between -10000 and 10000')
    }

    const path = join('profiles', `${input.name}.json`)
    const current = await this.readProfileConfig(installation, input.name)
    const backupRelativePath = join(
      '.gravit-panel-profile-backups',
      `${input.name}.backup-${safeTimestamp()}.json`,
    )
    context.progress(20, `Snapshotting profile ${input.name}`)
    await this.volume.copy(installation, path, backupRelativePath)

    const next = {
      ...current.profile,
      title,
      info: description,
      sortIndex: input.sortIndex,
    }
    context.progress(45, `Saving profile ${input.name}`)
    await this.volume.writeFileAtomic(
      installation,
      path,
      new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
      '0644',
    )

    try {
      await this.reloadProfilesAndUpdates(installation, context, 65)
    } catch (error) {
      await this.volume.writeFileAtomic(
        installation,
        path,
        new TextEncoder().encode(current.raw),
        '0644',
      )
      await this.reloadProfilesAndUpdates(installation, context, 80).catch(() => {})
      throw error
    }

    context.progress(95, `Profile ${input.name} updated`)
    return {
      installationId: installation.id,
      profile: profileDescriptor(input.name, next),
      backupPath: join(launcherRoot(installation), backupRelativePath),
    }
  }

  async updateProfileJava(
    installation: GravitInstallation,
    input: ClientProfileJavaUpdateInput,
    context: JobTaskContext,
  ): Promise<ClientProfileUpdateResult> {
    this.validateProfile(input.name)
    for (const [label, value, maximum] of [
      ['recommended', input.recommendJavaVersion, 99],
      ['minimum', input.minJavaVersion, 99],
      ['maximum', input.maxJavaVersion, 999],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 8 || value > maximum) {
        throw new Error(`Profile ${label} Java version must be between 8 and ${maximum}`)
      }
    }
    if (
      input.minJavaVersion > input.recommendJavaVersion ||
      input.recommendJavaVersion > input.maxJavaVersion
    ) {
      throw new Error('Recommended Java version must be inside the allowed range')
    }

    const path = join('profiles', `${input.name}.json`)
    const current = await this.readProfileConfig(installation, input.name)
    const backupRelativePath = join(
      '.gravit-panel-profile-backups',
      `${input.name}.java-${safeTimestamp()}.json`,
    )
    context.progress(20, `Snapshotting profile ${input.name}`)
    await this.volume.copy(installation, path, backupRelativePath)
    const next = {
      ...current.profile,
      recommendJavaVersion: input.recommendJavaVersion,
      minJavaVersion: input.minJavaVersion,
      maxJavaVersion: input.maxJavaVersion,
    }
    await this.volume.writeFileAtomic(
      installation,
      path,
      new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
      '0644',
    )
    try {
      await this.reloadProfilesAndUpdates(installation, context, 65)
    } catch (error) {
      await this.volume.writeFileAtomic(
        installation,
        path,
        new TextEncoder().encode(current.raw),
        '0644',
      )
      await this.reloadProfilesAndUpdates(installation, context, 80).catch(() => {})
      throw error
    }
    context.progress(95, `Java compatibility for ${input.name} updated`)
    return {
      installationId: installation.id,
      profile: profileDescriptor(input.name, next),
      backupPath: join(launcherRoot(installation), backupRelativePath),
    }
  }

  async removeProfile(
    installation: GravitInstallation,
    input: ClientProfileRemoveInput,
    context: JobTaskContext,
  ): Promise<ClientProfileRemoveResult> {
    this.validateProfile(input.name)
    if (input.confirmRemove !== true) {
      throw new Error('Profile removal requires explicit confirmation')
    }
    const current = await this.readProfileConfig(installation, input.name)
    const profilePath = join('profiles', `${input.name}.json`)
    if (
      current.profile.dir !== undefined &&
      (typeof current.profile.dir !== 'string' ||
        !profilePattern.test(current.profile.dir) ||
        current.profile.dir === 'assets')
    ) {
      throw new Error(`Profile ${input.name} contains an unsafe client directory`)
    }
    const profileDir =
      typeof current.profile.dir === 'string' ? current.profile.dir : input.name
    const updatesPath = join('updates', profileDir)
    const trashRelativePath = join(
      '.gravit-panel-trash',
      'profiles',
      `${input.name}-${safeTimestamp()}`,
    )
    const trashedProfilePath = join(trashRelativePath, 'profile.json')
    const trashedUpdatesPath = join(trashRelativePath, 'client')
    const updatesExist = await this.volume.exists(
      installation,
      updatesPath,
      'directory',
    )
    let profileMoved = false
    let updatesMoved = false

    try {
      context.progress(30, `Moving profile ${input.name} to recoverable trash`)
      await this.volume.move(installation, profilePath, trashedProfilePath)
      profileMoved = true
      if (updatesExist) {
        await this.volume.move(installation, updatesPath, trashedUpdatesPath)
        updatesMoved = true
      }
      await this.reloadProfilesAndUpdates(installation, context, 70)
    } catch (error) {
      if (updatesMoved) {
        await this.volume.move(installation, trashedUpdatesPath, updatesPath)
      }
      if (profileMoved) {
        await this.volume.move(installation, trashedProfilePath, profilePath)
      }
      await this.reloadProfilesAndUpdates(installation, context, 85).catch(() => {})
      throw error
    }

    context.progress(95, `Profile ${input.name} removed`)
    return {
      installationId: installation.id,
      name: input.name,
      trashPath: join(launcherRoot(installation), trashRelativePath),
    }
  }

  async applyWorkspace(
    installation: GravitInstallation,
    context: JobTaskContext,
  ): Promise<WorkspaceApplyResult> {
    await this.modules.install(installation, mirrorHelperModule, context, {
      checking: 5,
      loading: 10,
      verifying: 15,
      completed: 20,
    })
    context.progress(25, 'Downloading pinned MirrorHelper workspace manifest')
    const bytes = await this.artifactFetcher(
      workspaceManifest.url,
      workspaceManifest.sha256,
      256 * 1024,
    )
    const manifestRelativePath = 'config/MirrorHelper/workspace.panel.json'
    const workspaceRelativePath = 'config/MirrorHelper/workspace'
    let manifestBackupRelativePath: string | null = null
    if (await this.volume.exists(installation, manifestRelativePath)) {
      manifestBackupRelativePath = `${manifestRelativePath}.backup-${safeTimestamp()}`
      await this.volume.copy(
        installation,
        manifestRelativePath,
        manifestBackupRelativePath,
      )
      context.log(
        `Workspace manifest snapshot created: ${join(launcherRoot(installation), manifestBackupRelativePath)}`,
      )
    }
    await this.volume.writeFileAtomic(installation, manifestRelativePath, bytes, '0600')
    context.log(`Verified workspace manifest: sha256:${workspaceManifest.sha256}`)

    let snapshotRelativePath: string | null = null
    if (await this.volume.exists(installation, workspaceRelativePath, 'directory')) {
      snapshotRelativePath = `config/MirrorHelper/workspace.backup-${safeTimestamp()}`
      await this.volume.move(installation, workspaceRelativePath, snapshotRelativePath)
      context.log(
        `Workspace snapshot created: ${join(launcherRoot(installation), snapshotRelativePath)}`,
      )
    }

    try {
      const command =
        'applyworkspace /app/data/config/MirrorHelper/workspace.panel.json' satisfies ClientControlCommand
      const maximumAttempts = 3
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        context.progress(
          55,
          attempt === 1
            ? 'Applying pinned MirrorHelper workspace'
            : `Retrying MirrorHelper workspace (${attempt}/${maximumAttempts})`,
        )
        try {
          const lines = await this.control.executeClientCommand(installation, command)
          lines.forEach(context.log)
          if (!(await this.volume.exists(installation, workspaceRelativePath, 'directory'))) {
            throw new Error('MirrorHelper did not create its workspace directory')
          }
          break
        } catch (error) {
          await this.volume.remove(installation, workspaceRelativePath, true)
          if (attempt === maximumAttempts) throw error
          const reason = error instanceof Error ? error.message : String(error)
          context.log(
            `MirrorHelper workspace attempt ${attempt}/${maximumAttempts} failed: ${reason}`,
          )
          context.log('Removed the partial workspace before retrying upstream downloads')
          context.signal.throwIfAborted()
        }
      }
    } catch (error) {
      await this.volume.remove(installation, workspaceRelativePath, true)
      if (snapshotRelativePath) {
        await this.volume.move(installation, snapshotRelativePath, workspaceRelativePath)
      }
      if (manifestBackupRelativePath) {
        await this.volume.copy(
          installation,
          manifestBackupRelativePath,
          manifestRelativePath,
        )
      } else {
        await this.volume.remove(installation, manifestRelativePath)
      }
      throw error
    }

    context.progress(95, 'Pinned MirrorHelper workspace applied')
    return {
      installationId: installation.id,
      manifestUrl: workspaceManifest.url,
      manifestSha256: workspaceManifest.sha256,
      snapshotPath: snapshotRelativePath
        ? join(launcherRoot(installation), snapshotRelativePath)
        : null,
      source: workspaceManifest.source,
    }
  }

  async installPrestarter(
    installation: GravitInstallation,
    context: JobTaskContext,
  ): Promise<PrestarterInstallResult> {
    context.progress(10, `Downloading pinned LauncherPrestarter ${prestarterRelease.tag}`)
    const bytes = await this.artifactFetcher(
      prestarterRelease.url,
      prestarterRelease.sha256,
      16 * 1024 * 1024,
    )
    const targetRelativePath = prestarterRelease.asset
    const targetPath = join(launcherRoot(installation), targetRelativePath)
    let backupRelativePath: string | null = null
    if (await this.volume.exists(installation, targetRelativePath)) {
      backupRelativePath = `${targetRelativePath}.backup-${safeTimestamp()}`
      await this.volume.copy(installation, targetRelativePath, backupRelativePath)
      context.log(
        `Prestarter snapshot created: ${join(launcherRoot(installation), backupRelativePath)}`,
      )
    }
    await this.volume.writeFileAtomic(installation, targetRelativePath, bytes, '0755')
    context.log(`Verified Prestarter.exe: sha256:${prestarterRelease.sha256}`)

    try {
      await this.modules.install(installation, prestarterModule, context, {
        checking: 55,
        loading: 65,
        verifying: 75,
        completed: 80,
      })
      context.progress(85, 'Restarting LaunchServer to initialize Prestarter binary')
      await this.restartForPrestarter(installation, context)
      await this.modules.install(installation, prestarterModule, context, {
        checking: 90,
        loading: 91,
        verifying: 92,
        completed: 93,
      })
    } catch (error) {
      await this.volume.remove(installation, targetRelativePath)
      if (backupRelativePath) {
        await this.volume.copy(installation, backupRelativePath, targetRelativePath)
      }
      throw error
    }

    context.progress(95, 'LauncherPrestarter installed and initialized')
    return {
      installationId: installation.id,
      path: targetPath,
      releaseTag: prestarterRelease.tag,
      sha256: prestarterRelease.sha256,
      backupPath: backupRelativePath
        ? join(launcherRoot(installation), backupRelativePath)
        : null,
      source: {
        repository: prestarterRelease.repository,
        revision: prestarterRelease.revision,
      },
    }
  }

  async buildLauncher(
    installation: GravitInstallation,
    context: JobTaskContext,
  ): Promise<LauncherBuildResult> {
    const runtime = await this.runtime.ensureInstalled(installation, context)
    return this.buildLauncherWithRuntime(installation, context, runtime)
  }

  private async buildLauncherWithRuntime(
    installation: GravitInstallation,
    context: JobTaskContext,
    runtime: LauncherRuntimeInstallResult,
  ): Promise<LauncherBuildResult> {
    const [prestarterDigest, existingArtifacts] = await Promise.all([
      this.volume.sha256?.(installation, prestarterRelease.asset) ??
        Promise.resolve(null),
      this.listLauncherArtifacts(installation),
    ])
    const expectsWindowsArtifact = prestarterDigest === prestarterRelease.sha256
    if (
      expectsWindowsArtifact &&
      !existingArtifacts.some((artifact) => artifact.variant === 'windows-x64')
    ) {
      context.progress(31, 'Initializing Prestarter launcher binary provider')
      await this.restartForPrestarter(installation, context)
      await this.modules.install(installation, prestarterModule, context, {
        checking: 32,
        loading: 33,
        verifying: 34,
        completed: 35,
      })
    }
    context.progress(35, 'Running source-verified LaunchServer build command')
    const lines = await this.control.executeBuildCommand(
      installation,
      'build' satisfies BuildControlCommand,
    )
    lines.forEach(context.log)
    context.progress(80, 'Inspecting generated launcher artifacts')
    const artifacts = await this.listLauncherArtifacts(installation)
    if (!artifacts.length) throw new Error('LaunchServer build completed without launcher artifacts')
    if (
      expectsWindowsArtifact &&
      !artifacts.some((artifact) => artifact.variant === 'windows-x64')
    ) {
      throw new Error(
        'LaunchServer build completed without the Prestarter Windows executable',
      )
    }
    artifacts.forEach((artifact) =>
      context.log(`${artifact.filename}: ${artifact.size} bytes sha256:${artifact.sha256}`),
    )
    context.progress(95, 'Launcher artifacts verified')
    return {
      installationId: installation.id,
      command: 'build',
      artifacts,
      runtime,
      source: launcherBuildSource,
    }
  }

  async customizationState(
    installation: GravitInstallation,
  ): Promise<LauncherCustomizationState> {
    if (!this.volume.readFile) {
      throw new Error('Launcher customization state discovery is unavailable')
    }
    if (!(await this.volume.exists(installation, customizationManifestPath))) {
      return {
        installationId: installation.id,
        customized: false,
        assets: [],
        source: launcherRuntimeReleaseSource(),
      }
    }
    try {
      const parsed = JSON.parse(
        await this.volume.readFile(installation, customizationManifestPath),
      ) as { assets?: LauncherCustomizationAsset[] }
      const assets = Array.isArray(parsed.assets)
        ? parsed.assets.filter(
            (asset) =>
              asset &&
              asset.id in customizationAssets &&
              customizationAssets[asset.id].path === asset.path &&
              /^[a-f0-9]{64}$/.test(asset.sha256),
          )
        : []
      return {
        installationId: installation.id,
        customized: assets.length > 0,
        assets,
        source: launcherRuntimeReleaseSource(),
      }
    } catch {
      return {
        installationId: installation.id,
        customized: false,
        assets: [],
        source: launcherRuntimeReleaseSource(),
      }
    }
  }

  async customizeLauncher(
    installation: GravitInstallation,
    files: LauncherCustomizationFiles,
    context: JobTaskContext,
  ): Promise<LauncherCustomizationResult> {
    const selected = Object.entries(files).filter(
      (entry): entry is [LauncherCustomizationAssetId, Uint8Array] =>
        entry[1] instanceof Uint8Array,
    )
    if (!selected.length) throw new Error('Select at least one launcher PNG asset')
    selected.forEach(([id, bytes]) => this.validateCustomizationAsset(id, bytes))

    const runtime = await this.runtime.ensureInstalled(installation, context)
    const backups: string[] = []
    const changedPaths: string[] = []
    const manifestBackup = await this.backupCustomizationFile(
      installation,
      customizationManifestPath,
      context,
    )
    if (manifestBackup) backups.push(manifestBackup)

    try {
      for (const [id, bytes] of selected) {
        const target = customizationAssets[id].path
        const backup = await this.backupCustomizationFile(installation, target, context)
        if (backup) backups.push(backup)
        await this.volume.writeFileAtomic(installation, target, bytes, '0644')
        changedPaths.push(target)
        context.log(`Launcher ${id} updated: ${target}`)
      }

      const previous = await this.customizationState(installation)
      const merged = new Map(previous.assets.map((asset) => [asset.id, asset]))
      for (const [id, bytes] of selected) {
        merged.set(id, {
          id,
          path: customizationAssets[id].path,
          sha256: sha256Bytes(bytes),
        })
      }
      const assets = [...merged.values()]
      const source = launcherRuntimeReleaseSource()
      await this.volume.writeFileAtomic(
        installation,
        customizationManifestPath,
        new TextEncoder().encode(
          `${JSON.stringify({ source, assets }, null, 2)}\n`,
        ),
        '0600',
      )
      context.progress(30, 'Launcher customization saved; rebuilding artifacts')
      const build = await this.buildLauncherWithRuntime(
        installation,
        context,
        runtime,
      )
      return {
        installationId: installation.id,
        customized: true,
        assets,
        backups,
        build,
        source,
      }
    } catch (error) {
      if (!changedPaths.length) throw error
      context.log(
        'Launcher customization files were saved, but artifact rebuild did not complete; retry Build launcher',
      )
      throw error
    }
  }

  async buildClient(
    installation: GravitInstallation,
    input: ClientBuildInput,
    context: JobTaskContext,
  ): Promise<ClientBuildResult> {
    this.validateProfile(input.name)
    this.validateVersion(input.minecraftVersion)
    input.mods.forEach((mod) => this.validateMod(mod))
    const compatibility = resolveClientCompatibility(input.minecraftVersion)
    if (
      input.loaderVersion &&
      input.loader !== 'FORGE' &&
      input.loader !== 'NEOFORGE'
    ) {
      throw new Error('Exact loader versions are supported for Forge and NeoForge builds')
    }
    const authlibRelativePath = join(
      'config',
      'MirrorHelper',
      'workspace',
      'authlib',
      compatibility.authlibArtifact,
    )
    if (!(await this.volume.exists(installation, authlibRelativePath))) {
      throw new Error(
        `${compatibility.authlibArtifact} is missing; apply the pinned MirrorHelper workspace first`,
      )
    }
    context.log(
      `Compatibility decision: ${input.minecraftVersion} requires ${compatibility.authlibArtifact}`,
    )
    const profileRelativePath = join('profiles', `${input.name}.json`)
    let previousProfile: LaunchProfileConfig | null = null
    if (
      this.volume.readFile &&
      (await this.volume.exists(installation, profileRelativePath))
    ) {
      try {
        previousProfile = JSON.parse(
          await this.volume.readFile(installation, profileRelativePath),
        ) as LaunchProfileConfig
      } catch {
        context.log(
          `Existing profile ${input.name} is invalid; its identity metadata cannot be preserved`,
        )
      }
    }
    const previousAssetIndexPath = previousProfile
      ? profileAssetIndexPath(previousProfile)
      : null
    if (
      previousAssetIndexPath &&
      (await this.volume.exists(installation, previousAssetIndexPath))
    ) {
      context.log(`Preparing existing Minecraft assets from ${previousAssetIndexPath}`)
      await this.reloadProfilesAndUpdates(installation, context, 15)
    }

    const suffix = input.mods.length ? ` ${input.mods.join(',')}` : ''
    const command =
      `installClient ${input.name} ${input.minecraftVersion} ${input.loader}${suffix}` as ClientControlCommand
    context.progress(20, 'Configuring MirrorHelper client build')
    const configLines = await this.control.executeClientCommand(
      installation,
      'mirrorhelper setDisableDownloadAssets true',
    )
    configLines.forEach(context.log)
    await this.ensureLoaderInstaller(
      installation,
      input.loader,
      input.minecraftVersion,
      input.loaderVersion ?? null,
      context,
    )
    context.progress(40, `Building ${input.name} with MirrorHelper`)
    const lines = await this.control.executeClientCommand(installation, command)
    lines.forEach(context.log)

    const updatesRelativePath = join('updates', input.name)
    const [hasProfile, hasUpdates] = await Promise.all([
      this.volume.exists(installation, profileRelativePath),
      this.volume.exists(installation, updatesRelativePath, 'directory'),
    ])
    if (!hasProfile || !hasUpdates) {
      throw new Error('MirrorHelper did not produce the expected profile and updates directory')
    }
    const { profile: generated } = await this.readProfileConfig(
      installation,
      input.name,
    )
    const generatedLoaderVersion = inferProfileLoaderVersion(generated)
    if (input.loaderVersion && generatedLoaderVersion !== input.loaderVersion) {
      throw new Error(
        `MirrorHelper built ${input.loader} ${generatedLoaderVersion ?? 'without a detectable version'} instead of requested ${input.loaderVersion}`,
      )
    }
    const assetIndexRelativePath = profileAssetIndexPath(generated)
    if (!assetIndexRelativePath) {
      throw new Error(
        'MirrorHelper produced a profile without a safe assetDir and assetIndex',
      )
    }
    if (!(await this.volume.exists(installation, assetIndexRelativePath))) {
      const assetDirectory = generated.assetDir as string
      const assetIndex = generated.assetIndex as string
      await this.volume.prepareHostWritableDirectory?.(
        installation,
        join('updates', assetDirectory),
      )
      await this.minecraftAssets.ensureAssets(
        installation,
        input.minecraftVersion,
        assetDirectory,
        assetIndex,
        context,
      )
    }
    if (!(await this.volume.exists(installation, assetIndexRelativePath))) {
      throw new Error(`Minecraft asset sync did not produce ${assetIndexRelativePath}`)
    }
    context.log(`Verified Minecraft asset index ${assetIndexRelativePath}`)

    let preservedMetadata = false
    if (previousProfile) {
      if (
        typeof previousProfile.uuid === 'string' &&
        profileUuidPattern.test(previousProfile.uuid)
      ) {
        generated.uuid = previousProfile.uuid
        preservedMetadata = true
      }
      if (typeof previousProfile.title === 'string' && previousProfile.title.trim()) {
        generated.title = previousProfile.title
        preservedMetadata = true
      }
      if (typeof previousProfile.info === 'string' && previousProfile.info.trim()) {
        generated.info = previousProfile.info
        preservedMetadata = true
      }
      if (
        typeof previousProfile.sortIndex === 'number' &&
        Number.isSafeInteger(previousProfile.sortIndex)
      ) {
        generated.sortIndex = previousProfile.sortIndex
        preservedMetadata = true
      }
      if (Array.isArray(previousProfile.servers)) {
        generated.servers = previousProfile.servers
        preservedMetadata = true
      }
      if (preservedMetadata) {
        await this.volume.writeFileAtomic(
          installation,
          profileRelativePath,
          new TextEncoder().encode(`${JSON.stringify(generated, null, 2)}\n`),
          '0644',
        )
        context.log(`Preserved stable identity and metadata for profile ${input.name}`)
      }
    }
    await this.reloadProfilesAndUpdates(installation, context, 90)
    const profilePath = join(launcherRoot(installation), profileRelativePath)
    const updatesPath = join(launcherRoot(installation), updatesRelativePath)
    context.progress(95, 'Client profile and update files verified')
    return {
      installationId: installation.id,
      name: input.name,
      minecraftVersion: input.minecraftVersion,
      loader: input.loader,
      loaderVersion: generatedLoaderVersion,
      mods: input.mods,
      profilePath,
      updatesPath,
      compatibility,
      source: mirrorHelperSource,
    }
  }

  private async ensureLoaderInstaller(
    installation: GravitInstallation,
    loader: ClientBuildInput['loader'],
    minecraftVersion: string,
    loaderVersion: string | null,
    context: JobTaskContext,
  ) {
    if (loader !== 'FORGE' && loader !== 'NEOFORGE') return

    const prefix = loader.toLowerCase()
    const workspace = 'config/MirrorHelper/workspace'
    const installerPaths = [
      join(workspace, 'installers', `${prefix}-${minecraftVersion}-installer-nogui.jar`),
      join(workspace, 'installers', `${prefix}-${minecraftVersion}-installer.jar`),
    ]
    const cachePath = join(workspace, 'clients', prefix, minecraftVersion)
    const versionMarkerPath = join(
      workspace,
      '.gravit-panel-loader-versions',
      `${prefix}-${minecraftVersion}.txt`,
    )
    const [hasNoGuiInstaller, hasGuiInstaller, hasCache] = await Promise.all([
      this.volume.exists(installation, installerPaths[0]!),
      this.volume.exists(installation, installerPaths[1]!),
      this.volume.exists(installation, cachePath, 'directory'),
    ])
    const cachedVersion =
      loaderVersion && this.volume.readFile &&
      (await this.volume.exists(installation, versionMarkerPath))
        ? (await this.volume.readFile(installation, versionMarkerPath)).trim()
        : null
    if (
      (hasNoGuiInstaller || hasGuiInstaller || hasCache) &&
      (!loaderVersion || cachedVersion === loaderVersion)
    ) {
      context.log(
        `Reusing cached ${loader}${cachedVersion ? ` ${cachedVersion}` : ''} installer data for Minecraft ${minecraftVersion}`,
      )
      return
    }

    if (loaderVersion && (hasNoGuiInstaller || hasGuiInstaller || hasCache)) {
      context.log(
        `Replacing cached ${loader} ${cachedVersion ?? 'with unknown version'} with ${loaderVersion}`,
      )
      await Promise.all([
        ...installerPaths.map((path) => this.volume.remove(installation, path)),
        this.volume.remove(installation, cachePath, true),
      ])
    }

    context.progress(30, `Downloading ${loader} installer for Minecraft ${minecraftVersion}`)
    try {
      const artifact = await this.loaderInstallers.download(
        loader,
        minecraftVersion,
        loaderVersion ?? undefined,
      )
      const installerPath = join(workspace, 'installers', artifact.filename)
      if (!installerPaths.includes(installerPath)) {
        throw new Error(`Resolved an unexpected installer filename: ${artifact.filename}`)
      }
      await this.volume.writeFileAtomic(installation, installerPath, artifact.bytes)
      await this.volume.writeFileAtomic(
        installation,
        versionMarkerPath,
        new TextEncoder().encode(`${artifact.loaderVersion}\n`),
        '0644',
      )
      context.log(
        `Resolved ${loader} ${artifact.loaderVersion} for Minecraft ${minecraftVersion}`,
      )
      context.log(`Verified ${artifact.filename}: sha256:${artifact.sha256}`)
    } catch (error) {
      await Promise.allSettled(
        installerPaths.map((path) => this.volume.remove(installation, path)),
      )
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Failed to prepare ${loader} installer for Minecraft ${minecraftVersion}: ${detail}`,
        { cause: error },
      )
    }
  }

  private async restartForPrestarter(
    installation: GravitInstallation,
    context: JobTaskContext,
  ) {
    if (!this.lifecycle) {
      throw new Error(
        'LaunchServer restart is unavailable; Prestarter cannot initialize its executable build task',
      )
    }
    await this.lifecycle.restartLaunchServer(installation, context)
  }

  private async backupCustomizationFile(
    installation: GravitInstallation,
    path: string,
    context: JobTaskContext,
  ) {
    if (!(await this.volume.exists(installation, path))) return null
    const backup = `${path}.backup-${safeTimestamp()}`
    await this.volume.copy(installation, path, backup)
    context.log(`Customization snapshot created: ${backup}`)
    return backup
  }

  private validateCustomizationAsset(
    id: LauncherCustomizationAssetId,
    bytes: Uint8Array,
  ) {
    const expected = customizationAssets[id]
    if (!bytes.length || bytes.length > expected.maxBytes) {
      throw new Error(
        `${id} PNG must be between 1 byte and ${expected.maxBytes} bytes`,
      )
    }
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (!pngSignature.every((byte, index) => bytes[index] === byte)) {
      throw new Error(`${id} must be a valid PNG file`)
    }
  }

  async listLauncherArtifacts(installation: GravitInstallation): Promise<LauncherArtifact[]> {
    const root = launcherRoot(installation)
    const parsed = JSON.parse(
      await readFile(join(root, 'LaunchServer.json'), 'utf8'),
    ) as LaunchServerLocalConfig
    const updatesDir = parsed.updatesProvider?.updatesDir ?? 'updates'
    const binaryName = parsed.updatesProvider?.binaryName ?? 'Launcher'
    if (
      !/^[a-zA-Z0-9._-]+$/.test(updatesDir) ||
      !/^[a-zA-Z0-9._-]+$/.test(binaryName) ||
      basename(updatesDir) !== updatesDir ||
      basename(binaryName) !== binaryName
    ) {
      throw new Error('LaunchServer updatesProvider contains an unsafe artifact path')
    }
    const directory = assertInside(root, join(root, updatesDir))
    const candidates = [
      { variant: 'jar' as const, filename: `${binaryName}.jar` },
      { variant: 'windows-x64' as const, filename: `${binaryName}.exe` },
    ]
    const artifacts: LauncherArtifact[] = []
    for (const candidate of candidates) {
      const path = assertInside(root, join(directory, candidate.filename))
      if (!(await exists(path))) continue
      const metadata = await lstat(path)
      if (!metadata.isFile()) continue
      const bytes = await readFile(path)
      artifacts.push({
        variant: candidate.variant,
        filename: candidate.filename,
        size: metadata.size,
        sha256: sha256Bytes(bytes),
        modifiedAt: metadata.mtime.toISOString(),
        downloadPath: `/api/clients/launcher/artifacts/${candidate.variant}?installationId=${installation.id}`,
      })
    }
    return artifacts
  }

  async artifactPath(installation: GravitInstallation, variant: LauncherArtifact['variant']) {
    const artifact = (await this.listLauncherArtifacts(installation)).find(
      (item) => item.variant === variant,
    )
    if (!artifact) return null
    const parsed = JSON.parse(
      await readFile(join(launcherRoot(installation), 'LaunchServer.json'), 'utf8'),
    ) as LaunchServerLocalConfig
    const updatesDir = parsed.updatesProvider?.updatesDir ?? 'updates'
    if (!/^[a-zA-Z0-9._-]+$/.test(updatesDir) || basename(updatesDir) !== updatesDir) {
      throw new Error('LaunchServer updatesProvider contains an unsafe artifact path')
    }
    return assertInside(
      launcherRoot(installation),
      join(launcherRoot(installation), updatesDir, artifact.filename),
    )
  }

  private async readProfileConfig(
    installation: GravitInstallation,
    name: string,
  ): Promise<{ raw: string; profile: LaunchProfileConfig }> {
    if (!this.volume.readFile) {
      throw new Error('Container volume profile reads are unavailable')
    }
    const path = join('profiles', `${name}.json`)
    if (!(await this.volume.exists(installation, path))) {
      throw new Error(`Profile ${name} does not exist`)
    }
    const raw = await this.volume.readFile(installation, path)
    let profile: LaunchProfileConfig
    try {
      profile = JSON.parse(raw) as LaunchProfileConfig
    } catch (error) {
      throw new Error(`Profile ${name} contains invalid JSON`, { cause: error })
    }
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error(`Profile ${name} has an invalid structure`)
    }
    return { raw, profile }
  }

  private async reloadProfilesAndUpdates(
    installation: GravitInstallation,
    context: JobTaskContext,
    progress: number,
  ) {
    if (!this.lifecycle) {
      throw new Error(
        'LaunchServer restart is unavailable; profiles and updates cannot be reloaded',
      )
    }
    context.progress(progress, 'Reloading LaunchServer profiles and updates')
    await this.volume.remove(installation, '.updates-cache')
    context.log('Invalidated LaunchServer updates cache')
    await this.lifecycle.restartLaunchServer(installation, context)
    context.log('LaunchServer profiles and updates reloaded')
  }

  private validateProfile(value: string) {
    if (!profilePattern.test(value)) throw new Error('Profile name contains unsupported characters')
  }

  private validateVersion(value: string) {
    if (!versionPattern.test(value)) throw new Error('Minecraft version is invalid')
  }

  private validateMod(value: string) {
    if (!modPattern.test(value)) throw new Error(`Invalid Modrinth slug: ${value}`)
  }
}
