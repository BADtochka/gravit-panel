import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { ContainerVolumeService, type ContainerCommandRunner } from '../docker/container-volume.service'
import { LaunchServerFilesService } from './launchserver-files.service'

const installation: GravitInstallation = {
  id: crypto.randomUUID(),
  name: 'default',
  path: '/srv/gravit/default',
  address: 'localhost:17549',
  projectName: 'TEST',
  sourceRepository: 'https://example.invalid/launcher.git',
  sourceRevision: 'main',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe('LaunchServerFilesService', () => {
  test('hides protected and special root entries', async () => {
    const runner: ContainerCommandRunner = async (_path, command) => {
      if (command[0] === 'find') return {
        exitCode: 0,
        stdout: 'config\td\t0\t1720000000.0\n.keys\td\t0\t1720000000.0\nbuild-secrets.json\tf\t42\t1720000000.0\nLaunchServer.json\tf\t42\t1720000000.0\nnull\tf\t630\t1720000000.0\ntruststore\td\t0\t1720000000.0\ncontrol-file\ts\t0\t1720000000.0\nlauncher.jar\tf\t42\t1720000000.0\n',
        stderr: '',
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const service = new LaunchServerFilesService(new ContainerVolumeService(runner))

    const result = await service.list(installation)

    expect(result.entries.map((entry) => entry.path)).toEqual(['config', 'launcher.jar'])
  })

  test('rejects traversal and credential storage before executing commands', async () => {
    let commands = 0
    const service = new LaunchServerFilesService(new ContainerVolumeService(async () => {
      commands += 1
      return { exitCode: 0, stdout: '', stderr: '' }
    }))

    await expect(service.read(installation, '../secrets')).rejects.toThrow('escapes')
    await expect(service.read(installation, '.keys/private.key')).rejects.toThrow('protected')
    await expect(service.read(installation, 'config/FileAuthSystem/Database.json')).rejects.toThrow('protected')
    await expect(service.read(installation, 'config/RemoteControl/Config.json')).rejects.toThrow('protected')
    await expect(service.read(installation, 'config/DiscordAuthSystem/Config.json')).rejects.toThrow('protected')
    await expect(service.write(installation, 'control-file', new Uint8Array(), true)).rejects.toThrow('protected')
    expect(commands).toBe(0)
  })

  test('rejects overwrite when the destination exists', async () => {
    const runner: ContainerCommandRunner = async (_path, command) => {
      if (command[0] === 'test' && command[1] === '-f') return { exitCode: 0, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const service = new LaunchServerFilesService(new ContainerVolumeService(runner))

    await expect(service.write(
      installation,
      'config/example.json',
      new TextEncoder().encode('{}'),
      false,
    )).rejects.toThrow('already exists')
  })
})
