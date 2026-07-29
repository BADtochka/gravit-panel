import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import {
  ControlFileBusyError,
  ControlFileService,
  type ControlCommandRunner,
} from './control-file.service'

const installation: GravitInstallation = {
  id: crypto.randomUUID(),
  name: 'test',
  path: '/srv/gravit/default',
  address: 'localhost:17549',
  projectName: 'TEST',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const isProbe = (command: string[]) => command.includes('test')

describe('ControlFileService', () => {
  test('executes the allowlisted command through socat inside the Compose container', async () => {
    const calls: Array<{ command: string[]; cwd: string; input: string }> = []
    const runner: ControlCommandRunner = async (command, cwd, input) => {
      calls.push({ command, cwd, input })
      if (isProbe(command)) return { exitCode: 0, stdout: '', stderr: '' }
      return {
        exitCode: 0,
        stdout:
          'Show server status\nMemory: free 10 | total: 20 | max: 30\nUptime: 0 days 0 hours 1 minutes 2 seconds\n',
        stderr: '',
      }
    }

    const result = await new ControlFileService(1_000, 1_000, runner).execute(
      installation,
      'serverStatus',
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]?.command).toEqual([
      'docker',
      'compose',
      'exec',
      '-T',
      'gravitlauncher',
      'test',
      '-S',
      '/app/data/control-file',
    ])
    expect(calls[1]).toMatchObject({
      cwd: installation.path,
      input: 'serverStatus\n',
    })
    expect(calls[1]?.command).toEqual([
      'docker',
      'compose',
      'exec',
      '-T',
      '-w',
      '/app',
      'gravitlauncher',
      'socat',
      'UNIX-CONNECT:/app/data/control-file',
      'STDIO,ignoreeof',
    ])
    expect(result).toMatchObject({
      installationId: installation.id,
      command: 'serverStatus',
      lines: [
        'Show server status',
        'Memory: free 10 | total: 20 | max: 30',
        'Uptime: 0 days 0 hours 1 minutes 2 seconds',
      ],
    })
    expect(result.source.revision).toHaveLength(40)
  })

  test('fails with an actionable error when the container control socket is absent', async () => {
    const runner: ControlCommandRunner = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
    })

    await expect(
      new ControlFileService(10, 100, runner).execute(installation, 'securitycheck'),
    ).rejects.toThrow('control socket did not become ready')
  })

  test('retries when socat loses the socket between readiness check and connect', async () => {
    let controlAttempts = 0
    const runner: ControlCommandRunner = async (command) => {
      if (isProbe(command)) return { exitCode: 0, stdout: '', stderr: '' }
      controlAttempts += 1
      if (controlAttempts === 1) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'socat: E connect: No such file or directory',
        }
      }
      return { exitCode: 0, stdout: 'Security check passed\n', stderr: '' }
    }

    const result = await new ControlFileService(1_000, 1_000, runner).execute(
      installation,
      'securitycheck',
    )

    expect(controlAttempts).toBe(2)
    expect(result.lines).toEqual(['Security check passed'])
  })

  test('rejects LaunchServer command failures even when socat exits successfully', async () => {
    const runner: ControlCommandRunner = async (command) =>
      isProbe(command)
        ? { exitCode: 0, stdout: '', stderr: '' }
        : {
            exitCode: 0,
            stdout: 'Error when execute command\n',
            stderr: '',
          }

    await expect(
      new ControlFileService(1_000, 1_000, runner).executeClientCommand(
        installation,
        'applyworkspace /app/data/config/MirrorHelper/workspace.panel.json',
      ),
    ).rejects.toThrow('LaunchServer rejected command')
  })

  test('parses a server token without exposing unrelated LaunchServer output', async () => {
    const profileUuid = '6830f39d-23bd-4653-aecd-81f08af4ec2e'
    const runner: ControlCommandRunner = async (command) =>
      isProbe(command)
        ? { exitCode: 0, stdout: '', stderr: '' }
        : {
            exitCode: 0,
            stdout:
              `[INFO] Server token ${profileUuid} authId std: header.payload.signature\n`,
            stderr: '',
          }
    const token = await new ControlFileService(1_000, 1_000, runner)
      .createServerToken(installation, profileUuid, 'std')
    expect(token).toBe('header.payload.signature')
  })

  test('maps a stalled module inspection to a busy state quickly', async () => {
    const timeouts: number[] = []
    const runner: ControlCommandRunner = async (command, _cwd, _input, timeout) => {
      timeouts.push(timeout)
      if (isProbe(command)) return { exitCode: 0, stdout: '', stderr: '' }
      throw new Error(`LaunchServer control socket stayed busy or the command stalled for ${timeout}ms`)
    }
    const service = new ControlFileService(30_000, 60_000, runner)

    await expect(
      service.executeModuleCommand(installation, 'modules list'),
    ).rejects.toBeInstanceOf(ControlFileBusyError)
    expect(timeouts.at(-1)).toBe(5_000)
  })
})
