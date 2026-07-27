import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import {
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
import type { JobTaskContext } from '../jobs/jobs.runner'
import type { ControlFileService, RemoteControlSetupCommand } from './control-file.service'
import type { RemoteControlHttpService } from './remote-control-http.service'
import {
  RemoteControlSetupService,
} from './remote-control-setup.service'
import type { RemoteControlStore } from './remote-control.store'

const createContext = (): JobTaskContext => ({
  signal: new AbortController().signal,
  log: () => {},
  progress: () => {},
})
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

describe('RemoteControlSetupService', () => {
  test('writes an allowlisted config, loads the module, verifies HTTP, and stores the token', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-remote-control-'))
    await mkdir(join(temporaryRoot, 'launcher'), { recursive: true })
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'test',
      path: temporaryRoot,
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const controlCommands: RemoteControlSetupCommand[] = []
    const controlFile = {
      executeSetupCommand: async (_installation: GravitInstallation, command: RemoteControlSetupCommand) => {
        controlCommands.push(command)
        if (command === 'modules available') {
          return ['Found LaunchServer module \tRemoteControl']
        }
        return command === 'modules list' ? ['[MODULE] LaunchServerCore'] : ['loaded']
      },
    } as unknown as ControlFileService
    let httpToken = ''
    const http = {
      validateEndpoint: () => 'http://localhost:17549',
      execute: async (
        _installation: GravitInstallation,
        credential: { token: string },
      ) => {
        httpToken = credential.token
        return {}
      },
    } as unknown as RemoteControlHttpService
    let storedToken = ''
    const store = {
      save: (_id: string, _endpoint: string, token: string) => {
        storedToken = token
      },
      delete: () => {},
    } as unknown as RemoteControlStore
    const service = new RemoteControlSetupService(controlFile, http, store, localVolume)

    try {
      const result = await service.setup(
        {
          ...installation,
        },
        {
          installationId: installation.id,
          endpoint: 'http://localhost:17549',
          replaceExistingTokens: true,
        },
        createContext(),
      )
      const config = JSON.parse(
        await readFile(
          join(temporaryRoot, 'launcher', 'config', 'RemoteControl', 'Config.json'),
          'utf8',
        ),
      )

      expect(config).toMatchObject({
        enabled: true,
        list: [
          {
            allowAll: false,
            startWithMode: false,
            commands: ['serverStatus', 'securitycheck'],
          },
        ],
      })
      expect(config.list[0].token).toBeString()
      expect(config.list[0].token).toBe(httpToken)
      expect(storedToken).toBe(httpToken)
      expect(JSON.stringify(result)).not.toContain(httpToken)
      expect(controlCommands).toEqual([
        'modules available',
        'modules list',
        'modules load RemoteControl',
      ])
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  test('clears and disables the token config when HTTP verification fails', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-remote-rollback-'))
    await mkdir(join(temporaryRoot, 'launcher'), { recursive: true })
    const installation = {
      id: crypto.randomUUID(),
      name: 'test',
      path: temporaryRoot,
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const controlFile = {
      executeSetupCommand: async (
        _installation: GravitInstallation,
        command: RemoteControlSetupCommand,
      ) => command === 'modules available'
        ? ['Found LaunchServer module \tRemoteControl']
        : [],
    } as unknown as ControlFileService
    const http = {
      validateEndpoint: () => 'http://localhost:17549',
      execute: async () => {
        throw new Error('HTTP unavailable')
      },
    } as unknown as RemoteControlHttpService
    let saved = false
    let deleted = false
    const store = {
      save: () => {
        saved = true
      },
      delete: () => {
        deleted = true
      },
    } as unknown as RemoteControlStore
    const service = new RemoteControlSetupService(controlFile, http, store, localVolume)

    try {
      await expect(
        service.setup(
          installation,
          {
            installationId: installation.id,
            endpoint: 'http://localhost:17549',
            replaceExistingTokens: true,
          },
          createContext(),
        ),
      ).rejects.toThrow('HTTP unavailable')
      const config = JSON.parse(
        await readFile(
          join(temporaryRoot, 'launcher', 'config', 'RemoteControl', 'Config.json'),
          'utf8',
        ),
      )
      expect(config).toEqual({ list: [], enabled: false })
      expect(saved).toBe(false)
      expect(deleted).toBe(true)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})
