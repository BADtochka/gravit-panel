import type {
  DockerPreflightCheck,
  DockerPreflightResponse,
  GravitInstallation,
} from '@gravit-panel/shared'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

export const launcherDockeredSource = {
  repository: 'https://github.com/GravitLauncher/LauncherDockered',
  revision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  file: 'docker-compose.yml',
} as const

export const defaultLauncherPort = 17_549

interface CommandResult {
  exitCode: number
  output: string
}

type CommandRunner = (command: string[]) => Promise<CommandResult>
type PortChecker = (port: number) => Promise<boolean>

interface DockerPortOwner {
  containerId: string
  containerName: string
  workingDirectory: string
  service: string
}

const runCommand: CommandRunner = async (command) => {
  const process = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timeout = setTimeout(() => process.kill(), 5_000)

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    return {
      exitCode,
      output: (stdout || stderr).trim(),
    }
  } finally {
    clearTimeout(timeout)
  }
}

const checkPort: PortChecker = (port) =>
  new Promise((resolve) => {
    const server = createServer()

    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen({ host: '0.0.0.0', port, exclusive: true })
  })

const failedCommandCheck = (
  id: 'docker-cli' | 'docker-compose',
  title: string,
  message: string,
  remediation: string,
  details: string | null = null,
): DockerPreflightCheck => ({
  id,
  title,
  status: 'failed',
  message,
  details,
  remediation,
})

export class DockerPreflightService {
  constructor(
    private readonly commandRunner: CommandRunner = runCommand,
    private readonly portChecker: PortChecker = checkPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(
    port = defaultLauncherPort,
    installations: GravitInstallation[] = [],
  ): Promise<DockerPreflightResponse> {
    const dockerCli = await this.checkDockerCli()
    const compose =
      dockerCli.status === 'passed'
        ? await this.checkCompose()
        : failedCommandCheck(
            'docker-compose',
            'Docker Compose',
            'Docker Compose cannot be checked until the Docker CLI is available.',
            'Install Docker Engine with the Compose plugin, then run the check again.',
          )
    const portCheck = await this.checkTcpPort(
      port,
      dockerCli.status === 'passed' ? installations : [],
      dockerCli.status === 'passed',
    )
    const checks = [dockerCli, compose, portCheck]

    return {
      ready: checks.every((check) => check.status === 'passed'),
      checkedAt: this.now().toISOString(),
      port,
      checks,
      source: launcherDockeredSource,
    }
  }

  private async checkDockerCli(): Promise<DockerPreflightCheck> {
    try {
      const result = await this.commandRunner(['docker', '--version'])
      if (result.exitCode !== 0) {
        return failedCommandCheck(
          'docker-cli',
          'Docker CLI',
          'The Docker CLI returned an error.',
          'Install or repair Docker Engine and ensure docker is available in the API process PATH.',
          result.output || null,
        )
      }

      return {
        id: 'docker-cli',
        title: 'Docker CLI',
        status: 'passed',
        message: 'Docker CLI is available.',
        details: result.output || null,
        remediation: null,
      }
    } catch (error) {
      return failedCommandCheck(
        'docker-cli',
        'Docker CLI',
        'The Docker CLI is not available to the API process.',
        'Install Docker Engine and ensure docker is available in the API process PATH.',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private async checkCompose(): Promise<DockerPreflightCheck> {
    try {
      const result = await this.commandRunner(['docker', 'compose', 'version'])
      if (result.exitCode !== 0) {
        return failedCommandCheck(
          'docker-compose',
          'Docker Compose',
          'The Docker Compose plugin returned an error.',
          'Install or repair the Docker Compose plugin, then run the check again.',
          result.output || null,
        )
      }

      return {
        id: 'docker-compose',
        title: 'Docker Compose',
        status: 'passed',
        message: 'Docker Compose is available.',
        details: result.output || null,
        remediation: null,
      }
    } catch (error) {
      return failedCommandCheck(
        'docker-compose',
        'Docker Compose',
        'The Docker Compose plugin is not available.',
        'Install the Docker Compose plugin, then run the check again.',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private async checkTcpPort(
    port: number,
    installations: GravitInstallation[],
    canInspectDocker: boolean,
  ): Promise<DockerPreflightCheck> {
    const available = await this.portChecker(port)

    if (available) {
      return {
        id: 'docker-port',
        title: `TCP port ${port}`,
        status: 'passed',
        message: `TCP port ${port} is available on all IPv4 interfaces.`,
        details: 'LauncherDockered publishes nginx on this host port by default.',
        remediation: null,
      }
    }

    if (canInspectDocker) {
      const owner = await this.findManagedPortOwner(port, installations)
      if (owner) {
        return {
          id: 'docker-port',
          title: `TCP port ${port}`,
          status: 'passed',
          message: `TCP port ${port} is already published by this panel's LauncherDockered installation.`,
          details: `${owner.containerName} (${owner.containerId.slice(0, 12)}) · ${owner.workingDirectory}`,
          remediation: null,
        }
      }
    }

    return {
      id: 'docker-port',
      title: `TCP port ${port}`,
      status: 'failed',
      message: `TCP port ${port} is already in use or cannot be bound.`,
      details: 'No registered LauncherDockered nginx container owns this port.',
      remediation: `Stop the service using TCP port ${port} or configure another host port before installation.`,
    }
  }

  private async findManagedPortOwner(
    port: number,
    installations: GravitInstallation[],
  ): Promise<DockerPortOwner | null> {
    if (installations.length === 0) return null

    try {
      const result = await this.commandRunner([
        'docker',
        'ps',
        '--filter',
        `publish=${port}`,
        '--format',
        '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.service"}}',
      ])
      if (result.exitCode !== 0) return null

      const registeredPaths = new Set(installations.map((installation) => resolve(installation.path)))
      for (const line of result.output.split(/\r?\n/)) {
        if (!line) continue
        const [containerId, containerName, workingDirectory, service] = line.split('\t')
        if (!containerId || !containerName || !workingDirectory || service !== 'nginx') continue
        if (!registeredPaths.has(resolve(workingDirectory))) continue

        return { containerId, containerName, workingDirectory, service }
      }
    } catch {
      return null
    }

    return null
  }
}
