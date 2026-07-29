import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import {
  ContainerVolumeService,
  type ContainerCommandRunner,
} from './container-volume.service'

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

describe('ContainerVolumeService', () => {
  test('atomically writes through the fixed gravitlauncher container', async () => {
    const calls: Array<{ command: string[]; input?: Uint8Array }> = []
    const runner: ContainerCommandRunner = async (_path, command, input) => {
      calls.push({ command, input })
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const service = new ContainerVolumeService(runner)
    const bytes = new TextEncoder().encode('workspace')

    await service.writeFileAtomic(
      installation,
      'config/MirrorHelper/workspace.panel.json',
      bytes,
      '0600',
    )

    expect(calls[0]?.command).toEqual([
      'mkdir',
      '-p',
      '--',
      '/app/data/config/MirrorHelper',
    ])
    expect(calls[1]?.command.slice(0, 3)).toEqual(['sh', '-c', 'umask "$1"; cat > "$2"'])
    expect(calls[1]?.input).toEqual(bytes)
    expect(calls[2]?.command).toContain('0600')
    expect(calls[3]?.command[0]).toBe('mv')
  })

  test('rejects paths outside /app/data before executing a command', async () => {
    let commands = 0
    const service = new ContainerVolumeService(async () => {
      commands += 1
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    await expect(service.ensureDirectory(installation, '../root')).rejects.toThrow(
      'escapes /app/data',
    )
    await expect(service.remove(installation, '/app/data')).rejects.toThrow(
      'relative path',
    )
    expect(commands).toBe(0)
  })

  test('prepares a bind-mounted directory for the local API user', async () => {
    const calls: string[][] = []
    const service = new ContainerVolumeService(async (_path, command) => {
      calls.push(command)
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    await service.prepareHostWritableDirectory(installation, 'updates/assets')

    expect(calls).toEqual([
      ['mkdir', '-p', '--', '/app/data/updates/assets'],
      [
        'chown',
        '-R',
        `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        '--',
        '/app/data/updates/assets',
      ],
    ])
  })

  test('treats a clean test exit code 1 as an absent file', async () => {
    const service = new ContainerVolumeService(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
    }))

    expect(await service.exists(installation, 'Prestarter.exe')).toBe(false)
  })

  test('reads a constrained volume file through the fixed container', async () => {
    const calls: string[][] = []
    const service = new ContainerVolumeService(async (_path, command) => {
      calls.push(command)
      return { exitCode: 0, stdout: '{"auth":{}}', stderr: '' }
    })

    expect(await service.readFile(installation, 'LaunchServer.json')).toBe('{"auth":{}}')
    expect(calls).toEqual([['cat', '--', '/app/data/LaunchServer.json']])
  })

  test('lists direct volume files without exposing absolute container paths', async () => {
    const calls: string[][] = []
    const service = new ContainerVolumeService(async (_path, command) => {
      calls.push(command)
      if (command[0] === 'test') return { exitCode: 0, stdout: '', stderr: '' }
      return {
        exitCode: 0,
        stdout: '/app/data/profiles/zeta.json\n/app/data/profiles/main.json\n',
        stderr: '',
      }
    })

    expect(await service.listFiles(installation, 'profiles')).toEqual([
      'main.json',
      'zeta.json',
    ])
    expect(calls).toEqual([
      ['test', '-d', '/app/data/profiles'],
      ['find', '/app/data/profiles', '-maxdepth', '1', '-type', 'f'],
    ])
  })

  test('hashes a constrained volume file and validates the digest', async () => {
    const digest = 'a'.repeat(64)
    const service = new ContainerVolumeService(async () => ({
      exitCode: 0,
      stdout: `${digest}  /app/data/Prestarter.exe\n`,
      stderr: '',
    }))

    expect(await service.sha256(installation, 'Prestarter.exe')).toBe(digest)
  })

  test('returns no digest when the requested volume file is absent', async () => {
    const service = new ContainerVolumeService(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'sha256sum: /app/data/Prestarter.exe: No such file or directory',
    }))

    expect(await service.sha256(installation, 'Prestarter.exe')).toBeNull()
  })

  test('validates archive entries before publishing a new runtime directory', async () => {
    const calls: string[][] = []
    const service = new ContainerVolumeService(async (_path, command) => {
      calls.push(command)
      if (command[0] === 'test') {
        return { exitCode: 1, stdout: '', stderr: '' }
      }
      if (command[0] === 'unzip' && command[1] === '-Z1') {
        return {
          exitCode: 0,
          stdout: 'components/\\ncomponents/background.fxml\\nruntime_ru.properties\\n',
          stderr: '',
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    await service.extractZipToNewDirectory(
      installation,
      '.gravit-panel-runtime.zip',
      'runtime',
    )

    expect(calls.some((command) => command[0] === 'unzip' && command[1] === '-q')).toBe(
      true,
    )
    expect(calls.some((command) => command[0] === 'mv')).toBe(true)
  })

  test('rejects zip-slip entries without extracting the runtime archive', async () => {
    const calls: string[][] = []
    const service = new ContainerVolumeService(async (_path, command) => {
      calls.push(command)
      if (command[0] === 'test') {
        return { exitCode: 1, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '../outside', stderr: '' }
    })

    await expect(
      service.extractZipToNewDirectory(
        installation,
        '.gravit-panel-runtime.zip',
        'runtime',
      ),
    ).rejects.toThrow('unsafe path')
    expect(calls.some((command) => command[0] === 'unzip' && command[1] === '-q')).toBe(
      false,
    )
  })

  test('strips one top-level directory for uploaded Java archives', async () => {
    const calls: string[][] = []
    const service = new ContainerVolumeService(async (_path, command) => {
      calls.push(command)
      if (command[0] === 'test') return { exitCode: 1, stdout: '', stderr: '' }
      if (command[0] === 'unzip' && command[1] === '-Z1') {
        return {
          exitCode: 0,
          stdout: 'jdk-21.0.4/bin/java\njdk-21.0.4/lib/modules\n',
          stderr: '',
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    await service.extractZipToNewDirectory(
      installation,
      '.gravit-panel-java/runtime.zip',
      'updates/java21-linux-x86-64',
      true,
    )

    const publish = calls.find((command) => command[0] === 'mv')
    expect(publish?.at(-2)).toEndWith('/jdk-21.0.4')
    expect(publish?.at(-1)).toBe('/app/data/updates/java21-linux-x86-64')
  })

  test('materializes Java symlinks and makes the selected runtime downloadable', async () => {
    const calls: string[][] = []
    const service = new ContainerVolumeService(async (_path, command) => {
      calls.push(command)
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    await service.prepareJavaRuntimePermissions(
      installation,
      'updates/java21-linux-x86-64',
    )

    expect(calls[0]?.slice(0, 5)).toEqual([
      'find',
      '/app/data/updates/java21-linux-x86-64',
      '-type',
      'l',
      '-exec',
    ])
    expect(calls[0]?.join('\n')).toContain('readlink -f -- "$link"')
    expect(calls[0]?.join('\n')).toContain('cp -L -- "$target" "$pending"')
    expect(calls[1]).toContain('a+rx')
    expect(calls[2]).toContain('a+r')
    expect(calls[3]).toContain('0755')
    expect(calls[3]).toContain('jexec')
  })

  test('extracts a Temurin tar.gz and strips its top-level directory', async () => {
    const calls: string[][] = []
    const service = new ContainerVolumeService(async (_path, command) => {
      calls.push(command)
      if (command[0] === 'test') return { exitCode: 1, stdout: '', stderr: '' }
      if (command[0] === 'tar' && command[1] === '-tzf') {
        return {
          exitCode: 0,
          stdout: 'jdk-21.0.4-jre/bin/java\njdk-21.0.4-jre/lib/modules\n',
          stderr: '',
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    await service.extractTarGzToNewDirectory(
      installation,
      '.gravit-panel-java/runtime.tar.gz',
      'updates/java21-linux-x86-64',
      true,
    )

    expect(calls.some((command) => command[0] === 'tar' && command[1] === '-xzf')).toBe(true)
    const publish = calls.find((command) => command[0] === 'mv')
    expect(publish?.at(-2)).toEndWith('/jdk-21.0.4-jre')
  })
})
