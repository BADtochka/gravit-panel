import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { DockerPreflightService } from './docker.service'

const installation: GravitInstallation = {
  id: 'installation-id',
  name: 'default',
  path: '/srv/gravit/default',
  address: 'localhost:17549',
  projectName: 'MY_PROJECT',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: '2026-07-27T12:00:00.000Z',
  updatedAt: '2026-07-27T12:00:00.000Z',
}

describe('DockerPreflightService', () => {
  test('reports a ready host when every check passes', async () => {
    const commands: string[][] = []
    const service = new DockerPreflightService(
      async (command) => {
        commands.push(command)
        return {
          exitCode: 0,
          output: command.includes('compose')
            ? 'Docker Compose version v5.1.0'
            : 'Docker version 29.3.0',
        }
      },
      async () => true,
      () => new Date('2026-07-27T12:00:00.000Z'),
    )

    const result = await service.run(17_549)

    expect(result.ready).toBe(true)
    expect(result.checkedAt).toBe('2026-07-27T12:00:00.000Z')
    expect(result.checks.every((check) => check.status === 'passed')).toBe(true)
    expect(commands).toEqual([
      ['docker', '--version'],
      ['docker', 'compose', 'version'],
    ])
  })

  test('skips Compose execution when the Docker CLI is missing', async () => {
    let commandRuns = 0
    const service = new DockerPreflightService(
      async () => {
        commandRuns += 1
        throw new Error('Executable not found in PATH')
      },
      async () => false,
    )

    const result = await service.run()

    expect(result.ready).toBe(false)
    expect(commandRuns).toBe(1)
    expect(result.checks).toMatchObject([
      { id: 'docker-cli', status: 'failed' },
      { id: 'docker-compose', status: 'failed' },
      { id: 'docker-port', status: 'failed' },
    ])
    expect(result.checks[2]?.remediation).toContain('17549')
  })

  test('accepts a busy port published by a registered LauncherDockered nginx container', async () => {
    const commands: string[][] = []
    const service = new DockerPreflightService(
      async (command) => {
        commands.push(command)
        if (command[1] === 'ps') {
          return {
            exitCode: 0,
            output: 'abc123\tdefault-nginx-1\t/srv/gravit/default\tnginx',
          }
        }
        return {
          exitCode: 0,
          output: command.includes('compose')
            ? 'Docker Compose version v5.1.0'
            : 'Docker version 29.3.0',
        }
      },
      async () => false,
    )

    const result = await service.run(17_549, [installation])

    expect(result.ready).toBe(true)
    expect(result.checks[2]).toMatchObject({
      id: 'docker-port',
      status: 'passed',
      remediation: null,
    })
    expect(result.checks[2]?.message).toContain("this panel's LauncherDockered installation")
    expect(commands.at(-1)).toEqual([
      'docker',
      'ps',
      '--filter',
      'publish=17549',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.service"}}',
    ])
  })

  test('rejects a busy port published by an unregistered or non-nginx container', async () => {
    const service = new DockerPreflightService(
      async (command) => ({
        exitCode: 0,
        output:
          command[1] === 'ps'
            ? 'abc123\tunrelated-web-1\t/srv/unrelated\tweb'
            : 'available',
      }),
      async () => false,
    )

    const result = await service.run(17_549, [installation])

    expect(result.ready).toBe(false)
    expect(result.checks[2]).toMatchObject({
      id: 'docker-port',
      status: 'failed',
    })
  })
})
