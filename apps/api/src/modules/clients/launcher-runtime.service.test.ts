import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import type { ModuleControlCommand } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import {
  LauncherRuntimeService,
  type RuntimeVolumeOperations,
} from './launcher-runtime.service'

const installation: GravitInstallation = {
  id: crypto.randomUUID(),
  name: 'default',
  path: '/srv/gravit/default',
  address: 'localhost:17549',
  projectName: 'TEST',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const context = (): JobTaskContext => ({
  signal: new AbortController().signal,
  log: () => {},
  progress: () => {},
})

const volumeHarness = () => {
  const paths = new Map<string, 'file' | 'directory'>()
  const volume: RuntimeVolumeOperations = {
    exists: async (_installation, path, kind = 'file') => paths.get(path) === kind,
    writeFileAtomic: async (_installation, path) => {
      paths.set(path, 'file')
    },
    extractZipToNewDirectory: async (_installation, _archive, target) => {
      paths.set(target, 'directory')
      paths.set(`${target}/runtime_en.properties`, 'file')
      paths.set(`${target}/scenes/login/login.fxml`, 'file')
    },
    move: async (_installation, source, target) => {
      const entries = [...paths.entries()].filter(
        ([path]) => path === source || path.startsWith(`${source}/`),
      )
      entries.forEach(([path]) => paths.delete(path))
      entries.forEach(([path, kind]) => {
        paths.set(`${target}${path.slice(source.length)}`, kind)
      })
    },
    remove: async (_installation, path) => {
      paths.delete(path)
    },
  }
  return { paths, volume }
}

describe('LauncherRuntimeService', () => {
  test('installs pinned GUI assets and persists JavaRuntime.jar as a launcher module', async () => {
    const { paths, volume } = volumeHarness()
    const commands: ModuleControlCommand[] = []
    let loaded = false
    const control = {
      executeModuleCommand: async (
        _installation: GravitInstallation,
        command: ModuleControlCommand,
      ) => {
        commands.push(command)
        if (command === 'modules launcher-load JavaRuntime.jar') loaded = true
        return loaded ? ['[LAUNCHER MODULE] JavaRuntime.jar sig: NOT_SIGNED'] : []
      },
    }
    const downloads: string[] = []
    const service = new LauncherRuntimeService(
      control,
      volume,
      async (url) => {
        downloads.push(url)
        return new Uint8Array([1, 2, 3])
      },
    )

    const result = await service.ensureInstalled(installation, context())

    expect(downloads).toHaveLength(2)
    expect(paths.get('JavaRuntime.jar')).toBe('file')
    expect(paths.get('runtime')).toBe('directory')
    expect(paths.has('.gravit-panel-runtime.zip')).toBe(false)
    expect(commands).toEqual([
      'modules list',
      'modules launcher-load JavaRuntime.jar',
      'modules list',
    ])
    expect(result).toMatchObject({
      tag: 'v5.0.7',
      compatibleLauncherVersion: '5.7.9',
      alreadyInstalled: false,
      alreadyLoaded: false,
    })
  })

  test('keeps an installed and loaded runtime without downloading or loading twice', async () => {
    const { paths, volume } = volumeHarness()
    paths.set('JavaRuntime.jar', 'file')
    paths.set('runtime', 'directory')
    paths.set('runtime/runtime_en.properties', 'file')
    paths.set('runtime/scenes/login/login.fxml', 'file')
    let downloads = 0
    const service = new LauncherRuntimeService(
      {
        executeModuleCommand: async () => [
          '[LAUNCHER MODULE] JavaRuntime.jar sig: NOT_SIGNED',
        ],
      },
      volume,
      async () => {
        downloads += 1
        return new Uint8Array()
      },
    )

    const result = await service.ensureInstalled(installation, context())

    expect(downloads).toBe(0)
    expect(result.alreadyInstalled).toBe(true)
    expect(result.alreadyLoaded).toBe(true)
  })

  test('replaces an incomplete runtime directory while retaining its snapshot', async () => {
    const { paths, volume } = volumeHarness()
    paths.set('JavaRuntime.jar', 'file')
    paths.set('runtime', 'directory')
    const service = new LauncherRuntimeService(
      {
        executeModuleCommand: async () => [
          '[LAUNCHER MODULE] JavaRuntime.jar sig: NOT_SIGNED',
        ],
      },
      volume,
      async () => new Uint8Array([1, 2, 3]),
    )

    const result = await service.ensureInstalled(installation, context())

    expect(result.alreadyInstalled).toBe(false)
    expect(paths.get('runtime/runtime_en.properties')).toBe('file')
    expect(
      [...paths.keys()].some((path) => path.startsWith('runtime.backup-')),
    ).toBe(true)
  })
})
