import type {
  GravitInstallation,
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
    await mkdir(dirname(target), { recursive: true })
    const pending = join(root, `.gravit-panel-${crypto.randomUUID()}.pending`)
    await writeFile(pending, bytes, { mode: 0o600 })
    await rename(pending, target)
    await this.assertPackSize(root)
    return { path: relativePath, size: bytes.length, sha256: sha256(bytes) }
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
    const binding = this.requireBinding(installation, bindingId)
    const profile = await this.clients.getProfile(installation, binding.profileName)
    if (!profile.minecraftVersion || !profile.loader || profile.loader === 'VANILLA') {
      throw new Error('Profile must use a supported mod loader')
    }
    const resolved = await this.modrinth.resolveServerInstall(
      slug,
      profile.minecraftVersion,
      profile.loader,
    )
    const installed = []
    for (const item of resolved) {
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
    return { installed }
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
}
