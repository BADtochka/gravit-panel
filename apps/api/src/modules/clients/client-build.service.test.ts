import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlFileService } from '../gravit/control-file.service'
import type { VolumeFileOperations } from '../docker/container-volume.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import type { ModuleManagementService } from '../modules/module-management.service'
import { ModuleManagementService as RuntimeModuleManagementService } from '../modules/module-management.service'
import {
  ClientBuildService,
  inferProfileLoader,
  inferProfileLoaderVersion,
} from './client-build.service'
import type { LoaderInstallerProvider } from './loader-installer.service'

const context = (): JobTaskContext => ({
  signal: new AbortController().signal,
  log: () => {},
  progress: () => {},
})

describe('ClientBuildService', () => {
  test.each([
    [
      'NEOFORGE',
      {
        mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
        clientArgs: ['--fml.neoForgeVersion', '21.1.244'],
      },
    ],
    ['FORGE', { clientArgs: ['--fml.forgeVersion', '47.3.0'] }],
    ['FABRIC', { mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient' }],
    ['QUILT', { mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient' }],
    ['VANILLA', { mainClass: 'net.minecraft.client.main.Main' }],
  ] as const)('detects %s from generated profile metadata', (loader, profile) => {
    expect(inferProfileLoader(profile)).toBe(loader)
  })

  test.each([
    ['/net/fabricmc/fabric-loader/0.16.14/fabric-loader-0.16.14.jar', '0.16.14'],
    ['/net/neoforged/neoforge/21.1.244/neoforge-21.1.244.jar', '21.1.244'],
    ['/net/minecraftforge/forge/1.20.1-47.3.0/forge-1.20.1-47.3.0.jar', '47.3.0'],
  ])('extracts exact server loader version from %s', (classPath, version) => {
    expect(inferProfileLoaderVersion({ classPath: [classPath] })).toBe(version)
  })

  test('lists built profiles with detected Minecraft version and loader', async () => {
    const installation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: '/srv/gravit/default',
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies GravitInstallation
    const volume = {
      listFiles: async () => ['main.json', 'broken.json', 'ignore.txt'],
      readFile: async (_installation: GravitInstallation, path: string) => {
        if (path === 'profiles/broken.json') return '{'
        return JSON.stringify({
          uuid: '65f6ac32-f8d2-4c63-8ebb-733e50d613d5',
          title: 'Main client',
          info: 'Primary profile',
          sortIndex: -10,
          version: '1.21.1',
          clientArgs: ['--fml.neoForgeVersion', '21.1.244'],
        })
      },
    } as unknown as VolumeFileOperations
    const service = new ClientBuildService({} as ControlFileService, volume)

    expect(await service.listProfiles(installation)).toEqual({
      items: [
        {
          name: 'main',
          uuid: '65f6ac32-f8d2-4c63-8ebb-733e50d613d5',
          title: 'Main client',
          description: 'Primary profile',
          sortIndex: -10,
          minecraftVersion: '1.21.1',
          loader: 'NEOFORGE',
          loaderVersion: '21.1.244',
          servers: [],
        },
        {
          name: 'broken',
          uuid: null,
          title: 'broken',
          description: '',
          sortIndex: 0,
          minecraftVersion: null,
          loader: null,
          loaderVersion: null,
          servers: [],
        },
      ],
    })
  })

  test('updates profile metadata and moves removed profile data to recoverable trash', async () => {
    const profileJson = JSON.stringify({
      uuid: '65f6ac32-f8d2-4c63-8ebb-733e50d613d5',
      title: 'Main',
      info: 'Old description',
      dir: 'main',
      sortIndex: 0,
      version: '1.21.1',
      servers: [],
    })
    const paths = new Map<string, 'file' | 'directory'>([
      ['profiles/main.json', 'file'],
      ['updates/main', 'directory'],
    ])
    const files = new Map([['profiles/main.json', profileJson]])
    const volume = {
      exists: async (_installation: GravitInstallation, path: string, kind = 'file') =>
        paths.get(path) === kind,
      readFile: async (_installation: GravitInstallation, path: string) => {
        const value = files.get(path)
        if (value === undefined) throw new Error(`Missing ${path}`)
        return value
      },
      writeFileAtomic: async (
        _installation: GravitInstallation,
        path: string,
        bytes: Uint8Array,
      ) => {
        paths.set(path, 'file')
        files.set(path, new TextDecoder().decode(bytes))
      },
      copy: async (_installation: GravitInstallation, source: string, target: string) => {
        const kind = paths.get(source)
        if (!kind) throw new Error(`Missing ${source}`)
        paths.set(target, kind)
        const value = files.get(source)
        if (value !== undefined) files.set(target, value)
      },
      move: async (_installation: GravitInstallation, source: string, target: string) => {
        const kind = paths.get(source)
        if (!kind) throw new Error(`Missing ${source}`)
        paths.delete(source)
        paths.set(target, kind)
        const value = files.get(source)
        if (value !== undefined) {
          files.delete(source)
          files.set(target, value)
        }
      },
    } as VolumeFileOperations
    let restarts = 0
    let cacheInvalidations = 0
    volume.remove = async (_installation, path) => {
      if (path === '.updates-cache') cacheInvalidations += 1
      paths.delete(path)
      files.delete(path)
    }
    const service = new ClientBuildService(
      {} as ControlFileService,
      volume,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        restartLaunchServer: async () => {
          restarts += 1
        },
      },
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: '/srv/gravit/default',
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    const updated = await service.updateProfile(
      installation,
      {
        installationId: installation.id,
        name: 'main',
        title: 'Main server',
        description: 'Updated description',
        sortIndex: 20,
      },
      context(),
    )
    const saved = JSON.parse(files.get('profiles/main.json')!) as Record<string, unknown>

    expect(saved).toMatchObject({
      uuid: '65f6ac32-f8d2-4c63-8ebb-733e50d613d5',
      title: 'Main server',
      info: 'Updated description',
      sortIndex: 20,
      version: '1.21.1',
    })
    expect(updated.profile.title).toBe('Main server')
    expect(paths.get(updated.backupPath.split('/launcher/')[1]!)).toBe('file')

    const removed = await service.removeProfile(
      installation,
      {
        installationId: installation.id,
        name: 'main',
        confirmRemove: true,
      },
      context(),
    )

    expect(paths.has('profiles/main.json')).toBe(false)
    expect(paths.has('updates/main')).toBe(false)
    expect(
      [...paths.keys()].some((path) =>
        path.startsWith('.gravit-panel-trash/profiles/main-'),
      ),
    ).toBe(true)
    expect(removed.trashPath).toContain('.gravit-panel-trash/profiles/main-')
    expect(cacheInvalidations).toBe(2)
    expect(restarts).toBe(2)
  })

  test('keeps an already loaded Prestarter module and installs the verified executable', async () => {
    const paths = new Map<string, 'file' | 'directory'>()
    const commands: string[] = []
    const volume: VolumeFileOperations = {
      exists: async (_installation, path, kind = 'file') => paths.get(path) === kind,
      ensureDirectory: async (_installation, path) => {
        paths.set(path, 'directory')
      },
      writeFileAtomic: async (_installation, path) => {
        paths.set(path, 'file')
      },
      copy: async (_installation, source, target) => {
        const kind = paths.get(source)
        if (kind) paths.set(target, kind)
      },
      move: async (_installation, source, target) => {
        const kind = paths.get(source)
        paths.delete(source)
        if (kind) paths.set(target, kind)
      },
      remove: async (_installation, path) => {
        paths.delete(path)
      },
    }
    const control = {
      executeModuleCommand: async (_installation: GravitInstallation, command: string) => {
        commands.push(command)
        if (command === 'modules available') {
          return ['Found LaunchServer module \tPrestarter']
        }
        return ['[MODULE] Prestarter v: 1.0.0 p: 0 deps: [LaunchServerCore]']
      },
    } as unknown as ControlFileService
    const service = new ClientBuildService(
      control,
      volume,
      new RuntimeModuleManagementService(control),
      async () => new TextEncoder().encode('prestarter'),
      undefined,
      undefined,
      {
        restartLaunchServer: async () => {
          commands.push('restart')
        },
      },
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: '/srv/gravit/default',
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    const result = await service.installPrestarter(installation, context())

    expect(commands).toEqual([
      'modules available',
      'modules list',
      'restart',
      'modules available',
      'modules list',
    ])
    expect(paths.get('Prestarter.exe')).toBe('file')
    expect(result.path).toBe('/srv/gravit/default/launcher/Prestarter.exe')
  })

  test('loads MirrorHelper before applying its workspace manifest', async () => {
    const order: string[] = []
    const paths = new Map<string, 'file' | 'directory'>()
    const volume: VolumeFileOperations = {
      exists: async (_installation, path, kind = 'file') => paths.get(path) === kind,
      ensureDirectory: async (_installation, path) => {
        paths.set(path, 'directory')
      },
      writeFileAtomic: async (_installation, path) => {
        paths.set(path, 'file')
      },
      copy: async (_installation, source, target) => {
        const kind = paths.get(source)
        if (kind) paths.set(target, kind)
      },
      move: async (_installation, source, target) => {
        const kind = paths.get(source)
        paths.delete(source)
        if (kind) paths.set(target, kind)
      },
      remove: async (_installation, path) => {
        paths.delete(path)
      },
    }
    const modules = {
      install: async () => {
        order.push('load-module')
        return {} as never
      },
    } as unknown as Pick<ModuleManagementService, 'install'>
    const control = {
      executeClientCommand: async () => {
        order.push('apply-workspace')
        paths.set('config/MirrorHelper/workspace', 'directory')
        return ['Complete']
      },
    } as unknown as ControlFileService
    const service = new ClientBuildService(
      control,
      volume,
      modules,
      async () => new TextEncoder().encode('{}'),
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: '/srv/gravit/default',
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    const result = await service.applyWorkspace(installation, context())

    expect(order).toEqual(['load-module', 'apply-workspace'])
    expect(result.installationId).toBe(installation.id)
    expect(paths.get('config/MirrorHelper/workspace')).toBe('directory')
  })

  test('builds a typed MirrorHelper command and verifies profile outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-client-build-'))
    const launcher = join(root, 'launcher')
    await mkdir(join(launcher, 'config', 'MirrorHelper', 'workspace', 'authlib'), {
      recursive: true,
    })
    await mkdir(join(launcher, 'profiles'), { recursive: true })
    await mkdir(join(launcher, 'updates', 'fabric-1214'), { recursive: true })
    await mkdir(join(launcher, 'updates', 'assets', 'indexes'), { recursive: true })
    await writeFile(
      join(
        launcher,
        'config',
        'MirrorHelper',
        'workspace',
        'authlib',
        'LauncherAuthlib6.jar',
      ),
      'authlib',
    )
    await writeFile(
      join(launcher, 'profiles', 'fabric-1214.json'),
      JSON.stringify({ assetDir: 'assets', assetIndex: '17' }),
    )
    await writeFile(join(launcher, 'updates', 'assets', 'indexes', '17.json'), '{}')
    const commands: string[] = []
    const control = {
      executeClientCommand: async (_installation: GravitInstallation, command: string) => {
        commands.push(command)
        return ['Completed']
      },
    } as unknown as ControlFileService
    const volume = {
      exists: async (
        _installation: GravitInstallation,
        path: string,
        kind: 'file' | 'directory' = 'file',
      ) => {
        try {
          const metadata = await lstat(join(launcher, path))
          return kind === 'directory' ? metadata.isDirectory() : metadata.isFile()
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
          throw error
        }
      },
      readFile: async (_installation: GravitInstallation, path: string) =>
        readFile(join(launcher, path), 'utf8'),
      writeFileAtomic: async (
        _installation: GravitInstallation,
        path: string,
        bytes: Uint8Array,
      ) => writeFile(join(launcher, path), bytes),
      remove: async (_installation: GravitInstallation, path: string) => {
        if (path !== '.updates-cache') throw new Error(`Unexpected removal: ${path}`)
      },
    } as VolumeFileOperations
    let restarts = 0
    const service = new ClientBuildService(
      control,
      volume,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        restartLaunchServer: async () => {
          restarts += 1
        },
      },
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: root,
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    try {
      const result = await service.buildClient(
        installation,
        {
          installationId: installation.id,
          name: 'fabric-1214',
          minecraftVersion: '1.21.4',
          loader: 'FABRIC',
          mods: ['fabric-api', 'sodium'],
        },
        context(),
      )

      expect(commands).toEqual([
        'mirrorhelper setDisableDownloadAssets false',
        'installClient fabric-1214 1.21.4 FABRIC fabric-api,sodium',
      ])
      expect(restarts).toBe(2)
      expect(result.compatibility.authlibArtifact).toBe('LauncherAuthlib6.jar')
      expect(result.profilePath).toEndWith('profiles/fabric-1214.json')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a client build when MirrorHelper omits the asset index', async () => {
    const paths = new Map<string, 'file' | 'directory'>([
      ['config/MirrorHelper/workspace/authlib/LauncherAuthlib6.jar', 'file'],
      ['profiles/main.json', 'file'],
      ['updates/main', 'directory'],
    ])
    const volume = {
      exists: async (_installation: GravitInstallation, path: string, kind = 'file') =>
        paths.get(path) === kind,
      readFile: async () =>
        JSON.stringify({ assetDir: 'assets', assetIndex: '17' }),
    } as unknown as VolumeFileOperations
    const control = {
      executeClientCommand: async () => ['Completed'],
    } as unknown as ControlFileService
    const service = new ClientBuildService(control, volume)
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: '/srv/gravit/default',
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    await expect(
      service.buildClient(
        installation,
        {
          installationId: installation.id,
          name: 'main',
          minecraftVersion: '1.21.4',
          loader: 'FABRIC',
          mods: [],
        },
        context(),
      ),
    ).rejects.toThrow(
      'MirrorHelper did not download the required asset index updates/assets/indexes/17.json',
    )
  })

  test('preserves profile identity and presentation metadata across rebuilds', async () => {
    const oldUuid = '65f6ac32-f8d2-4c63-8ebb-733e50d613d5'
    const paths = new Map<string, 'file' | 'directory'>([
      ['config/MirrorHelper/workspace/authlib/LauncherAuthlib6.jar', 'file'],
      ['profiles/main.json', 'file'],
      ['updates/main', 'directory'],
      ['updates/assets/indexes/17.json', 'file'],
    ])
    const files = new Map<string, string>([
      [
        'profiles/main.json',
        JSON.stringify({
          uuid: oldUuid,
          title: 'Public title',
          info: 'Public description',
          sortIndex: 7,
          servers: [{ name: 'Play', serverAddress: 'play.example.com', serverPort: 25565 }],
          version: '1.21.1',
          assetDir: 'assets',
          assetIndex: '17',
        }),
      ],
    ])
    const commands: string[] = []
    let restarts = 0
    const volume = {
      exists: async (_installation: GravitInstallation, path: string, kind = 'file') =>
        paths.get(path) === kind,
      readFile: async (_installation: GravitInstallation, path: string) => files.get(path)!,
      writeFileAtomic: async (
        _installation: GravitInstallation,
        path: string,
        bytes: Uint8Array,
      ) => {
        expect(commands.at(-1)).toBe('installClient main 1.21.4 FABRIC')
        paths.set(path, 'file')
        files.set(path, new TextDecoder().decode(bytes))
      },
      remove: async (_installation: GravitInstallation, path: string) => {
        expect(path).toBe('.updates-cache')
      },
    } as VolumeFileOperations
    const control = {
      executeClientCommand: async (_installation: GravitInstallation, command: string) => {
        commands.push(command)
        if (command === 'installClient main 1.21.4 FABRIC') {
          files.set(
            'profiles/main.json',
            JSON.stringify({
              uuid: '1948970e-c046-40e0-9c0b-ea1c87c0fa30',
              title: 'main',
              info: 'Generated',
              sortIndex: 0,
              servers: [{ name: 'main', serverAddress: 'localhost', serverPort: 25565 }],
              version: '1.21.4',
              mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
              assetDir: 'assets',
              assetIndex: '17',
            }),
          )
        }
        return ['Completed']
      },
    } as unknown as ControlFileService
    const service = new ClientBuildService(
      control,
      volume,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        restartLaunchServer: async () => {
          if (restarts === 0) {
            expect(commands).toEqual([])
          } else {
            expect(commands.at(-1)).toBe('installClient main 1.21.4 FABRIC')
          }
          expect(JSON.parse(files.get('profiles/main.json')!).uuid).toBe(oldUuid)
          restarts += 1
        },
      },
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: '/srv/gravit/default',
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    await service.buildClient(
      installation,
      {
        installationId: installation.id,
        name: 'main',
        minecraftVersion: '1.21.4',
        loader: 'FABRIC',
        mods: [],
      },
      context(),
    )

    expect(JSON.parse(files.get('profiles/main.json')!)).toMatchObject({
      uuid: oldUuid,
      title: 'Public title',
      info: 'Public description',
      sortIndex: 7,
      servers: [
        { name: 'Play', serverAddress: 'play.example.com', serverPort: 25565 },
      ],
      version: '1.21.4',
    })
    expect(commands).toEqual([
      'mirrorhelper setDisableDownloadAssets false',
      'installClient main 1.21.4 FABRIC',
    ])
    expect(restarts).toBe(2)
  })

  test('downloads a missing NeoForge installer before building the client', async () => {
    const paths = new Map<string, 'file' | 'directory'>([
      ['config/MirrorHelper/workspace/authlib/LauncherAuthlib6.jar', 'file'],
    ])
    const files = new Map<string, string>()
    const commands: string[] = []
    const volume: VolumeFileOperations = {
      exists: async (_installation, path, kind = 'file') => paths.get(path) === kind,
      ensureDirectory: async (_installation, path) => {
        paths.set(path, 'directory')
      },
      writeFileAtomic: async (_installation, path) => {
        paths.set(path, 'file')
      },
      readFile: async (_installation, path) => {
        const value = files.get(path)
        if (value === undefined) throw new Error(`Missing ${path}`)
        return value
      },
      copy: async (_installation, source, target) => {
        const kind = paths.get(source)
        if (kind) paths.set(target, kind)
      },
      move: async (_installation, source, target) => {
        const kind = paths.get(source)
        paths.delete(source)
        if (kind) paths.set(target, kind)
      },
      remove: async (_installation, path) => {
        paths.delete(path)
      },
    }
    const control = {
      executeClientCommand: async (_installation: GravitInstallation, command: string) => {
        commands.push(command)
        if (command === 'installClient main 1.21.1 NEOFORGE') {
          paths.set('profiles/main.json', 'file')
          paths.set('updates/main', 'directory')
          paths.set('updates/assets/indexes/17.json', 'file')
          files.set(
            'profiles/main.json',
            JSON.stringify({ assetDir: 'assets', assetIndex: '17' }),
          )
        }
        return ['Completed']
      },
    } as unknown as ControlFileService
    const loaderInstallers: LoaderInstallerProvider = {
      download: async () => ({
        bytes: new TextEncoder().encode('verified-neoforge-installer'),
        filename: 'neoforge-1.21.1-installer-nogui.jar',
        loaderVersion: '21.1.244',
        sha256: 'a'.repeat(64),
        url:
          'https://maven.neoforged.net/releases/net/neoforged/neoforge/' +
          '21.1.244/neoforge-21.1.244-installer.jar',
      }),
    }
    const service = new ClientBuildService(
      control,
      volume,
      undefined,
      undefined,
      undefined,
      loaderInstallers,
      {
        restartLaunchServer: async () => {},
      },
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: '/srv/gravit/default',
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    const result = await service.buildClient(
      installation,
      {
        installationId: installation.id,
        name: 'main',
        minecraftVersion: '1.21.1',
        loader: 'NEOFORGE',
        mods: [],
      },
      context(),
    )

    expect(commands).toEqual([
      'mirrorhelper setDisableDownloadAssets false',
      'installClient main 1.21.1 NEOFORGE',
    ])
    expect(
      paths.get(
        'config/MirrorHelper/workspace/installers/neoforge-1.21.1-installer-nogui.jar',
      ),
    ).toBe('file')
    expect(result.loader).toBe('NEOFORGE')
  })

  test('reuses cached Forge installer data without downloading it again', async () => {
    const paths = new Map<string, 'file' | 'directory'>([
      ['config/MirrorHelper/workspace/authlib/LauncherAuthlib6.jar', 'file'],
      ['config/MirrorHelper/workspace/clients/forge/1.21.1', 'directory'],
    ])
    const files = new Map<string, string>()
    const commands: string[] = []
    const volume = {
      exists: async (_installation: GravitInstallation, path: string, kind = 'file') =>
        paths.get(path) === kind,
      readFile: async (_installation: GravitInstallation, path: string) => {
        const value = files.get(path)
        if (value === undefined) throw new Error(`Missing ${path}`)
        return value
      },
      remove: async () => {},
    } as unknown as VolumeFileOperations
    const control = {
      executeClientCommand: async (_installation: GravitInstallation, command: string) => {
        commands.push(command)
        if (command === 'installClient forge-main 1.21.1 FORGE') {
          paths.set('profiles/forge-main.json', 'file')
          paths.set('updates/forge-main', 'directory')
          paths.set('updates/assets/indexes/17.json', 'file')
          files.set(
            'profiles/forge-main.json',
            JSON.stringify({ assetDir: 'assets', assetIndex: '17' }),
          )
        }
        return ['Completed']
      },
    } as unknown as ControlFileService
    const service = new ClientBuildService(
      control,
      volume,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        restartLaunchServer: async () => {},
      },
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: '/srv/gravit/default',
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    await service.buildClient(
      installation,
      {
        installationId: installation.id,
        name: 'forge-main',
        minecraftVersion: '1.21.1',
        loader: 'FORGE',
        mods: [],
      },
      context(),
    )

    expect(commands).toEqual([
      'mirrorhelper setDisableDownloadAssets false',
      'installClient forge-main 1.21.1 FORGE',
    ])
  })

  test('removes a partial loader installer after a failed download', async () => {
    const installer =
      'config/MirrorHelper/workspace/installers/neoforge-1.21.1-installer-nogui.jar'
    const paths = new Map<string, 'file' | 'directory'>([
      ['config/MirrorHelper/workspace/authlib/LauncherAuthlib6.jar', 'file'],
    ])
    const removed: string[] = []
    const volume = {
      exists: async (_installation: GravitInstallation, path: string, kind = 'file') =>
        paths.get(path) === kind,
      remove: async (_installation: GravitInstallation, path: string) => {
        removed.push(path)
        paths.delete(path)
      },
    } as VolumeFileOperations
    const control = {
      executeClientCommand: async () => [],
    } as unknown as ControlFileService
    const loaderInstallers: LoaderInstallerProvider = {
      download: async () => {
        paths.set(installer, 'file')
        throw new Error('upstream download interrupted')
      },
    }
    const service = new ClientBuildService(
      control,
      volume,
      undefined,
      undefined,
      undefined,
      loaderInstallers,
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: '/srv/gravit/default',
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    expect(
      service.buildClient(
        installation,
        {
          installationId: installation.id,
          name: 'main',
          minecraftVersion: '1.21.1',
          loader: 'NEOFORGE',
          mods: [],
        },
        context(),
      ),
    ).rejects.toThrow(
      'Failed to prepare NEOFORGE installer for Minecraft 1.21.1: upstream download interrupted',
    )
    expect(paths.has(installer)).toBe(false)
    expect(removed).toContain(installer)
  })

  test('ensures LauncherRuntime before building launcher artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-launcher-build-'))
    const launcher = join(root, 'launcher')
    await mkdir(join(launcher, 'updates'), { recursive: true })
    await writeFile(
      join(launcher, 'LaunchServer.json'),
      JSON.stringify({ updatesProvider: { updatesDir: 'updates', binaryName: 'Launcher' } }),
    )
    await writeFile(join(launcher, 'updates', 'Launcher.jar'), 'launcher')
    const order: string[] = []
    const control = {
      executeBuildCommand: async () => {
        order.push('build')
        return ['Build successful']
      },
    } as unknown as ControlFileService
    const runtime = {
      ensureInstalled: async () => {
        order.push('runtime')
        return {
          repository: 'https://github.com/GravitLauncher/LauncherRuntime',
          tag: 'v5.0.7',
          revision: '755e5509b1f573817a977b4180a2f84517619025',
          compatibleLauncherVersion: '5.7.9',
          moduleSha256: 'a'.repeat(64),
          resourcesSha256: 'b'.repeat(64),
          alreadyInstalled: false,
          alreadyLoaded: false,
        }
      },
    }
    const service = new ClientBuildService(
      control,
      {
        sha256: async () => null,
      } as unknown as VolumeFileOperations,
      undefined,
      undefined,
      runtime,
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: root,
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    try {
      const result = await service.buildLauncher(installation, context())

      expect(order).toEqual(['runtime', 'build'])
      expect(result.runtime.tag).toBe('v5.0.7')
      expect(result.artifacts).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('restarts an existing Prestarter installation before producing a missing exe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-prestarter-build-'))
    const launcher = join(root, 'launcher')
    await mkdir(join(launcher, 'updates'), { recursive: true })
    await writeFile(
      join(launcher, 'LaunchServer.json'),
      JSON.stringify({ updatesProvider: { updatesDir: 'updates', binaryName: 'Launcher' } }),
    )
    const order: string[] = []
    const control = {
      executeModuleCommand: async (
        _installation: GravitInstallation,
        command: string,
      ) => {
        order.push(command)
        if (command === 'modules available') {
          return ['Found LaunchServer module \tPrestarter']
        }
        return ['[MODULE] Prestarter v: 1.0.0 p: 0 deps: [LaunchServerCore]']
      },
      executeBuildCommand: async () => {
        order.push('build')
        await writeFile(join(launcher, 'updates', 'Launcher.jar'), 'launcher')
        await writeFile(join(launcher, 'updates', 'Launcher.exe'), 'prestarter-launcher')
        return ['Build successful']
      },
    } as unknown as ControlFileService
    const volume = {
      sha256: async (_installation: GravitInstallation, path: string) =>
        path === 'Prestarter.exe'
          ? 'e206a35615b91ae21a13154b7cb4dda9c742a2a45211880e79100bb09636de7f'
          : null,
    } as VolumeFileOperations
    const runtime = {
      ensureInstalled: async () => ({
        repository: 'https://github.com/GravitLauncher/LauncherRuntime',
        tag: 'v5.0.7',
        revision: '755e5509b1f573817a977b4180a2f84517619025',
        compatibleLauncherVersion: '5.7.9',
        moduleSha256: 'a'.repeat(64),
        resourcesSha256: 'b'.repeat(64),
        alreadyInstalled: true,
        alreadyLoaded: true,
      }),
    }
    const service = new ClientBuildService(
      control,
      volume,
      new RuntimeModuleManagementService(control),
      undefined,
      runtime,
      undefined,
      {
        restartLaunchServer: async () => {
          order.push('restart')
        },
      },
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: root,
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    try {
      const result = await service.buildLauncher(installation, context())

      expect(order).toEqual(['restart', 'modules available', 'modules list', 'build'])
      expect(result.artifacts.map((artifact) => artifact.variant)).toEqual([
        'jar',
        'windows-x64',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('snapshots LauncherRuntime PNG customization and rebuilds artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-launcher-customization-'))
    const launcher = join(root, 'launcher')
    await mkdir(join(launcher, 'updates'), { recursive: true })
    await writeFile(
      join(launcher, 'LaunchServer.json'),
      JSON.stringify({ updatesProvider: { updatesDir: 'updates', binaryName: 'Launcher' } }),
    )
    const files = new Map<string, Uint8Array>([
      ['runtime/images/logo.png', new Uint8Array([1, 2, 3])],
    ])
    const volume: VolumeFileOperations = {
      exists: async (_installation, path, kind = 'file') =>
        kind === 'file' && files.has(path),
      readFile: async (_installation, path) =>
        new TextDecoder().decode(files.get(path)),
      ensureDirectory: async () => {},
      writeFileAtomic: async (_installation, path, bytes) => {
        files.set(path, bytes)
      },
      copy: async (_installation, source, target) => {
        const bytes = files.get(source)
        if (bytes) files.set(target, bytes.slice())
      },
      move: async (_installation, source, target) => {
        const bytes = files.get(source)
        files.delete(source)
        if (bytes) files.set(target, bytes)
      },
      remove: async (_installation, path) => {
        files.delete(path)
      },
      sha256: async () => null,
    }
    const control = {
      executeBuildCommand: async () => {
        await writeFile(join(launcher, 'updates', 'Launcher.jar'), 'custom-launcher')
        return ['Build successful']
      },
    } as unknown as ControlFileService
    const runtime = {
      ensureInstalled: async () => ({
        repository: 'https://github.com/GravitLauncher/LauncherRuntime',
        tag: 'v5.0.7',
        revision: '755e5509b1f573817a977b4180a2f84517619025',
        compatibleLauncherVersion: '5.7.9',
        moduleSha256: 'a'.repeat(64),
        resourcesSha256: 'b'.repeat(64),
        alreadyInstalled: true,
        alreadyLoaded: true,
      }),
    }
    const service = new ClientBuildService(
      control,
      volume,
      undefined,
      undefined,
      runtime,
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: root,
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6,
    ])

    try {
      const result = await service.customizeLauncher(
        installation,
        { logo: png },
        context(),
      )

      expect(result.customized).toBe(true)
      expect(result.assets[0]).toMatchObject({
        id: 'logo',
        path: 'runtime/images/logo.png',
      })
      expect(result.backups[0]).toStartWith('runtime/images/logo.png.backup-')
      expect(result.build.artifacts[0]?.variant).toBe('jar')
      expect(files.get('runtime/images/logo.png')).toEqual(png)
      expect(
        new TextDecoder().decode(files.get('.gravit-panel-launcher-customization.json')),
      ).toContain('"logo"')
      expect((await service.customizationState(installation)).customized).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects non-PNG launcher customization assets before writing files', async () => {
    const service = new ClientBuildService({} as ControlFileService)
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: '/srv/gravit/default',
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    expect(
      service.customizeLauncher(
        installation,
        { background: new TextEncoder().encode('not a png') },
        context(),
      ),
    ).rejects.toThrow('background must be a valid PNG file')
  })

  test('reports checksummed launcher artifacts from the configured updates provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-launcher-artifacts-'))
    const launcher = join(root, 'launcher')
    await mkdir(join(launcher, 'public'), { recursive: true })
    await writeFile(
      join(launcher, 'LaunchServer.json'),
      JSON.stringify({ updatesProvider: { updatesDir: 'public', binaryName: 'Custom' } }),
    )
    await writeFile(join(launcher, 'public', 'Custom.jar'), 'launcher')
    const service = new ClientBuildService({} as ControlFileService)
    const now = new Date().toISOString()
    const installation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: root,
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    try {
      const artifacts = await service.listLauncherArtifacts(installation)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]).toMatchObject({
        variant: 'jar',
        filename: 'Custom.jar',
        size: 8,
      })
      expect(artifacts[0]?.sha256).toHaveLength(64)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reports completed preparation only for pinned artifacts and build output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-client-state-'))
    const launcher = join(root, 'launcher')
    await mkdir(join(launcher, 'updates'), { recursive: true })
    await writeFile(
      join(launcher, 'LaunchServer.json'),
      JSON.stringify({ updatesProvider: { updatesDir: 'updates', binaryName: 'Launcher' } }),
    )
    await writeFile(join(launcher, 'updates', 'Launcher.jar'), 'launcher')
    const volume = {
      exists: async (
        _installation: GravitInstallation,
        path: string,
        kind: 'file' | 'directory' = 'file',
      ) => {
        if (path === 'config/MirrorHelper/workspace') return kind === 'directory'
        if (path === 'profiles/main.json') return kind === 'file'
        if (path === 'updates/main') return kind === 'directory'
        return false
      },
      sha256: async (_installation: GravitInstallation, path: string) => {
        if (path === 'config/MirrorHelper/workspace.panel.json') {
          return '51772ff2d1f3326862ca2cfa8f6e91d3d86a0406cd65a4eb0abaa114b43b7728'
        }
        if (path === 'Prestarter.exe') {
          return 'e206a35615b91ae21a13154b7cb4dda9c742a2a45211880e79100bb09636de7f'
        }
        return null
      },
    } as VolumeFileOperations
    const service = new ClientBuildService({} as ControlFileService, volume)
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: root,
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }

    try {
      expect(await service.preparationState(installation)).toEqual({
        installationId: installation.id,
        workspaceApplied: true,
        prestarterInstalled: true,
        launcherBuilt: true,
      })
      expect(await service.profileState(installation, 'main')).toEqual({
        installationId: installation.id,
        name: 'main',
        built: true,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
