import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import type { ModuleControlCommand } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import {
  LauncherRuntimeService,
  type RuntimeVolumeOperations,
} from './launcher-runtime.service'
import { sha256Bytes } from './verified-artifact'

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

const patchedModuleBytes = new Uint8Array([7, 8, 9])
const patchedModuleSha256 = sha256Bytes(patchedModuleBytes)
const patchedModule = async () => ({
  bytes: patchedModuleBytes,
  sha256: patchedModuleSha256,
})

const volumeHarness = () => {
  const paths = new Map<string, 'file' | 'directory'>()
  const files = new Map<string, string>()
  const digests = new Map<string, string>()
  const volume: RuntimeVolumeOperations = {
    exists: async (_installation, path, kind = 'file') => paths.get(path) === kind,
    sha256: async (_installation, path) => digests.get(path) ?? null,
    readFile: async (_installation, path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`Missing fixture file: ${path}`)
      return value
    },
    writeFileAtomic: async (_installation, path, bytes) => {
      paths.set(path, 'file')
      files.set(path, new TextDecoder().decode(bytes))
      digests.set(path, sha256Bytes(bytes))
    },
    extractZipToNewDirectory: async (_installation, _archive, target) => {
      paths.set(target, 'directory')
      paths.set(`${target}/runtime_en.properties`, 'file')
      paths.set(`${target}/scenes/login/login.fxml`, 'file')
      paths.set(`${target}/overlay/webauth/webauth.fxml`, 'file')
      files.set(
        `${target}/runtime_en.properties`,
        [
          'runtime.scenes.login.savePassword=SAVE PASSWORD',
          'runtime.overlay.webauth.webauth.description=Copy the code below',
          '',
        ].join('\n'),
      )
      files.set(`${target}/scenes/login/login.fxml`, '<AnchorPane />')
      files.set(
        `${target}/overlay/webauth/webauth.fxml`,
        '<HBox><Label id="link" styleClass="tooltip" /><Button id="submit" /></HBox>',
      )
    },
    move: async (_installation, source, target) => {
      const entries = [...paths.entries()].filter(
        ([path]) => path === source || path.startsWith(`${source}/`),
      )
      const fileEntries = [...files.entries()].filter(
        ([path]) => path === source || path.startsWith(`${source}/`),
      )
      const digestEntries = [...digests.entries()].filter(
        ([path]) => path === source || path.startsWith(`${source}/`),
      )
      entries.forEach(([path]) => paths.delete(path))
      fileEntries.forEach(([path]) => files.delete(path))
      digestEntries.forEach(([path]) => digests.delete(path))
      entries.forEach(([path, kind]) => {
        paths.set(`${target}${path.slice(source.length)}`, kind)
      })
      fileEntries.forEach(([path, contents]) => {
        files.set(`${target}${path.slice(source.length)}`, contents)
      })
      digestEntries.forEach(([path, digest]) => {
        digests.set(`${target}${path.slice(source.length)}`, digest)
      })
    },
    remove: async (_installation, path) => {
      paths.delete(path)
      files.delete(path)
      digests.delete(path)
    },
  }
  return { digests, files, paths, volume }
}

describe('LauncherRuntimeService', () => {
  test('installs pinned GUI assets and persists JavaRuntime.jar as a launcher module', async () => {
    const { files, paths, volume } = volumeHarness()
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
      patchedModule,
    )

    const result = await service.ensureInstalled(installation, context())

    expect(downloads).toHaveLength(1)
    expect(paths.get('JavaRuntime.jar')).toBe('file')
    expect(paths.get('runtime')).toBe('directory')
    expect(paths.has('.gravit-panel-runtime.zip')).toBe(false)
    expect(files.get('runtime/runtime_en.properties')).toContain(
      'If the browser did not open, copy the link manually.',
    )
    expect(files.get('runtime/runtime_en.properties')).toContain(
      'runtime.overlay.webauth.webauth.copyLink=COPY AUTHORIZATION LINK',
    )
    expect(files.get('runtime/runtime_en.properties')).toContain(
      'runtime.scenes.login.savePassword=REMEMBER LOGIN',
    )
    expect(files.get('runtime/overlay/webauth/webauth.fxml')).not.toContain(
      'styleClass="tooltip"',
    )
    expect(files.get('runtime/overlay/webauth/webauth.fxml')).toContain(
      'id="copyLink"',
    )
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
    const { digests, files, paths, volume } = volumeHarness()
    paths.set('JavaRuntime.jar', 'file')
    digests.set('JavaRuntime.jar', patchedModuleSha256)
    paths.set('runtime', 'directory')
    paths.set('runtime/runtime_en.properties', 'file')
    paths.set('runtime/scenes/login/login.fxml', 'file')
    paths.set('runtime/overlay/webauth/webauth.fxml', 'file')
    files.set(
      'runtime/runtime_en.properties',
      [
        'runtime.scenes.login.savePassword=SAVE PASSWORD',
        'runtime.overlay.webauth.webauth.description=Copy the code below',
        '',
      ].join('\n'),
    )
    files.set('runtime/scenes/login/login.fxml', '<AnchorPane />')
    files.set(
      'runtime/overlay/webauth/webauth.fxml',
      '<HBox><Label id="link" styleClass="tooltip" /><Button id="submit" /></HBox>',
    )
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
      patchedModule,
    )

    const result = await service.ensureInstalled(installation, context())

    expect(downloads).toBe(0)
    expect(result.alreadyInstalled).toBe(true)
    expect(result.alreadyLoaded).toBe(true)
    expect(files.get('runtime/runtime_en.properties')).toContain(
      'If the browser did not open, copy the link manually.',
    )
    expect(files.get('runtime/runtime_en.properties')).toContain(
      'runtime.overlay.webauth.webauth.copyLink=COPY AUTHORIZATION LINK',
    )
    expect(files.get('runtime/runtime_en.properties')).toContain(
      'runtime.scenes.login.savePassword=REMEMBER LOGIN',
    )
    expect(files.get('runtime/overlay/webauth/webauth.fxml')).not.toContain(
      'styleClass="tooltip"',
    )
    expect(files.get('runtime/overlay/webauth/webauth.fxml')).toContain(
      'id="copyLink"',
    )
  })

  test('replaces an incomplete runtime directory while retaining its snapshot', async () => {
    const { digests, paths, volume } = volumeHarness()
    paths.set('JavaRuntime.jar', 'file')
    digests.set('JavaRuntime.jar', patchedModuleSha256)
    paths.set('runtime', 'directory')
    const service = new LauncherRuntimeService(
      {
        executeModuleCommand: async () => [
          '[LAUNCHER MODULE] JavaRuntime.jar sig: NOT_SIGNED',
        ],
      },
      volume,
      async () => new Uint8Array([1, 2, 3]),
      patchedModule,
    )

    const result = await service.ensureInstalled(installation, context())

    expect(result.alreadyInstalled).toBe(false)
    expect(paths.get('runtime/runtime_en.properties')).toBe('file')
    expect(
      [...paths.keys()].some((path) => path.startsWith('runtime.backup-')),
    ).toBe(true)
  })

  test('replaces a loaded upstream runtime and restarts LaunchServer once', async () => {
    const { digests, files, paths, volume } = volumeHarness()
    paths.set('JavaRuntime.jar', 'file')
    files.set('JavaRuntime.jar', 'upstream')
    digests.set('JavaRuntime.jar', 'f'.repeat(64))
    paths.set('runtime', 'directory')
    paths.set('runtime/runtime_en.properties', 'file')
    paths.set('runtime/scenes/login/login.fxml', 'file')
    paths.set('runtime/overlay/webauth/webauth.fxml', 'file')
    files.set(
      'runtime/runtime_en.properties',
      [
        'runtime.scenes.login.savePassword=SAVE PASSWORD',
        'runtime.overlay.webauth.webauth.description=Copy the code below',
        '',
      ].join('\n'),
    )
    files.set('runtime/scenes/login/login.fxml', '<AnchorPane />')
    files.set(
      'runtime/overlay/webauth/webauth.fxml',
      '<HBox><Label id="link" styleClass="tooltip" /><Button id="submit" /></HBox>',
    )
    const commands: ModuleControlCommand[] = []
    let restarts = 0
    const service = new LauncherRuntimeService(
      {
        executeModuleCommand: async (_installation, command) => {
          commands.push(command)
          return ['[LAUNCHER MODULE] JavaRuntime.jar sig: NOT_SIGNED']
        },
      },
      volume,
      async () => {
        throw new Error('resources must not be downloaded')
      },
      patchedModule,
      {
        restartLaunchServer: async () => {
          restarts += 1
        },
      },
    )

    const result = await service.ensureInstalled(installation, context())

    expect(restarts).toBe(1)
    expect(commands).toEqual(['modules list', 'modules list'])
    expect(digests.get('JavaRuntime.jar')).toBe(patchedModuleSha256)
    expect(
      [...paths.keys()].some((path) =>
        path.startsWith('JavaRuntime.jar.backup-'),
      ),
    ).toBe(true)
    expect(result.alreadyInstalled).toBe(false)
    expect(result.alreadyLoaded).toBe(true)
    expect(result.moduleSha256).toBe(patchedModuleSha256)
  })
})
