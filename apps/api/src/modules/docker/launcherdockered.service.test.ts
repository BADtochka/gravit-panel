import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobTaskContext } from '../jobs/jobs.runner'
import {
  LauncherDockeredService,
  type InstallerCommandRunner,
} from './launcherdockered.service'
import { launcherDockeredSource } from './docker.service'

const revision = '723203b56f8d58f2447edd20ac8a5b84a31ef816'
const compose = `
services:
  gravitlauncher:
    image: ghcr.io/gravitlauncher/launcher
  nginx:
    image: nginx
`

const nginxConfig = `
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  location /api {
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
`

const createContext = () => {
  const logs: string[] = []
  const progress: number[] = []
  const context: JobTaskContext = {
    signal: new AbortController().signal,
    log: (message) => logs.push(message),
    progress: (value) => progress.push(value),
  }
  return { context, logs, progress }
}

const ready = async () => {}

describe('LauncherDockeredService', () => {
  test('reports an unhealthy LaunchServer when the container control socket cannot be probed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-launcherdockered-health-'))
    const installationPath = join(root, 'default')
    await mkdir(installationPath, { recursive: true })
    await writeFile(join(installationPath, 'docker-compose.yml'), compose)
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: installationPath,
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: launcherDockeredSource.repository,
      sourceRevision: launcherDockeredSource.revision,
      createdAt: now,
      updatedAt: now,
    }
    const commands: string[][] = []
    const service = new LauncherDockeredService(root, async (command) => {
      commands.push(command)
      return { exitCode: 1, output: 'service "gravitlauncher" is not running' }
    }, ready)

    try {
      await expect(service.checkLaunchServer(installation)).resolves.toMatchObject({
        installationId: installation.id,
        status: 'unhealthy',
        message: 'service "gravitlauncher" is not running',
      })
      expect(commands).toEqual([[
        'docker', 'compose', 'exec', '-T', 'gravitlauncher', 'test', '-S', '/app/data/control-file',
      ]])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('restarts only the LaunchServer service and waits for its control socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-launcherdockered-restart-'))
    const installationPath = join(root, 'default')
    await mkdir(installationPath, { recursive: true })
    await writeFile(join(installationPath, 'docker-compose.yml'), compose)
    await writeFile(
      join(installationPath, '.env'),
      'ADDRESS=localhost:17549\nPROJECTNAME=TEST\n',
    )
    const commands: string[][] = []
    const readinessPaths: string[] = []
    const service = new LauncherDockeredService(
      root,
      async (command) => {
        commands.push(command)
        return { exitCode: 0, output: 'restarted' }
      },
      async (path) => {
        readinessPaths.push(path)
      },
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: installationPath,
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: launcherDockeredSource.repository,
      sourceRevision: launcherDockeredSource.revision,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await service.restartLaunchServer(installation, createContext().context)
      expect(commands).toEqual([
        ['docker', 'compose', 'stop', 'gravitlauncher'],
        [
          'docker',
          'compose',
          'run',
          '--rm',
          '--no-deps',
          '--user',
          '0:0',
          '--entrypoint',
          'sh',
          'gravitlauncher',
          '-c',
          expect.stringContaining('rm -f /app/data/control-file'),
        ],
        ['docker', 'compose', 'up', '-d', 'gravitlauncher'],
      ])
      expect(readinessPaths).toEqual([installationPath])
      expect(await readFile(join(installationPath, '.env'), 'utf8')).toContain(
        'JAVA_OPTS=--add-opens=java.base/java.time=com.google.gson -Dlauncher.httpTimeout=30000',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('synchronizes persisted public URLs through a configured HTTPS path prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-launcherdockered-public-url-'))
    const installationPath = join(root, 'default')
    await mkdir(join(installationPath, 'launcher'), { recursive: true })
    await writeFile(join(installationPath, 'docker-compose.yml'), compose)
    await writeFile(join(installationPath, 'nginx.conf'), nginxConfig)
    await writeFile(
      join(installationPath, '.env'),
      'ADDRESS=mine.example.com\nPROJECTNAME = TEST\n',
    )
    await writeFile(
      join(installationPath, 'launcher', 'LaunchServer.json'),
      JSON.stringify({
        updatesProvider: {
          updatesDir: 'updates',
          urls: {
            EXE_WINDOWS_X86_64: 'http://old.example/updates/Launcher.exe',
            JAR: 'http://old.example/updates/Launcher.jar',
          },
        },
        netty: {
          downloadURL: 'http://old.example/updates/',
          address: 'ws://old.example/api',
        },
      }),
    )
    const commands: string[][] = []
    const service = new LauncherDockeredService(
      root,
      async (command) => {
        commands.push(command)
        return { exitCode: 0, output: 'ok' }
      },
      ready,
      'https://mine.example.com/launcher',
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: installationPath,
      address: 'mine.example.com',
      projectName: 'TEST',
      sourceRepository: launcherDockeredSource.repository,
      sourceRevision: launcherDockeredSource.revision,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await service.restartLaunchServer(installation, createContext().context)
      expect(commands[0]).toEqual(['docker', 'compose', 'restart', 'nginx'])
      const config = JSON.parse(
        await readFile(join(installationPath, 'launcher', 'LaunchServer.json'), 'utf8'),
      )
      // The nginx document root IS the updates directory, so synchronized URLs
      // must be root-relative to it. A persisted "/updates/" prefix would
      // resolve to "updates/updates/..." and 404 every artifact download.
      expect(config).toMatchObject({
        updatesProvider: {
          urls: {
            EXE_WINDOWS_X86_64: 'https://mine.example.com/launcher/Launcher.exe',
            JAR: 'https://mine.example.com/launcher/Launcher.jar',
          },
        },
        netty: {
          downloadURL: 'https://mine.example.com/launcher/',
          address: 'wss://mine.example.com/launcher/api',
        },
      })
      expect(await readFile(join(installationPath, 'nginx.conf'), 'utf8')).toContain(
        'proxy_set_header X-Forwarded-Proto $launcher_forwarded_proto;',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps the %dirname% download template and root-relative artifact URLs intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-launcherdockered-dirname-'))
    const installationPath = join(root, 'default')
    await mkdir(join(installationPath, 'launcher'), { recursive: true })
    await writeFile(join(installationPath, 'docker-compose.yml'), compose)
    await writeFile(join(installationPath, 'nginx.conf'), nginxConfig)
    await writeFile(
      join(installationPath, '.env'),
      'ADDRESS=mine.example.com\nPROJECTNAME=TEST\n',
    )
    await writeFile(
      join(installationPath, 'launcher', 'LaunchServer.json'),
      JSON.stringify({
        updatesProvider: {
          updatesDir: 'updates',
          binaryName: 'Launcher',
          urls: {
            JAR: 'http://old.example/Launcher.jar',
            EXE_WINDOWS_X86_64: 'http://old.example/Launcher.exe',
          },
        },
        netty: {
          downloadURL: 'http://old.example/%dirname%/',
          address: 'ws://old.example/api',
        },
      }),
    )
    const commands: string[][] = []
    const service = new LauncherDockeredService(
      root,
      async (command) => {
        commands.push(command)
        return { exitCode: 0, output: 'ok' }
      },
      ready,
    )
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: installationPath,
      address: 'mine.example.com',
      projectName: 'TEST',
      sourceRepository: launcherDockeredSource.repository,
      sourceRevision: launcherDockeredSource.revision,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await service.restartLaunchServer(installation, createContext().context)
      const config = JSON.parse(
        await readFile(join(installationPath, 'launcher', 'LaunchServer.json'), 'utf8'),
      )
      // Only scheme and host change. Root-relative paths and the %dirname%
      // profile template already match the updates-dir document root and
      // must survive synchronization untouched.
      expect(config).toMatchObject({
        updatesProvider: {
          urls: {
            JAR: 'https://mine.example.com/Launcher.jar',
            EXE_WINDOWS_X86_64: 'https://mine.example.com/Launcher.exe',
          },
        },
        netty: {
          downloadURL: 'https://mine.example.com/%dirname%/',
          address: 'wss://mine.example.com/api',
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('removes a registered installation through Compose before deleting its exact path', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-panel-remove-'))
    const installationsRoot = join(temporaryRoot, 'installations')
    const installationPath = join(installationsRoot, 'primary')
    await mkdir(join(installationPath, 'launcher', 'config'), { recursive: true })
    await writeFile(join(installationPath, 'docker-compose.yml'), compose)
    await writeFile(join(installationPath, 'launcher', 'config', 'LaunchServer.json'), '{}')
    const commands: string[][] = []
    const runner: InstallerCommandRunner = async (command) => {
      commands.push(command)
      return { exitCode: 0, output: 'ok' }
    }
    const service = new LauncherDockeredService(installationsRoot, runner, ready)
    const installation = {
      id: crypto.randomUUID(),
      name: 'primary',
      path: installationPath,
      address: 'localhost:17549',
      projectName: 'PRIMARY',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: revision,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    try {
      const result = await service.removeInstallation(installation, createContext().context)

      expect(result).toEqual({
        installationId: installation.id,
        installationPath,
        composeResourcesRemoved: true,
        filesRemoved: true,
      })
      expect(commands).toEqual([
        ['docker', 'compose', 'stop'],
        [
          'docker', 'compose', 'run', '--rm', '--no-deps', '--user', '0:0',
          '--entrypoint', 'chown', 'gravitlauncher', '-R',
          `${process.getuid?.()}:${process.getgid?.()}`, '/app/data',
        ],
        ['docker', 'compose', 'down', '--volumes', '--remove-orphans'],
      ])
      await expect(readFile(join(installationPath, 'docker-compose.yml'))).rejects.toThrow()
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  test('keeps installation files when Compose resource cleanup fails', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-panel-remove-failure-'))
    const installationsRoot = join(temporaryRoot, 'installations')
    const installationPath = join(installationsRoot, 'primary')
    await mkdir(join(installationPath, 'launcher'), { recursive: true })
    await writeFile(join(installationPath, 'docker-compose.yml'), compose)
    const service = new LauncherDockeredService(
      installationsRoot,
      async (command) => ({
        exitCode: command.includes('down') ? 1 : 0,
        output: command.includes('down') ? 'daemon unavailable' : 'ok',
      }),
      ready,
    )
    const installation = {
      id: crypto.randomUUID(),
      name: 'primary',
      path: installationPath,
      address: 'localhost:17549',
      projectName: 'PRIMARY',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: revision,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    try {
      await expect(
        service.removeInstallation(installation, createContext().context),
      ).rejects.toThrow('Removing LauncherDockered Compose resources failed')
      expect(await readFile(join(installationPath, 'docker-compose.yml'), 'utf8')).toBe(compose)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  test('refuses broad paths and unverified external directories', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-panel-remove-guard-'))
    const installationsRoot = join(temporaryRoot, 'installations')
    const externalPath = join(temporaryRoot, 'external')
    await mkdir(externalPath, { recursive: true })
    await writeFile(join(externalPath, 'docker-compose.yml'), 'services:\n  other:\n')
    const service = new LauncherDockeredService(installationsRoot, async () => ({
      exitCode: 0,
      output: 'ok',
    }), ready)
    const installation = {
      id: crypto.randomUUID(),
      name: 'unsafe',
      path: installationsRoot,
      address: 'localhost:17549',
      projectName: 'UNSAFE',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: revision,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    try {
      await expect(
        service.removeInstallation(installation, createContext().context),
      ).rejects.toThrow('broad installation path')
      await expect(
        service.removeInstallation(
          { ...installation, path: externalPath },
          createContext().context,
        ),
      ).rejects.toThrow('not a supported LauncherDockered project')
      expect(await readFile(join(externalPath, 'docker-compose.yml'), 'utf8')).toContain('other')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  test('imports a Git checkout, snapshots .env, and runs allowlisted Compose commands', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-panel-import-'))
    const projectPath = join(temporaryRoot, 'existing')
    await mkdir(projectPath)
    await writeFile(join(projectPath, 'docker-compose.yml'), compose)
    await writeFile(join(projectPath, '.env'), 'ADDRESS=old.example\nPROJECTNAME=OLD\n')

    const commands: string[][] = []
    const runner: InstallerCommandRunner = async (command, _cwd, _signal, onLine) => {
      commands.push(command)
      if (command[0] === 'git' && command[1] === 'remote') {
        return {
          exitCode: 0,
          output: 'https://github.com/GravitLauncher/LauncherDockered.git\n',
        }
      }
      if (command[0] === 'git') return { exitCode: 0, output: `${revision}\n` }
      onLine(`ran ${command.join(' ')}`)
      return { exitCode: 0, output: 'ok' }
    }
    const service = new LauncherDockeredService(
      join(temporaryRoot, 'installations'),
      runner,
      ready,
    )
    const { context, logs, progress } = createContext()

    try {
      const result = await service.install(
        {
          mode: 'import',
          installationName: 'existing',
          importPath: projectPath,
          address: 'launcher.example.com',
          projectName: 'EXAMPLE',
        },
        context,
      )

      expect(result).toMatchObject({
        installationPath: projectPath,
        mode: 'import',
        sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
        sourceRevision: revision,
      })
      expect(result.environmentBackupPath).not.toBeNull()
      expect(await readFile(join(projectPath, '.env'), 'utf8')).toBe(
        'ADDRESS=launcher.example.com\n' +
          'PROJECTNAME=EXAMPLE\n' +
          'JAVA_OPTS=--add-opens=java.base/java.time=com.google.gson -Dlauncher.httpTimeout=30000\n',
      )
      expect(await readFile(result.environmentBackupPath!, 'utf8')).toContain('old.example')
      expect(commands).toEqual([
        ['git', 'remote', 'get-url', 'origin'],
        ['git', 'rev-parse', 'HEAD'],
        ['docker', 'compose', 'up', '-d'],
        ['docker', 'compose', 'ps'],
      ])
      expect(logs).toContain('ran docker compose up -d')
      expect(progress.at(-1)).toBe(95)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  test('attaches a running LauncherDockered server without writing or starting services', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-panel-attach-'))
    const projectPath = join(temporaryRoot, 'running')
    await mkdir(projectPath)
    await writeFile(join(projectPath, 'docker-compose.yml'), compose)
    await writeFile(join(projectPath, '.env'), 'ADDRESS=running.example\nPROJECTNAME=RUNNING\n')
    const commands: string[][] = []
    let readinessChecks = 0
    const runner: InstallerCommandRunner = async (command) => {
      commands.push(command)
      if (command[0] === 'git' && command[1] === 'remote') {
        return {
          exitCode: 0,
          output: 'https://github.com/GravitLauncher/LauncherDockered.git\n',
        }
      }
      if (command[0] === 'git') return { exitCode: 0, output: `${revision}\n` }
      return { exitCode: 0, output: 'services are running' }
    }
    const service = new LauncherDockeredService(
      join(temporaryRoot, 'installations'),
      runner,
      async () => {
        readinessChecks += 1
      },
    )

    try {
      const result = await service.install(
        {
          mode: 'attach',
          installationName: 'existing',
          importPath: projectPath,
          address: 'running.example',
          projectName: 'RUNNING',
        },
        createContext().context,
      )

      expect(result).toMatchObject({
        installationPath: projectPath,
        mode: 'attach',
        environmentBackupPath: null,
      })
      expect(commands).toEqual([
        ['git', 'remote', 'get-url', 'origin'],
        ['git', 'rev-parse', 'HEAD'],
        ['docker', 'compose', 'ps'],
      ])
      expect(await readFile(join(projectPath, '.env'), 'utf8')).toBe(
        'ADDRESS=running.example\nPROJECTNAME=RUNNING\n',
      )
      expect(readinessChecks).toBe(1)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  test('clones to staging and checks out the pinned revision before starting Compose', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-panel-clone-'))
    const installationsRoot = join(temporaryRoot, 'installations')
    const commands: string[][] = []
    const runner: InstallerCommandRunner = async (command) => {
      commands.push(command)
      if (command[0] === 'git' && command[1] === 'clone') {
        const stagingPath = command.at(-1)
        if (!stagingPath) throw new Error('Missing staging path')
        await mkdir(stagingPath, { recursive: true })
        await writeFile(join(stagingPath, 'docker-compose.yml'), compose)
      }
      return { exitCode: 0, output: 'ok' }
    }
    const service = new LauncherDockeredService(installationsRoot, runner, ready)
    const { context } = createContext()

    try {
      const result = await service.install(
        {
          mode: 'clone',
          installationName: 'primary',
          address: 'localhost:17549',
          projectName: 'PRIMARY',
        },
        context,
      )

      expect(result.installationPath).toBe(join(installationsRoot, 'primary'))
      expect(result.sourceRevision).toBe(revision)
      expect(commands[0]?.slice(0, 4)).toEqual([
        'git',
        'clone',
        '--filter=blob:none',
        '--no-checkout',
      ])
      expect(commands[1]).toEqual(['git', 'checkout', '--detach', revision])
      expect(commands.at(-2)).toEqual(['docker', 'compose', 'up', '-d'])
      expect(commands.at(-1)).toEqual(['docker', 'compose', 'ps'])
      await expect(
        readFile(join(result.installationPath, '.gravit-panel-pending-install.json'), 'utf8'),
      ).rejects.toThrow()
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  test('removes fresh install files and Compose volumes when startup fails', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-panel-rollback-'))
    const installationsRoot = join(temporaryRoot, 'installations')
    const installationPath = join(installationsRoot, 'failed')
    const commands: string[][] = []
    const runner: InstallerCommandRunner = async (command) => {
      commands.push(command)
      if (command[0] === 'git' && command[1] === 'clone') {
        const stagingPath = command.at(-1)
        if (!stagingPath) throw new Error('Missing staging path')
        await mkdir(stagingPath, { recursive: true })
        await writeFile(join(stagingPath, 'docker-compose.yml'), compose)
      }
      if (command.slice(0, 4).join(' ') === 'docker compose up -d') {
        return { exitCode: 1, output: 'compose failed' }
      }
      return { exitCode: 0, output: 'ok' }
    }
    const service = new LauncherDockeredService(installationsRoot, runner, ready)
    const { context, logs } = createContext()

    try {
      await expect(
        service.install(
          {
            mode: 'clone',
            installationName: 'failed',
            address: 'localhost:17549',
            projectName: 'FAILED',
          },
          context,
        ),
      ).rejects.toThrow('Starting LauncherDockered services failed')

      expect(commands.at(-1)).toEqual([
        'docker',
        'compose',
        'down',
        '--volumes',
        '--remove-orphans',
      ])
      await expect(readFile(join(installationPath, 'docker-compose.yml'), 'utf8')).rejects.toThrow()
      expect(logs.some((line) => line.includes('Incomplete installation directory removed'))).toBe(
        true,
      )
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  test('does not register a fresh install before the LaunchServer socket is ready', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-panel-readiness-'))
    const installationsRoot = join(temporaryRoot, 'installations')
    const installationPath = join(installationsRoot, 'not-ready')
    const commands: string[][] = []
    const runner: InstallerCommandRunner = async (command) => {
      commands.push(command)
      if (command[0] === 'git' && command[1] === 'clone') {
        const stagingPath = command.at(-1)
        if (!stagingPath) throw new Error('Missing staging path')
        await mkdir(stagingPath, { recursive: true })
        await writeFile(join(stagingPath, 'docker-compose.yml'), compose)
      }
      return { exitCode: 0, output: 'ok' }
    }
    const service = new LauncherDockeredService(installationsRoot, runner, async () => {
      throw new Error('LaunchServer control socket did not become ready')
    })
    const { context, logs } = createContext()

    try {
      await expect(
        service.install(
          {
            mode: 'clone',
            installationName: 'not-ready',
            address: 'localhost:17549',
            projectName: 'NOT_READY',
          },
          context,
        ),
      ).rejects.toThrow('control socket did not become ready')

      expect(commands.at(-1)).toEqual([
        'docker',
        'compose',
        'down',
        '--volumes',
        '--remove-orphans',
      ])
      expect(logs).toContain('Waiting for LaunchServer control socket')
      await expect(readFile(join(installationPath, 'docker-compose.yml'), 'utf8')).rejects.toThrow()
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  test('recovers a marked interrupted install before retrying the same name', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-panel-recover-'))
    const installationsRoot = join(temporaryRoot, 'installations')
    const installationPath = join(installationsRoot, 'default')
    await mkdir(installationPath, { recursive: true })
    await writeFile(join(installationPath, 'docker-compose.yml'), compose)
    await writeFile(join(installationPath, '.gravit-panel-pending-install.json'), '{}\n')

    const commands: string[][] = []
    const runner: InstallerCommandRunner = async (command) => {
      commands.push(command)
      if (command[0] === 'git' && command[1] === 'clone') {
        const stagingPath = command.at(-1)
        if (!stagingPath) throw new Error('Missing staging path')
        await mkdir(stagingPath, { recursive: true })
        await writeFile(join(stagingPath, 'docker-compose.yml'), compose)
      }
      return { exitCode: 0, output: 'ok' }
    }
    const service = new LauncherDockeredService(installationsRoot, runner, ready)
    const { context, logs } = createContext()

    try {
      const result = await service.install(
        {
          mode: 'clone',
          installationName: 'default',
          address: 'localhost:17549',
          projectName: 'DEFAULT',
        },
        context,
      )

      expect(result.installationPath).toBe(installationPath)
      expect(commands[0]).toEqual([
        'docker',
        'compose',
        'down',
        '--volumes',
        '--remove-orphans',
      ])
      expect(logs).toContain(`Recovering incomplete installation: ${installationPath}`)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  test('rejects unsafe environment values before running commands', async () => {
    let commandRuns = 0
    const service = new LauncherDockeredService(
      '/tmp/gravit-panel-test',
      async () => {
        commandRuns += 1
        return { exitCode: 0, output: '' }
      },
      ready,
    )

    await expect(
      service.install(
        {
          mode: 'clone',
          installationName: 'default',
          address: 'example.com\nINJECTED=true',
          projectName: 'TEST',
        },
        createContext().context,
      ),
    ).rejects.toThrow('Address must be a hostname')
    expect(commandRuns).toBe(0)
  })
})
