import type {
  GravitInstallation,
  ServerPackEntry,
  ServerPackFile,
} from '@gravit-panel/shared'
import { createHash } from 'node:crypto'
import {
  lstat,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { env } from '../../core/env'
import type { ClientBuildService } from '../clients/client-build.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import type { ModrinthService } from '../mods/modrinth.service'
import type { ServerPackStore } from './server-pack.store'
import type { ServerBindingsStore } from './server-bindings.store'

const profilePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const maximumFileBytes = env.SERVER_PACK_MAX_FILE_BYTES
const maximumPackBytes = env.SERVER_PACK_MAX_BYTES
const maximumEditorBytes = 1024 * 1024
const reservedRoots = new Set([
  '.gravit-panel',
  'eula.txt',
  'serverwrapper.jar',
  'serverwrapperinline.jar',
  'serverwrapperconfig.json',
  'gravit-server.env',
  'start-gravit-server.sh',
  'server.jar',
  'fabric-server-launch.jar',
  'run.sh',
  'run.bat',
  'user_jvm_args.txt',
  'libraries',
  'versions',
])

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

const safeTimestamp = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')

interface ServerModOwnership {
  orphans?: string[]
  roots: Record<string, {
    slug: string
    artifacts: Array<{
      projectId: string
      path: string
      root: boolean
    }>
  }>
}

export class ServerPackService {
  constructor(
    private readonly store: ServerPackStore,
    private readonly bindings: ServerBindingsStore,
    private readonly clients: Pick<ClientBuildService, 'getProfile'>,
    private readonly modrinth: ModrinthService,
  ) {}

  async listFiles(installation: GravitInstallation, bindingId: string) {
    const binding = this.requireBinding(installation, bindingId)
    const root = await this.ensureWorkspace(installation, bindingId)
    const files: ServerPackFile[] = []
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error('Server pack cannot contain symbolic links')
        if (entry.isDirectory()) {
          await walk(path)
          continue
        }
        if (!entry.isFile()) continue
        const metadata = await stat(path)
        const bytes = new Uint8Array(await readFile(path))
        files.push({
          path: relative(root, path).split(sep).join('/'),
          size: metadata.size,
          sha256: sha256(bytes),
          modifiedAt: metadata.mtime.toISOString(),
        })
      }
    }
    await walk(root)
    files.sort((left, right) => left.path.localeCompare(right.path))
    return { items: files, versions: this.store.list(installation.id, bindingId) }
  }

  async listEntries(installation: GravitInstallation, bindingId: string) {
    const root = await this.ensureWorkspace(installation, bindingId)
    const entries: ServerPackEntry[] = []
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error('Server pack cannot contain symbolic links')
        const metadata = await stat(path)
        const relativePath = relative(root, path).split(sep).join('/')
        if (entry.isDirectory()) {
          entries.push({
            path: relativePath,
            type: 'directory',
            size: null,
            sha256: null,
            modifiedAt: metadata.mtime.toISOString(),
          })
          await walk(path)
          continue
        }
        if (!entry.isFile()) continue
        const bytes = new Uint8Array(await readFile(path))
        entries.push({
          path: relativePath,
          type: 'file',
          size: metadata.size,
          sha256: sha256(bytes),
          modifiedAt: metadata.mtime.toISOString(),
        })
      }
    }
    await walk(root)
    entries.sort((left, right) => left.path.localeCompare(right.path))
    return { entries, versions: this.store.list(installation.id, bindingId) }
  }

  async putFile(
    installation: GravitInstallation,
    bindingId: string,
    relativePath: string,
    bytes: Uint8Array,
  ) {
    if (!bytes.length || bytes.length > maximumFileBytes) {
      throw new Error(`Server pack file must be between 1 byte and ${maximumFileBytes} bytes`)
    }
    const target = this.safePath(installation, bindingId, relativePath)
    const root = await this.ensureWorkspace(installation, bindingId)
    await this.assertSafeAncestors(root, target)
    await mkdir(dirname(target), { recursive: true })
    const pending = join(root, `.gravit-panel-${crypto.randomUUID()}.pending`)
    await writeFile(pending, bytes, { mode: 0o600 })
    await rename(pending, target)
    await this.assertPackSize(root)
    return { path: relativePath, size: bytes.length, sha256: sha256(bytes) }
  }

  async readTextFile(
    installation: GravitInstallation,
    bindingId: string,
    relativePath: string,
  ) {
    const source = this.safePath(installation, bindingId, relativePath)
    const metadata = await lstat(source)
    if (!metadata.isFile()) throw new Error('Server pack path is not a file')
    if (metadata.size > maximumEditorBytes) throw new Error('Text editor supports files up to 1 MiB')
    const bytes = new Uint8Array(await readFile(source))
    if (bytes.includes(0)) throw new Error('Binary files cannot be opened in the text editor')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { path: relativePath, content, size: bytes.length, sha256: sha256(bytes) }
  }

  async putTextFile(
    installation: GravitInstallation,
    bindingId: string,
    relativePath: string,
    content: string,
  ) {
    const bytes = new TextEncoder().encode(content)
    if (bytes.length > maximumEditorBytes) throw new Error('Text editor supports files up to 1 MiB')
    if (!bytes.length) {
      const target = this.safePath(installation, bindingId, relativePath)
      const root = await this.ensureWorkspace(installation, bindingId)
      await this.assertSafeAncestors(root, target)
      await mkdir(dirname(target), { recursive: true })
      const pending = join(root, `.gravit-panel-${crypto.randomUUID()}.pending`)
      await writeFile(pending, bytes, { mode: 0o600 })
      await rename(pending, target)
      return { path: relativePath, size: 0, sha256: sha256(bytes) }
    }
    return this.putFile(installation, bindingId, relativePath, bytes)
  }

  async createDirectory(
    installation: GravitInstallation,
    bindingId: string,
    relativePath: string,
  ) {
    const target = this.safePath(installation, bindingId, relativePath)
    const root = await this.ensureWorkspace(installation, bindingId)
    await this.assertSafeAncestors(root, target)
    await this.assertMissing(target)
    await this.assertDirectory(dirname(target))
    await mkdir(target)
    return { path: relativePath }
  }

  async createTextFile(
    installation: GravitInstallation,
    bindingId: string,
    relativePath: string,
    content = '',
  ) {
    const target = this.safePath(installation, bindingId, relativePath)
    const root = await this.ensureWorkspace(installation, bindingId)
    await this.assertSafeAncestors(root, target)
    await this.assertMissing(target)
    await this.assertDirectory(dirname(target))
    return this.putTextFile(installation, bindingId, relativePath, content)
  }

  async moveEntry(
    installation: GravitInstallation,
    bindingId: string,
    sourcePath: string,
    destinationPath: string,
  ) {
    const source = this.safePath(installation, bindingId, sourcePath)
    const destination = this.safePath(installation, bindingId, destinationPath)
    const root = await this.ensureWorkspace(installation, bindingId)
    await this.assertSafeAncestors(root, source)
    await this.assertSafeAncestors(root, destination)
    const metadata = await lstat(source)
    if (!metadata.isFile() && !metadata.isDirectory()) throw new Error('Server pack entry is invalid')
    if (metadata.isDirectory() && destination.startsWith(`${source}${sep}`)) {
      throw new Error('A directory cannot be moved into itself')
    }
    await this.assertMissing(destination)
    await this.assertDirectory(dirname(destination))
    await rename(source, destination)
    const ownership = await this.readModOwnership(installation, bindingId)
    let ownershipChanged = false
    for (const root of Object.values(ownership.roots)) {
      for (const artifact of root.artifacts) {
        if (artifact.path === sourcePath || artifact.path.startsWith(`${sourcePath}/`)) {
          artifact.path = `${destinationPath}${artifact.path.slice(sourcePath.length)}`
          ownershipChanged = true
        }
      }
    }
    if (ownership.orphans?.length) {
      ownership.orphans = ownership.orphans.map((path) => {
        if (path !== sourcePath && !path.startsWith(`${sourcePath}/`)) return path
        ownershipChanged = true
        return `${destinationPath}${path.slice(sourcePath.length)}`
      })
    }
    if (ownershipChanged) await this.writeModOwnership(installation, bindingId, ownership)
    return { sourcePath, destinationPath }
  }

  async removeEntries(
    installation: GravitInstallation,
    bindingId: string,
    relativePaths: string[],
  ) {
    const unique = [...new Set(relativePaths)].filter((path, _, paths) =>
      !paths.some((parent) => parent !== path && path.startsWith(`${parent}/`)))
    const removed: string[] = []
    for (const relativePath of unique) {
      const source = this.safePath(installation, bindingId, relativePath)
      const metadata = await lstat(source)
      if (!metadata.isFile() && !metadata.isDirectory()) throw new Error('Server pack entry is invalid')
      const trash = join(
        installation.path,
        'server-packs',
        this.requireBinding(installation, bindingId).profileName,
        'bindings',
        bindingId,
        '.trash',
        `${safeTimestamp()}-${crypto.randomUUID()}-${basename(source)}`,
      )
      await mkdir(dirname(trash), { recursive: true })
      await rename(source, trash)
      removed.push(relativePath)
    }
    const ownership = await this.readModOwnership(installation, bindingId)
    let ownershipChanged = false
    for (const [projectId, root] of Object.entries(ownership.roots)) {
      root.artifacts = root.artifacts.filter((artifact) => {
        const deleted = unique.some((path) => artifact.path === path || artifact.path.startsWith(`${path}/`))
        ownershipChanged ||= deleted
        return !deleted
      })
      if (!root.artifacts.some((artifact) => artifact.root)) {
        delete ownership.roots[projectId]
        ownershipChanged = true
      }
    }
    if (ownership.orphans?.length) {
      const next = ownership.orphans.filter((orphan) =>
        !unique.some((path) => orphan === path || orphan.startsWith(`${path}/`)))
      ownershipChanged ||= next.length !== ownership.orphans.length
      ownership.orphans = next
    }
    if (ownershipChanged) await this.writeModOwnership(installation, bindingId, ownership)
    return { removed }
  }

  async removeFile(
    installation: GravitInstallation,
    bindingId: string,
    relativePath: string,
  ) {
    const source = this.safePath(installation, bindingId, relativePath)
    if (!(await lstat(source)).isFile()) throw new Error('Server pack path is not a file')
    const trash = join(
      installation.path,
      'server-packs',
      this.requireBinding(installation, bindingId).profileName,
      'bindings',
      bindingId,
      '.trash',
      `${safeTimestamp()}-${crypto.randomUUID()}-${basename(source)}`,
    )
    await mkdir(dirname(trash), { recursive: true })
    await rename(source, trash)
    return { path: relativePath, trashPath: trash }
  }

  async installMod(
    installation: GravitInstallation,
    bindingId: string,
    slug: string,
  ) {
    return this.installMods(installation, bindingId, [slug])
  }

  async installMods(
    installation: GravitInstallation,
    bindingId: string,
    slugs: string[],
    context?: Pick<JobTaskContext, 'log'>,
  ) {
    const binding = this.requireBinding(installation, bindingId)
    const profile = await this.clients.getProfile(installation, binding.profileName)
    if (!profile.minecraftVersion || !profile.loader || profile.loader === 'VANILLA') {
      throw new Error('Profile must use a supported mod loader')
    }
    const artifacts = new Map<string, Awaited<ReturnType<ModrinthService['resolveServerInstall']>>[number]>()
    const resolvedRoots = new Map<string, ServerModOwnership['roots'][string]>()
    const filenames = new Map<string, string>()
    for (const [index, slug] of [...new Set(slugs)].entries()) {
      context?.log(`Resolving server mod ${index + 1}/${slugs.length}: ${slug}`)
      const resolved = await this.modrinth.resolveServerInstall(
        slug,
        profile.minecraftVersion,
        profile.loader,
      )
      const root = resolved.find((item) => item.root)
      if (!root) throw new Error(`Modrinth did not return a root artifact for ${slug}`)
      resolvedRoots.set(root.projectId, {
        slug: root.slug,
        artifacts: resolved.map((item) => ({
          projectId: item.projectId,
          path: `mods/${item.file.filename}`,
          root: item.root,
        })),
      })
      for (const item of resolved) {
        const digest = item.file.hashes.sha512
        const existingDigest = filenames.get(item.file.filename)
        if (existingDigest && existingDigest !== digest) {
          throw new Error(`Conflicting Modrinth files resolve to ${item.file.filename}`)
        }
        filenames.set(item.file.filename, digest)
        artifacts.set(digest, item)
      }
    }
    const installed = []
    let index = 0
    for (const item of artifacts.values()) {
      index += 1
      context?.log(`Downloading server mod file ${index}/${artifacts.size}: ${item.file.filename}`)
      const bytes = await this.modrinth.download(item.file)
      installed.push(
        await this.putFile(
          installation,
          bindingId,
          `mods/${item.file.filename}`,
          bytes,
        ),
      )
    }
    const ownership = await this.readModOwnership(installation, bindingId)
    for (const [projectId, root] of resolvedRoots) {
      ownership.roots[projectId] = root
      const installedPaths = new Set(root.artifacts.map((item) => item.path))
      ownership.orphans = (ownership.orphans ?? []).filter((path) => !installedPaths.has(path))
    }
    await this.writeModOwnership(installation, bindingId, ownership)
    return { installed, requestedSlugs: [...new Set(slugs)] }
  }

  async removeMod(
    installation: GravitInstallation,
    bindingId: string,
    mod: { projectId: string; slug: string; filename: string },
    removeUnusedDependencies: boolean,
  ) {
    this.requireBinding(installation, bindingId)
    const ownership = await this.readModOwnership(installation, bindingId)
    const matchingRoots = Object.entries(ownership.roots).filter(
      ([projectId, root]) => projectId === mod.projectId || root.slug === mod.slug,
    )
    const paths = new Set<string>()
    for (const [projectId] of matchingRoots) delete ownership.roots[projectId]

    const retainedPaths = new Set(
      Object.values(ownership.roots).flatMap((root) => root.artifacts.map((item) => item.path)),
    )
    for (const [, root] of matchingRoots) {
      for (const artifact of root.artifacts) {
        if (artifact.root && !retainedPaths.has(artifact.path)) paths.add(artifact.path)
      }
    }
    const newlyOrphaned = matchingRoots.flatMap(([, root]) =>
      root.artifacts.filter((artifact) => !artifact.root && !retainedPaths.has(artifact.path)).map((artifact) => artifact.path))
    if (removeUnusedDependencies) {
      for (const path of ownership.orphans ?? []) {
        if (!retainedPaths.has(path)) paths.add(path)
      }
      for (const [, root] of matchingRoots) {
        for (const artifact of root.artifacts) {
          if (!retainedPaths.has(artifact.path)) paths.add(artifact.path)
        }
      }
      ownership.orphans = []
    } else {
      ownership.orphans = [...new Set([...(ownership.orphans ?? []), ...newlyOrphaned])]
    }
    if (!matchingRoots.length) {
      const matchingPath = `mods/${mod.filename.replace(/\.disabled$/, '')}`
      const referenced = Object.values(ownership.roots).some((root) =>
        root.artifacts.some((artifact) =>
          artifact.projectId === mod.projectId || artifact.path === matchingPath))
      if (!referenced) paths.add(matchingPath)
    }

    const removed: string[] = []
    for (const path of paths) {
      try {
        await this.removeFile(installation, bindingId, path)
        removed.push(path)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    if (matchingRoots.length) await this.writeModOwnership(installation, bindingId, ownership)
    return { removed }
  }

  async publish(
    installation: GravitInstallation,
    bindingId: string,
    context: JobTaskContext,
  ) {
    const binding = this.requireBinding(installation, bindingId)
    const profileName = binding.profileName
    const profile = await this.clients.getProfile(installation, profileName)
    if (!profile.minecraftVersion || !profile.loader) {
      throw new Error('Profile compatibility metadata is incomplete')
    }
    if (profile.loader !== 'VANILLA' && !profile.loaderVersion) {
      throw new Error('Exact loader version cannot be derived from the profile')
    }
    context.progress(15, 'Hashing server pack workspace')
    const state = await this.listFiles(installation, bindingId)
    const totalSize = state.items.reduce((sum, file) => sum + file.size, 0)
    if (totalSize > maximumPackBytes) throw new Error('Server pack exceeds configured size limit')
    const root = await this.ensureWorkspace(installation, bindingId)
    const versionRoot = join(
      installation.path,
      'server-packs',
      profileName,
      'bindings',
      bindingId,
      'versions',
    )
    await mkdir(versionRoot, { recursive: true })
    const pending = join(versionRoot, `.pending-${crypto.randomUUID()}.tar.gz`)
    const manifest = {
      profileName,
      profileUuid: profile.uuid,
      minecraftVersion: profile.minecraftVersion,
      loader: profile.loader,
      loaderVersion: profile.loaderVersion,
      files: state.items.map(({ path, size, sha256: digest }) => ({
        path,
        size,
        sha256: digest,
      })),
    }
    context.progress(45, 'Creating immutable server pack archive')
    const process = Bun.spawn([
      'tar',
      '--sort=name',
      '--mtime=UTC 1970-01-01',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      pending,
      '-C',
      root,
      '.',
    ], { stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await process.exited
    if (exitCode !== 0) {
      throw new Error(`Failed to archive server pack: ${await new Response(process.stderr).text()}`)
    }
    const archive = new Uint8Array(await readFile(pending))
    const digest = sha256(archive)
    const finalPath = join(versionRoot, `${digest}.tar.gz`)
    await rename(pending, finalPath).catch(async (error) => {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        await rm(pending)
        return
      }
      throw error
    })
    const version = this.store.create({
      installationId: installation.id,
      profileName,
      bindingId,
      minecraftVersion: profile.minecraftVersion,
      loader: profile.loader,
      loaderVersion: profile.loaderVersion,
      fileCount: state.items.length,
      size: archive.length,
      sha256: digest,
      archivePath: finalPath,
      manifest,
    })
    context.progress(95, `Published server pack v${version.versionNumber}`)
    return { version }
  }

  archivePath(id: string) {
    return this.store.archivePath(id)
  }

  private workspace(
    installation: GravitInstallation,
    profileName: string,
    bindingId: string,
  ) {
    if (!profilePattern.test(profileName)) throw new Error('Profile name is invalid')
    return join(
      installation.path,
      'server-packs',
      profileName,
      'bindings',
      bindingId,
      'workspace',
    )
  }

  private ownershipPath(installation: GravitInstallation, bindingId: string) {
    const binding = this.requireBinding(installation, bindingId)
    return join(dirname(this.workspace(installation, binding.profileName, bindingId)), 'mod-ownership.json')
  }

  private async readModOwnership(installation: GravitInstallation, bindingId: string) {
    try {
      const parsed = JSON.parse(await readFile(this.ownershipPath(installation, bindingId), 'utf8')) as ServerModOwnership
      return parsed && typeof parsed.roots === 'object' && parsed.roots
        ? parsed
        : { roots: {}, orphans: [] }
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        return { roots: {}, orphans: [] } satisfies ServerModOwnership
      }
      throw error
    }
  }

  private async writeModOwnership(
    installation: GravitInstallation,
    bindingId: string,
    ownership: ServerModOwnership,
  ) {
    const path = this.ownershipPath(installation, bindingId)
    await mkdir(dirname(path), { recursive: true })
    const pending = `${path}.${crypto.randomUUID()}.pending`
    await writeFile(pending, `${JSON.stringify(ownership, null, 2)}\n`, { mode: 0o600 })
    await rename(pending, path)
  }

  private safePath(
    installation: GravitInstallation,
    bindingId: string,
    relativePath: string,
  ) {
    if (
      !relativePath ||
      relativePath.includes('\0') ||
      relativePath.startsWith('/') ||
      relativePath.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')
    ) throw new Error('Unsafe server pack path')
    const first = relativePath.split(/[\\/]/)[0]!.toLowerCase()
    if (reservedRoots.has(first) || first.startsWith('.gravit-panel')) {
      throw new Error('Path is reserved by the bootstrap installer')
    }
    const binding = this.requireBinding(installation, bindingId)
    const root = resolve(this.workspace(installation, binding.profileName, bindingId))
    const target = resolve(root, relativePath)
    if (!target.startsWith(`${root}${sep}`)) throw new Error('Server pack path escapes workspace')
    return target
  }

  private requireBinding(installation: GravitInstallation, bindingId: string) {
    const binding = this.bindings.get(bindingId)
    if (!binding || binding.installationId !== installation.id || !binding.id) {
      throw new Error('Managed server binding not found')
    }
    return binding
  }

  private async ensureWorkspace(
    installation: GravitInstallation,
    bindingId: string,
  ) {
    const binding = this.requireBinding(installation, bindingId)
    const root = this.workspace(installation, binding.profileName, bindingId)
    const marker = join(dirname(root), '.workspace-initialized')
    await mkdir(root, { recursive: true })
    try {
      if ((await lstat(marker)).isFile()) return root
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const selectedArchive = binding.packVersionId
      ? this.store.archivePath(binding.packVersionId)
      : null
    if (selectedArchive) {
      const process = Bun.spawn(
        ['tar', '-xzf', selectedArchive, '--no-same-owner', '-C', root],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      if (await process.exited !== 0) {
        throw new Error(
          `Failed to initialize server pack workspace: ${await new Response(process.stderr).text()}`,
        )
      }
    } else {
      const legacy = join(
        installation.path,
        'server-packs',
        binding.profileName,
        'workspace',
      )
      try {
        if ((await lstat(legacy)).isDirectory()) {
          await cp(legacy, root, { recursive: true, force: false })
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 })
    return root
  }

  private async assertPackSize(root: string) {
    let size = 0
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile()) size += (await stat(path)).size
      }
    }
    await walk(root)
    if (size > maximumPackBytes) throw new Error('Server pack exceeds configured size limit')
  }

  private async assertMissing(path: string) {
    try {
      await lstat(path)
      throw new Error('Destination already exists')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
  }

  private async assertDirectory(path: string) {
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Destination parent is not a directory')
    }
  }

  private async assertSafeAncestors(root: string, target: string) {
    const parts = relative(root, dirname(target)).split(sep).filter(Boolean)
    let current = root
    for (const part of parts) {
      current = join(current, part)
      try {
        const metadata = await lstat(current)
        if (metadata.isSymbolicLink()) throw new Error('Server pack path contains a symbolic link')
        if (!metadata.isDirectory()) throw new Error('Server pack path parent is not a directory')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
        throw error
      }
    }
  }
}
