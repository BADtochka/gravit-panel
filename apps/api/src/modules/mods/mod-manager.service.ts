import type {
  GravitInstallation,
  InstalledMod,
  ModInstallInput,
  ModrinthModpackImportInput,
  OptionalModUpdateInput,
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
import type { ClientBuildService } from '../clients/client-build.service'
import type { ServerPackService } from '../servers/server-pack.service'
import type { ServerBindingsStore } from '../servers/server-bindings.store'
import {
  ModrinthService,
  modrinthSource,
  type ResolvedModrinthPack,
} from './modrinth.service'

const profilePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const filenamePattern = /^[^/\\\0]{1,255}\.jar(?:\.disabled)?$/
const sha1File = async (path: string) =>
  createHash('sha1').update(await readFile(path)).digest('hex')

export class ModManagerService {
  constructor(
    private readonly control: ControlFileService,
    private readonly modrinth: ModrinthService,
    private readonly volume: VolumeFileOperations = new ContainerVolumeService(),
    private readonly clients?: Pick<
      ClientBuildService,
      | 'upsertOptionalMods'
      | 'reloadProfileUpdates'
      | 'listOptionalMods'
      | 'updateOptionalMod'
      | 'removeOptionalMod'
      | 'listProfiles'
      | 'buildClient'
    >,
    private readonly serverPacks?: Pick<
      ServerPackService,
      'installMods' | 'putFile' | 'publish' | 'removeMod'
    >,
    private readonly serverBindings?: Pick<ServerBindingsStore, 'get' | 'list' | 'setDesiredPack'>,
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
    const projects = await this.modrinth.projectsByIds([
      ...new Set(
        Object.values(versions).map((version) => version.project_id),
      ),
    ])
    return {
      items: valid.map(
        (item): InstalledMod => {
          const version = versions[item.sha1]
          const project = version ? projects[version.project_id] : null
          return {
            ...item,
            projectId: version?.project_id ?? null,
            versionId: version?.id ?? null,
            versionName: version?.version_number ?? null,
            name: project?.title ?? null,
            description: project?.description ?? null,
            slug: project?.slug ?? null,
            serverSide: project?.server_side ?? null,
          }
        },
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
    if (input.selections?.length) {
      const requestedSlugs = new Set(input.slugs)
      const selectedSlugs = new Set(input.selections.map((item) => item.slug))
      if (
        requestedSlugs.size !== input.slugs.length ||
        selectedSlugs.size !== input.selections.length ||
        requestedSlugs.size !== selectedSlugs.size ||
        [...requestedSlugs].some((slug) => !selectedSlugs.has(slug))
      ) {
        throw new Error('Selected mods and destination assignments do not match')
      }
      if (!this.clients || !this.serverPacks || !this.serverBindings) {
        throw new Error('Unified mod destinations are unavailable')
      }
      const clientSelections = input.selections.filter(
        (item) => item.clientMode !== 'none',
      )
      const missingDestinations = input.selections.filter(
        (item) => item.clientMode === 'none' && item.serverBindingIds.length === 0,
      )
      if (missingDestinations.length) {
        throw new Error(
          `Select an install destination for: ${missingDestinations.map((item) => item.slug).join(', ')}`,
        )
      }
      let requiredClientChanged = false
      const optionalDependencyProjectIds = new Set<string>()
      const optionalClientMods = new Map<string, {
        projectId: string
        title: string
        description: string
        filename: string
        sourcePath: string
        enabledByDefault: boolean
      }>()
      for (const selection of clientSelections) {
        const resolved = await this.modrinth.resolveInstall(
          selection.slug,
          input.minecraftVersion,
          input.loader,
          'client',
        )
        for (const item of resolved) {
          const bytes = await this.modrinth.download(item.file)
          if (selection.clientMode === 'required' || !item.root) {
            await this.volume.writeFileAtomic(
              installation,
              posix.join(
                this.modsRelativeDirectory(input.profile),
                item.file.filename,
              ),
              bytes,
              '0644',
            )
            requiredClientChanged = true
            if (selection.clientMode === 'optional' && !item.root) {
              optionalDependencyProjectIds.add(item.projectId)
            }
          } else {
            const sourcePath = posix.join(
              '.gravit-panel-optional',
              'mods',
              item.projectId,
              item.file.filename,
            )
            await this.volume.writeFileAtomic(
              installation,
              posix.join('updates', input.profile, sourcePath),
              bytes,
              '0644',
            )
            optionalClientMods.set(item.projectId, {
              projectId: item.projectId,
              title: selection.optionalName?.trim() || item.title,
              description: selection.optionalDescription?.trim() || '',
              filename: item.file.filename,
              sourcePath,
              enabledByDefault: selection.optionalEnabledByDefault ?? false,
            })
          }
        }
      }
      if (optionalClientMods.size) {
        await this.clients.upsertOptionalMods(
          installation,
          input.profile,
          [...optionalClientMods.values()],
          context,
          [...optionalDependencyProjectIds],
        )
      } else if (requiredClientChanged) {
        await this.clients.reloadProfileUpdates(installation, context, 85)
      }
      const serverSelections = new Map<string, Set<string>>()
      for (const selection of input.selections) {
        for (const bindingId of new Set(selection.serverBindingIds)) {
          const binding = this.serverBindings.get(bindingId)
          if (
            !binding ||
            binding.installationId !== installation.id ||
            binding.profileName !== input.profile
          ) throw new Error('Selected server does not belong to the target profile')
          const slugs = serverSelections.get(bindingId) ?? new Set<string>()
          slugs.add(selection.slug)
          serverSelections.set(bindingId, slugs)
        }
      }
      for (const [bindingId, slugs] of serverSelections) {
        await this.serverPacks.installMods(installation, bindingId, [...slugs], context)
        const published = await this.serverPacks.publish(
          installation,
          bindingId,
          context,
        )
        this.serverBindings.setDesiredPack(bindingId, published.version.id)
      }
      context.progress(95, 'Selected client and server mod destinations updated')
      return {
        installationId: installation.id,
        profile: input.profile,
        selections: input.selections,
        source: modrinthSource,
      }
    }
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

  async listOptional(installation: GravitInstallation, profile: string) {
    if (!this.clients) throw new Error('Optional mod management is unavailable')
    return this.clients.listOptionalMods(installation, profile)
  }

  async updateOptional(
    installation: GravitInstallation,
    input: OptionalModUpdateInput,
    context: JobTaskContext,
  ) {
    if (!this.clients) throw new Error('Optional mod management is unavailable')
    return this.clients.updateOptionalMod(
      installation,
      input.profile,
      {
        projectId: input.projectId,
        title: input.name,
        description: input.description,
        category: input.category,
        enabledByDefault: input.enabledByDefault,
      },
      context,
    )
  }

  async removeOptional(
    installation: GravitInstallation,
    profile: string,
    projectId: string,
    context: JobTaskContext,
  ) {
    if (!this.clients) throw new Error('Optional mod management is unavailable')
    return this.clients.removeOptionalMod(installation, profile, projectId, context)
  }

  async importModpack(
    installation: GravitInstallation,
    input: ModrinthModpackImportInput,
    context: JobTaskContext,
  ) {
    context.progress(5, 'Resolving and validating Modrinth modpack')
    const pack = await this.modrinth.resolveModpack(
      input.projectId,
      input.minecraftVersion,
      input.loader,
    )
    return this.applyResolvedModpack(installation, input, pack, context)
  }

  async importLocalModpack(
    installation: GravitInstallation,
    input: ModrinthModpackImportInput,
    archive: Uint8Array,
    context: JobTaskContext,
  ) {
    context.progress(5, 'Reading and validating local Modrinth modpack')
    const pack = await this.modrinth.resolveLocalModpack(
      archive,
      input.minecraftVersion,
      input.loader,
    )
    if (pack.inspection.projectId !== input.projectId) {
      throw new Error('Local .mrpack changed after inspection')
    }
    return this.applyResolvedModpack(installation, input, pack, context)
  }

  private async applyResolvedModpack(
    installation: GravitInstallation,
    input: ModrinthModpackImportInput,
    pack: ResolvedModrinthPack,
    context: JobTaskContext,
  ) {
    this.validateProfile(input.profile)
    if (!this.clients || !this.serverPacks || !this.serverBindings) {
      throw new Error('Modpack destinations are unavailable')
    }
    if (input.loaderVersion !== pack.inspection.loaderVersion) {
      throw new Error('Modpack loader version changed after inspection')
    }
    const profiles = await this.clients.listProfiles(installation)
    const currentProfile = profiles.items.find((item) => item.name === input.profile)
    if (!currentProfile) {
      throw new Error(`Profile ${input.profile} must be created before importing a modpack`)
    }
    if (
      currentProfile.minecraftVersion !== pack.inspection.minecraftVersion ||
      currentProfile.loader !== pack.inspection.loader ||
      currentProfile.loaderVersion !== pack.inspection.loaderVersion
    ) {
      if (input.loader !== 'FORGE' && input.loader !== 'NEOFORGE') {
        throw new Error(
          `Profile loader ${currentProfile.loaderVersion ?? 'unknown'} does not match modpack loader ${input.loaderVersion}`,
        )
      }
      context.progress(
        10,
        `Rebuilding ${input.profile} with ${input.loader} ${input.loaderVersion}`,
      )
      await this.clients.buildClient(
        installation,
        {
          installationId: installation.id,
          name: input.profile,
          minecraftVersion: input.minecraftVersion,
          loader: input.loader,
          loaderVersion: input.loaderVersion,
          mods: [],
        },
        context,
      )
    }
    const selections = new Map(input.files.map((item) => [item.path, item]))
    if (
      selections.size !== input.files.length ||
      pack.files.length !== selections.size ||
      pack.files.some((file) => !selections.has(file.path))
    ) {
      throw new Error('Modpack file selections do not match the resolved version')
    }
    const bindings = [...new Set(input.serverBindingIds)].map((bindingId) => {
      const binding = this.serverBindings!.get(bindingId)
      if (
        !binding ||
        binding.installationId !== installation.id ||
        binding.profileName !== input.profile
      ) throw new Error('Selected server does not belong to the target profile')
      return binding
    })
    let clientChanged = false
    let serverChanged = false
    const optionals = new Map<string, {
      projectId: string
      title: string
      description: string
      filename: string
      sourcePath: string
      destinationPath?: string
      enabledByDefault: boolean
    }>()
    context.progress(15, `Installing ${pack.files.length} modpack files`)
    for (const file of pack.files) {
      const selection = selections.get(file.path)!
      const clientSide = file.env?.client ?? 'required'
      const serverSide = file.env?.server ?? 'required'
      if (selection.clientMode !== 'none' && clientSide === 'unsupported') {
        throw new Error(`Client-unsupported file selected for client: ${file.path}`)
      }
      if (selection.installOnServer && serverSide === 'unsupported') {
        throw new Error(`Server-unsupported file selected for server: ${file.path}`)
      }
      if (selection.clientMode === 'none' && !selection.installOnServer) continue
      const bytes = await this.modrinth.downloadPackFile(file)
      if (selection.clientMode === 'required') {
        await this.volume.writeFileAtomic(
          installation,
          posix.join('updates', input.profile, file.path),
          bytes,
          '0644',
        )
        clientChanged = true
      } else if (selection.clientMode === 'optional') {
        const identity = pack.inspection.files.find((item) => item.path === file.path)
        const projectId = `mrpack-${pack.inspection.projectId}-${
          createHash('sha1').update(file.path).digest('hex').slice(0, 12)
        }`
        const sourcePath = posix.join(
          '.gravit-panel-optional',
          'mods',
          projectId,
          basename(file.path),
        )
        await this.volume.writeFileAtomic(
          installation,
          posix.join('updates', input.profile, sourcePath),
          bytes,
          '0644',
        )
        optionals.set(projectId, {
          projectId,
          title: selection.name.trim() || identity?.name || basename(file.path),
          description: selection.description.trim() || identity?.description || '',
          filename: basename(file.path),
          sourcePath,
          destinationPath: file.path,
          enabledByDefault: selection.enabledByDefault,
        })
      }
      if (selection.installOnServer) {
        for (const binding of bindings) {
          await this.serverPacks.putFile(installation, binding.id!, file.path, bytes)
          serverChanged = true
        }
      }
    }
    context.progress(65, 'Applying Modrinth modpack overrides')
    for (const override of pack.overrides) {
      if (override.side !== 'server') {
        await this.volume.writeFileAtomic(
          installation,
          posix.join('updates', input.profile, override.path),
          override.bytes,
          '0644',
        )
        clientChanged = true
      }
      if (override.side !== 'client') {
        for (const binding of bindings) {
          await this.serverPacks.putFile(
            installation,
            binding.id!,
            override.path,
            override.bytes,
          )
          serverChanged = true
        }
      }
    }
    if (optionals.size) {
      await this.clients.upsertOptionalMods(
        installation,
        input.profile,
        [...optionals.values()],
        context,
      )
    } else if (clientChanged) {
      await this.clients.reloadProfileUpdates(installation, context, 82)
    }
    const packVersions = []
    if (serverChanged) {
      for (const binding of bindings) {
        const published = await this.serverPacks.publish(installation, binding.id!, context)
        this.serverBindings.setDesiredPack(binding.id!, published.version.id)
        packVersions.push(published.version.id)
      }
    }
    context.progress(98, `Imported ${pack.inspection.name}`)
    return {
      installationId: installation.id,
      profile: input.profile,
      modpack: pack.inspection,
      optionalCount: optionals.size,
      serverPackVersionIds: packVersions,
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

  async bulk(
    installation: GravitInstallation,
    input: {
      profile: string
      filenames: string[]
      action: 'enable' | 'disable' | 'update' | 'remove'
      minecraftVersion?: string
      loader?: string
      removeFromServer?: boolean
      removeUnusedDependencies?: boolean
    },
    context: JobTaskContext,
  ) {
    this.validateProfile(input.profile)
    const filenames = [...new Set(input.filenames.map((item) => this.safeFilename(item)))]
    if (!filenames.length || filenames.length !== input.filenames.length) {
      throw new Error('Bulk mod selection must contain unique files')
    }
    if (input.action === 'update' && (!input.minecraftVersion || !input.loader)) {
      throw new Error('Minecraft version and loader are required for bulk updates')
    }
    const results: Array<Record<string, unknown>> = []
    for (const [index, filename] of filenames.entries()) {
      if (context.signal.aborted) throw new Error('Bulk mod operation cancelled')
      context.progress(
        Math.round(5 + (index / filenames.length) * 90),
        `${input.action} ${filename}`,
      )
      const scopedContext: JobTaskContext = {
        ...context,
        progress: (_value, message) => context.log(`${filename}: ${message}`),
      }
      if (input.action === 'enable' || input.action === 'disable') {
        results.push(await this.toggle(
          installation,
          input.profile,
          filename,
          input.action === 'enable',
          scopedContext,
        ))
      } else if (input.action === 'update') {
        results.push(await this.update(
          installation,
          input.profile,
          filename,
          input.minecraftVersion!,
          input.loader!,
          scopedContext,
        ))
      } else {
        results.push(await this.remove(
          installation,
          input.profile,
          filename,
          scopedContext,
          {
            removeFromServer: input.removeFromServer,
            removeUnusedDependencies: input.removeUnusedDependencies,
          },
        ))
      }
    }
    context.progress(98, `Bulk ${input.action} completed for ${results.length} mods`)
    return {
      installationId: installation.id,
      profile: input.profile,
      action: input.action,
      count: results.length,
      results,
    }
  }

  async remove(
    installation: GravitInstallation,
    profile: string,
    filename: string,
    context: JobTaskContext,
    options: { removeFromServer?: boolean; removeUnusedDependencies?: boolean } = {},
  ) {
    const directory = this.modsDirectory(installation, profile)
    const relativeDirectory = this.modsRelativeDirectory(profile)
    const safeName = this.safeFilename(filename)
    const sourcePath = join(directory, safeName)
    await this.assertRegularMod(sourcePath)
    let installed: InstalledMod | undefined
    if (options.removeFromServer) {
      installed = (await this.list(installation, profile)).items.find((item) => item.filename === safeName)
      if (!installed?.projectId || !installed.slug) {
        throw new Error('Server removal requires a mod recognized by Modrinth')
      }
      if (!this.serverPacks || !this.serverBindings) {
        throw new Error('Server mod removal is unavailable')
      }
    }
    if (installed?.projectId && installed.slug && this.serverPacks && this.serverBindings) {
      for (const binding of this.serverBindings.list(installation.id, profile)) {
        if (!binding.id) continue
        const result = await this.serverPacks.removeMod(
          installation,
          binding.id,
          { projectId: installed.projectId, slug: installed.slug, filename: safeName },
          options.removeUnusedDependencies === true,
        )
        if (!result.removed.length) continue
        const published = await this.serverPacks.publish(installation, binding.id, context)
        this.serverBindings.setDesiredPack(binding.id, published.version.id)
        context.log(`Removed ${result.removed.length} server pack file(s) from ${binding.name}`)
      }
    }
    await this.volume.remove(installation, posix.join(relativeDirectory, safeName))
    context.log(`Deleted ${safeName} permanently`)
    context.progress(95, 'Mod deleted from profile')
    return { installationId: installation.id, profile, filename: safeName }
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
      `.gravit-panel-${crypto.randomUUID()}.backup`,
    )
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
    await this.volume.remove(installation, backupRelativePath)
    context.log(`Updated ${safeName} to ${targetName}; previous file deleted`)
    context.progress(95, 'Mod update verified and installed')
    return {
      installationId: installation.id,
      profile,
      filename: targetName,
      versionId: version.id,
      versionName: version.version_number,
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
