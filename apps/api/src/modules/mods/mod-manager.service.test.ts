import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { VolumeFileOperations } from '../docker/container-volume.service'
import type { ControlFileService } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { ModManagerService } from './mod-manager.service'
import type { ModrinthService } from './modrinth.service'

const installationFor = (path: string): GravitInstallation => {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name: 'test',
    path,
    address: 'localhost:17549',
    projectName: 'TEST',
    sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
    sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
    createdAt: now,
    updatedAt: now,
  }
}
const context: JobTaskContext = {
  signal: new AbortController().signal,
  log: () => {},
  progress: () => {},
}
const localVolume: VolumeFileOperations = {
  exists: async (installation, path, kind = 'file') => {
    try {
      const metadata = await lstat(join(installation.path, 'launcher', path))
      return kind === 'directory' ? metadata.isDirectory() : metadata.isFile()
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  },
  ensureDirectory: async (installation, path) => {
    await mkdir(join(installation.path, 'launcher', path), { recursive: true })
  },
  writeFileAtomic: async (installation, path, bytes) => {
    const target = join(installation.path, 'launcher', path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  },
  copy: async (installation, source, target) => {
    const destination = join(installation.path, 'launcher', target)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(installation.path, 'launcher', source), destination, { recursive: true })
  },
  move: async (installation, source, target) => {
    const destination = join(installation.path, 'launcher', target)
    await mkdir(dirname(destination), { recursive: true })
    await rename(join(installation.path, 'launcher', source), destination)
  },
  remove: async (installation, path, recursive = false) => {
    await rm(join(installation.path, 'launcher', path), { recursive, force: true })
  },
}

describe('ModManagerService', () => {
  test('keeps installed-mod inspection read-only when the profile is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-mod-list-'))
    const service = new ModManagerService(
      {} as ControlFileService,
      { versionsFromHashes: async () => ({}) } as unknown as ModrinthService,
      localVolume,
    )

    try {
      const result = await service.list(installationFor(root), 'missing')
      expect(result.items).toEqual([])
      await expect(
        access(join(root, 'launcher', 'updates', 'missing', 'mods')),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('disable is reversible and removal moves the file to recoverable trash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-mod-actions-'))
    const directory = join(root, 'launcher', 'updates', 'fabric', 'mods')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'sodium.jar'), 'mod')
    const service = new ModManagerService(
      {} as ControlFileService,
      {} as ModrinthService,
      localVolume,
    )
    const installation = installationFor(root)

    try {
      const disabled = await service.toggle(
        installation,
        'fabric',
        'sodium.jar',
        false,
        context,
      )
      expect(disabled.filename).toBe('sodium.jar.disabled')
      expect(await readFile(join(directory, 'sodium.jar.disabled'), 'utf8')).toBe('mod')

      const removed = await service.remove(
        installation,
        'fabric',
        'sodium.jar.disabled',
        context,
      )
      expect(removed.trashPath).toContain('.gravit-panel-trash')
      expect(await readFile(removed.trashPath, 'utf8')).toBe('mod')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
