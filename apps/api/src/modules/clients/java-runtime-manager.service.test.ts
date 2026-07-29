import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import type { JobTaskContext } from '../jobs/jobs.runner'
import {
  JavaRuntimeManagerService,
  type JavaRuntimeInstallInput,
} from './java-runtime-manager.service'

const installation: GravitInstallation = {
  id: '0da297da-3055-4785-aa1a-57fba3beba11',
  name: 'default',
  path: '/srv/gravit/default',
  address: 'localhost:17549',
  projectName: 'TEST',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
}
const context: JobTaskContext = {
  signal: new AbortController().signal,
  log: () => {},
  progress: () => {},
}

const createHarness = () => {
  const files = new Map<string, Uint8Array>()
  const directories = new Set<string>()
  files.set(
    'LaunchServer.json',
    new TextEncoder().encode(JSON.stringify({
      launcher: {
        customJavaDownload: {},
        forceUseCustomJava: false,
      },
    })),
  )
  const volume = {
    exists: async (
      _installation: GravitInstallation,
      path: string,
      kind: 'file' | 'directory' = 'file',
    ) => kind === 'directory' ? directories.has(path) : files.has(path),
    readFile: async (_installation: GravitInstallation, path: string) =>
      new TextDecoder().decode(files.get(path)!),
    writeFileAtomic: async (
      _installation: GravitInstallation,
      path: string,
      bytes: Uint8Array,
    ) => {
      files.set(path, bytes)
    },
    copy: async (_installation: GravitInstallation, source: string, target: string) => {
      files.set(target, files.get(source)!)
    },
    move: async (_installation: GravitInstallation, source: string, target: string) => {
      if (directories.delete(source)) directories.add(target)
    },
    remove: async (
      _installation: GravitInstallation,
      path: string,
      recursive = false,
    ) => {
      files.delete(path)
      if (recursive) directories.delete(path)
    },
    extractZipToNewDirectory: async (
      _installation: GravitInstallation,
      _archive: string,
      target: string,
    ) => {
      directories.add(target)
      files.set(`${target}/bin/java.exe`, new Uint8Array([1]))
    },
    extractTarGzToNewDirectory: async (
      _installation: GravitInstallation,
      _archive: string,
      target: string,
    ) => {
      directories.add(target)
      files.set(`${target}/bin/java`, new Uint8Array([1]))
    },
    prepareJavaRuntimePermissions: async () => {},
  }
  let restarts = 0
  let builds = 0
  const service = new JavaRuntimeManagerService(
    {
      restartLaunchServer: async () => {
        restarts += 1
      },
    },
    {
      buildLauncher: async () => {
        builds += 1
        return {} as never
      },
    },
    volume,
  )
  return {
    service,
    files,
    directories,
    restarts: () => restarts,
    builds: () => builds,
  }
}

describe('JavaRuntimeManagerService', () => {
  test('publishes an uploaded Java runtime and rebuilds the launcher', async () => {
    const harness = createHarness()
    const input: JavaRuntimeInstallInput = {
      directory: 'java21-windows-x86-64',
      version: 21,
      build: 9,
      os: 'mustdie',
      arch: 'X86_64',
      javafx: false,
    }

    const result = await harness.service.install(
      installation,
      input,
      new Uint8Array([1, 2, 3]),
      context,
    )
    const config = JSON.parse(
      new TextDecoder().decode(harness.files.get('LaunchServer.json')),
    )

    expect(config.launcher.customJavaDownload[input.directory]).toBe(
      'Java 21 b9 mustdie X86_64 javafx false',
    )
    expect(result.state.items[0]).toMatchObject({
      directory: input.directory,
      version: 21,
      installed: true,
    })
    expect(harness.restarts()).toBe(1)
    expect(harness.builds()).toBe(1)
  })

  test('moves a removed runtime to trash and removes its catalog entry', async () => {
    const harness = createHarness()
    harness.directories.add('updates/java17-linux-x86-64')
    harness.files.set(
      'LaunchServer.json',
      new TextEncoder().encode(JSON.stringify({
        launcher: {
          customJavaDownload: {
            'java17-linux-x86-64': 'Java 17 b12 linux X86_64 javafx false',
          },
          forceUseCustomJava: false,
        },
      })),
    )

    const result = await harness.service.remove(
      installation,
      'java17-linux-x86-64',
      context,
    )
    const config = JSON.parse(
      new TextDecoder().decode(harness.files.get('LaunchServer.json')),
    )

    expect(config.launcher.customJavaDownload).toEqual({})
    expect(result.trashPath).toStartWith('.gravit-panel-java-trash/')
    expect(harness.directories.has(result.trashPath!)).toBe(true)
  })

  test('persists forceUseCustomJava and rebuilds launcher configuration', async () => {
    const harness = createHarness()

    const result = await harness.service.updateSettings(
      installation,
      true,
      context,
    )
    const config = JSON.parse(
      new TextDecoder().decode(harness.files.get('LaunchServer.json')),
    )

    expect(config.launcher.forceUseCustomJava).toBe(true)
    expect(result.state.forceUseCustomJava).toBe(true)
    expect(harness.restarts()).toBe(1)
    expect(harness.builds()).toBe(1)
  })

  test('downloads and installs a verified Temurin runtime', async () => {
    const harness = createHarness()
    const service = new JavaRuntimeManagerService(
      {
        restartLaunchServer: async () => {},
      },
      {
        buildLauncher: async () => ({} as never),
      },
      {
        exists: async (
          _installation: GravitInstallation,
          path: string,
          kind: 'file' | 'directory' = 'file',
        ) => kind === 'directory'
          ? harness.directories.has(path)
          : harness.files.has(path),
        readFile: async (_installation, path) =>
          new TextDecoder().decode(harness.files.get(path)!),
        writeFileAtomic: async (_installation, path, bytes) => {
          harness.files.set(path, bytes)
        },
        copy: async (_installation, source, target) => {
          harness.files.set(target, harness.files.get(source)!)
        },
        move: async () => {},
        remove: async (_installation, path, recursive = false) => {
          harness.files.delete(path)
          if (recursive) harness.directories.delete(path)
        },
        extractZipToNewDirectory: async () => {},
        extractTarGzToNewDirectory: async (_installation, _archive, target) => {
          harness.directories.add(target)
          harness.files.set(`${target}/bin/java`, new Uint8Array([1]))
        },
        prepareJavaRuntimePermissions: async () => {},
      },
      {
        downloadLatest: async () => ({
          bytes: new Uint8Array([1, 2, 3]),
          archiveFormat: 'tar.gz' as const,
          build: 8,
          releaseName: 'jdk-21.0.12+8',
          filename: 'OpenJDK21U-jre_x64_linux_hotspot_21.0.12_8.tar.gz',
          sha256: 'a'.repeat(64),
          sourceUrl: 'https://github.com/adoptium/temurin21-binaries/releases/file.tar.gz',
        }),
      },
    )

    const result = await service.installTemurin(
      installation,
      {
        directory: 'java21-linux-x86-64',
        version: 21,
        os: 'linux',
        arch: 'X86_64',
        imageType: 'jre',
      },
      context,
    )

    expect(result.source.releaseName).toBe('jdk-21.0.12+8')
    expect(result.state.items[0]).toMatchObject({
      directory: 'java21-linux-x86-64',
      build: 8,
      installed: true,
    })
  })
})
