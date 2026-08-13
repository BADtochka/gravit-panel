import type { GravitInstallation, ServerPackEntry, ServerPackTextFile } from '@gravit-panel/shared'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { ContainerVolumeService } from '../docker/container-volume.service'

const maximumFileBytes = 512 * 1024
const trashRoot = '.gravit-panel-trash'
const blockedPaths = [
  'control-file',
  'build-secrets.json',
  'launchserver.json',
  'null',
  'truststore',
  'config/discordauthsystem',
  'config/fileauthsystem',
  'config/launchserver.json',
  'config/remotecontrol',
]

export class LaunchServerFilesService {
  constructor(private readonly volume = new ContainerVolumeService()) {}

  async list(installation: GravitInstallation, path = ''): Promise<{ path: string; entries: ServerPackEntry[] }> {
    const safePath = this.safePath(path, true)
    if (safePath) await this.volume.assertNoSymlinks(installation, safePath)
    const entries = await this.volume.listEntries(installation, safePath)
    return {
      path: safePath,
      entries: entries.filter((entry) => {
        try { this.safePath(entry.path); return true } catch { return false }
      }).slice(0, 500).map((entry) => ({ ...entry, sha256: null })),
    }
  }

  async read(installation: GravitInstallation, path: string): Promise<ServerPackTextFile> {
    const safePath = this.safePath(path)
    await this.volume.assertNoSymlinks(installation, safePath)
    const bytes = await this.volume.readFileBytes(installation, safePath, maximumFileBytes)
    if (bytes.includes(0)) throw new Error('Binary files cannot be opened in the text editor')
    return {
      path: safePath,
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }

  async write(installation: GravitInstallation, path: string, bytes: Uint8Array, overwrite: boolean) {
    if (bytes.length > maximumFileBytes) throw new Error('File exceeds 512 KiB')
    const safePath = this.safePath(path)
    await this.volume.assertNoSymlinks(installation, safePath, false)
    if (!overwrite && await this.volume.exists(installation, safePath)) throw new Error('Destination already exists')
    await this.volume.writeFileAtomic(installation, safePath, bytes)
    return { path: safePath, size: bytes.length }
  }

  async mkdir(installation: GravitInstallation, path: string) {
    const safePath = this.safePath(path)
    await this.volume.assertNoSymlinks(installation, safePath, false)
    if (await this.volume.exists(installation, safePath, 'directory')) throw new Error('Destination already exists')
    await this.volume.ensureDirectory(installation, safePath)
    return { path: safePath }
  }

  async move(installation: GravitInstallation, sourcePath: string, destinationPath: string) {
    const source = this.safePath(sourcePath)
    const destination = this.safePath(destinationPath)
    await this.volume.assertNoSymlinks(installation, source)
    await this.volume.assertNoSymlinks(installation, destination, false)
    if (await this.volume.exists(installation, destination) || await this.volume.exists(installation, destination, 'directory')) {
      throw new Error('Destination already exists')
    }
    await this.volume.move(installation, source, destination)
    return { sourcePath: source, destinationPath: destination }
  }

  async remove(installation: GravitInstallation, paths: string[]) {
    await this.volume.ensureDirectory(installation, trashRoot)
    const removed: string[] = []
    for (const path of paths) {
      const safePath = this.safePath(path)
      await this.volume.assertNoSymlinks(installation, safePath)
      const destination = `${trashRoot}/${Date.now()}-${crypto.randomUUID()}-${posix.basename(safePath)}`
      await this.volume.move(installation, safePath, destination)
      removed.push(safePath)
    }
    return { paths: removed }
  }

  private safePath(path: string, allowRoot = false) {
    if (path.includes('\0') || path.includes('\\') || posix.isAbsolute(path)) throw new Error('Invalid file path')
    const normalized = posix.normalize(path || '.')
    if (normalized === '.') {
      if (allowRoot) return ''
      throw new Error('A file path is required')
    }
    if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').length > 32) {
      throw new Error('File path escapes the LaunchServer data directory')
    }
    const lower = normalized.toLowerCase()
    if (normalized.split('/').some((part) => part.startsWith('.')) || blockedPaths.some((item) => lower === item || lower.startsWith(`${item}/`))) {
      throw new Error('This LaunchServer path is protected')
    }
    return normalized
  }
}
