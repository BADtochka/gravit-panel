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

  test('enriches installed mods with the same Modrinth name and description used at install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-mod-metadata-'))
    const directory = join(root, 'launcher', 'updates', 'fabric', 'mods')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'rei.jar'), 'mod')
    const service = new ModManagerService(
      {} as ControlFileService,
      {
        versionsFromHashes: async (hashes: string[]) => ({
          [hashes[0]!]: {
            id: 'rei-version',
            project_id: 'rei-project',
            version_number: '1.0.0',
          },
        }),
        projectsByIds: async () => ({
          'rei-project': {
            id: 'rei-project',
            slug: 'roughly-enough-items',
            title: 'Roughly Enough Items (REI)',
            description: 'View items and recipes.',
            client_side: 'required',
            server_side: 'optional',
          },
        }),
      } as unknown as ModrinthService,
      localVolume,
    )

    try {
      const result = await service.list(installationFor(root), 'fabric')
      expect(result.items[0]).toMatchObject({
        name: 'Roughly Enough Items (REI)',
        description: 'View items and recipes.',
        slug: 'roughly-enough-items',
        serverSide: 'optional',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('disable is reversible and removal deletes the file permanently', async () => {
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
      expect(removed).toEqual({
        installationId: installation.id,
        profile: 'fabric',
        filename: 'sodium.jar.disabled',
      })
      await expect(access(join(directory, 'sodium.jar.disabled'))).rejects.toThrow()
      await expect(access(join(directory, '.gravit-panel-trash'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('applies one bulk action to every selected installed mod', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-mod-bulk-'))
    const directory = join(root, 'launcher', 'updates', 'fabric', 'mods')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'sodium.jar'), 'sodium')
    await writeFile(join(directory, 'iris.jar'), 'iris')
    const service = new ModManagerService(
      {} as ControlFileService,
      {} as ModrinthService,
      localVolume,
    )

    try {
      const result = await service.bulk(
        installationFor(root),
        {
          profile: 'fabric',
          filenames: ['sodium.jar', 'iris.jar'],
          action: 'disable',
        },
        context,
      )

      expect(result.count).toBe(2)
      expect(await readFile(join(directory, 'sodium.jar.disabled'), 'utf8')).toBe('sodium')
      expect(await readFile(join(directory, 'iris.jar.disabled'), 'utf8')).toBe('iris')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('installs selected client files and publishes each server pack only once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-mod-targets-'))
    const installation = installationFor(root)
    const bindingId = crypto.randomUUID()
    const installedOnServer: string[] = []
    let optionalInputs: unknown[] = []
    let removedOptionalProjectIds: string[] = []
    let published = 0
    let reloaded = 0
    const service = new ModManagerService(
      {} as ControlFileService,
      {
        resolveInstall: async (slug: string) => (
          slug === 'lithium'
            ? ['architectury', 'cloth-config', 'lithium']
            : [slug]
        ).map((projectId) => ({
          projectId,
          slug: projectId,
          title: projectId,
          root: projectId === slug,
          version: {},
          file: {
            filename: `${projectId}.jar`,
            size: 3,
            hashes: { sha1: '', sha512: '' },
          },
        })),
        download: async () => new TextEncoder().encode('mod'),
      } as unknown as ModrinthService,
      localVolume,
      {
        upsertOptionalMods: async (
          _installation: GravitInstallation,
          _profile: string,
          inputs: unknown[],
          _context: JobTaskContext,
          removeProjectIds: string[],
        ) => {
          optionalInputs = inputs
          removedOptionalProjectIds = removeProjectIds
          return { profile: {} }
        },
        reloadProfileUpdates: async () => {
          reloaded += 1
        },
      } as never,
      {
        installMods: async (
          _installation: GravitInstallation,
          _bindingId: string,
          slugs: string[],
        ) => {
          installedOnServer.push(...slugs)
          return { installed: [] }
        },
        publish: async () => {
          published += 1
          return { version: { id: crypto.randomUUID() } }
        },
      } as never,
      {
        get: () => ({
          id: bindingId,
          installationId: installation.id,
          profileName: 'fabric',
        }),
        setDesiredPack: () => null,
      } as never,
    )

    try {
      await service.install(
        installation,
        {
          installationId: installation.id,
          profile: 'fabric',
          minecraftVersion: '1.21.1',
          loader: 'FABRIC',
          slugs: ['sodium', 'lithium'],
          selections: [
            { slug: 'sodium', clientMode: 'required', serverBindingIds: [bindingId] },
            {
              slug: 'lithium',
              clientMode: 'optional',
              optionalEnabledByDefault: true,
              optionalName: 'Fast server ticks',
              optionalDescription: 'Optional Lithium optimization',
              serverBindingIds: [bindingId],
            },
          ],
        },
        context,
      )

      expect(await readFile(
        join(root, 'launcher', 'updates', 'fabric', 'mods', 'sodium.jar'),
        'utf8',
      )).toBe('mod')
      expect(await readFile(
        join(root, 'launcher', 'updates', 'fabric', 'mods', 'architectury.jar'),
        'utf8',
      )).toBe('mod')
      expect(await readFile(
        join(root, 'launcher', 'updates', 'fabric', 'mods', 'cloth-config.jar'),
        'utf8',
      )).toBe('mod')
      expect(await readFile(
        join(
          root,
          'launcher',
          'updates',
          'fabric',
          '.gravit-panel-optional',
          'mods',
          'lithium',
          'lithium.jar',
        ),
        'utf8',
      )).toBe('mod')
      expect(optionalInputs).toEqual([{
        projectId: 'lithium',
        title: 'Fast server ticks',
        description: 'Optional Lithium optimization',
        filename: 'lithium.jar',
        sourcePath: '.gravit-panel-optional/mods/lithium/lithium.jar',
        enabledByDefault: true,
      }])
      expect(removedOptionalProjectIds).toEqual(['architectury', 'cloth-config'])
      expect(reloaded).toBe(0)
      expect(installedOnServer).toEqual(['sodium', 'lithium'])
      expect(published).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('identifies selected mods without an install destination', async () => {
    const installation = installationFor('/tmp/gravit-mod-destinations')
    const service = new ModManagerService(
      {} as ControlFileService,
      {} as ModrinthService,
      localVolume,
      {} as never,
      {} as never,
      {} as never,
    )

    await expect(service.install(installation, {
      installationId: installation.id,
      profile: 'main',
      minecraftVersion: '1.21.1',
      loader: 'NEOFORGE',
      slugs: ['melody'],
      selections: [{ slug: 'melody', clientMode: 'none', serverBindingIds: [] }],
    }, context)).rejects.toThrow('Select an install destination for: melody')
  })

  test('imports Modrinth packs with optional client files and server overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-modpack-import-'))
    const installation = installationFor(root)
    const bindingId = crypto.randomUUID()
    const serverFiles: string[] = []
    let optionalInputs: unknown[] = []
    let clientBuildInput: unknown = null
    const service = new ModManagerService(
      {} as ControlFileService,
      {
        resolveModpack: async () => ({
          inspection: {
            projectId: 'pack-id',
            slug: 'pack',
            name: 'Test pack',
            summary: '',
            versionId: 'version-id',
            versionName: '1.0.0',
            minecraftVersion: '1.21.1',
            loader: 'NEOFORGE',
            loaderVersion: '21.1.243',
            clientOverrideCount: 1,
            serverOverrideCount: 1,
            files: [{
              path: 'mods/example.jar',
              size: 3,
              sha1: 'hash',
              client: 'optional',
              server: 'required',
              projectId: 'example-project',
              name: 'Example',
              description: 'Example description',
            }],
          },
          files: [{
            path: 'mods/example.jar',
            fileSize: 3,
            hashes: { sha1: 'hash', sha512: 'hash512' },
            env: { client: 'optional', server: 'required' },
            downloads: ['https://cdn.modrinth.com/example.jar'],
          }],
          overrides: [
            {
              side: 'client',
              path: 'config/client.json',
              bytes: new TextEncoder().encode('client'),
            },
            {
              side: 'server',
              path: 'config/server.json',
              bytes: new TextEncoder().encode('server'),
            },
          ],
        }),
        downloadPackFile: async () => new TextEncoder().encode('mod'),
      } as unknown as ModrinthService,
      localVolume,
      {
        listProfiles: async () => ({
          items: [{
            name: 'fabric',
            minecraftVersion: '1.21.1',
            loader: 'NEOFORGE',
            loaderVersion: '21.1.244',
          }],
        }),
        buildClient: async (
          _installation: GravitInstallation,
          input: unknown,
        ) => {
          clientBuildInput = input
          return {}
        },
        upsertOptionalMods: async (
          _installation: GravitInstallation,
          _profile: string,
          inputs: unknown[],
        ) => {
          optionalInputs = inputs
          return { profile: {} }
        },
        reloadProfileUpdates: async () => {},
      } as never,
      {
        putFile: async (
          _installation: GravitInstallation,
          _bindingId: string,
          path: string,
        ) => {
          serverFiles.push(path)
          return {}
        },
        publish: async () => ({ version: { id: 'pack-version' } }),
      } as never,
      {
        get: () => ({
          id: bindingId,
          installationId: installation.id,
          profileName: 'fabric',
        }),
        setDesiredPack: () => null,
      } as never,
    )

    try {
      const result = await service.importModpack(
        installation,
        {
          installationId: installation.id,
          profile: 'fabric',
          projectId: 'pack-id',
          minecraftVersion: '1.21.1',
          loader: 'NEOFORGE',
          loaderVersion: '21.1.243',
          serverBindingIds: [bindingId],
          files: [{
            path: 'mods/example.jar',
            clientMode: 'optional',
            enabledByDefault: true,
            installOnServer: true,
            name: 'Custom example',
            description: 'Shown in the launcher',
          }],
        },
        context,
      )

      expect(optionalInputs).toEqual([{
        projectId: 'mrpack-pack-id-f31770ab0b06',
        title: 'Custom example',
        description: 'Shown in the launcher',
        filename: 'example.jar',
        sourcePath:
          '.gravit-panel-optional/mods/mrpack-pack-id-f31770ab0b06/example.jar',
        destinationPath: 'mods/example.jar',
        enabledByDefault: true,
      }])
      expect(clientBuildInput).toEqual({
        installationId: installation.id,
        name: 'fabric',
        minecraftVersion: '1.21.1',
        loader: 'NEOFORGE',
        loaderVersion: '21.1.243',
        mods: [],
      })
      expect(serverFiles).toEqual(['mods/example.jar', 'config/server.json'])
      expect(await readFile(
        join(root, 'launcher', 'updates', 'fabric', 'config', 'client.json'),
        'utf8',
      )).toBe('client')
      expect(result.serverPackVersionIds).toEqual(['pack-version'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
