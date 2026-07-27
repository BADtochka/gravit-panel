import type {
  GravitInstallation,
  LauncherDockeredInstallInput,
  LauncherDockeredInstallResult,
  LauncherDockeredRemovalResult,
  LaunchServerRuntimeHealth,
} from '@gravit-panel/shared'
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { launcherDockeredSource } from './docker.service'

interface CommandResult {
  exitCode: number
  output: string
}

export type InstallerCommandRunner = (
  command: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => void,
) => Promise<CommandResult>

export type InstallationReadinessWaiter = (
  installationPath: string,
  signal: AbortSignal,
) => Promise<void>

const readLines = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    pending += decoder.decode(value, { stream: true })
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line) onLine(line)
    }
  }

  pending += decoder.decode()
  if (pending) onLine(pending)
}

const runCommand: InstallerCommandRunner = async (command, cwd, signal, onLine) => {
  signal.throwIfAborted()
  const process = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const abort = () => process.kill()
  signal.addEventListener('abort', abort, { once: true })

  try {
    const output: string[] = []
    const captureLine = (line: string) => {
      output.push(line)
      onLine(line)
    }
    const [exitCode] = await Promise.all([
      process.exited,
      readLines(process.stdout, captureLine),
      readLines(process.stderr, captureLine),
    ])

    return { exitCode, output: output.join('\n').trim() }
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

const exists = async (path: string) => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

const waitForControlSocket: InstallationReadinessWaiter = async (
  installationPath,
  signal,
) => {
  const timeoutMs = 60_000
  const deadline = Date.now() + timeoutMs
  let lastProbeOutput = ''

  while (Date.now() <= deadline) {
    signal.throwIfAborted()
    const result = await runCommand(
      [
        'docker',
        'compose',
        'exec',
        '-T',
        'gravitlauncher',
        'test',
        '-S',
        '/app/data/control-file',
      ],
      installationPath,
      signal,
      () => {},
    )
    if (result.exitCode === 0) return
    if (result.output) lastProbeOutput = result.output
    await Bun.sleep(250)
  }

  const details = lastProbeOutput ? ` Last probe: ${lastProbeOutput}` : ''
  throw new Error(
    `LaunchServer control socket did not become ready within ${timeoutMs}ms.${details}`,
  )
}

const safeTimestamp = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const pendingInstallMarker = '.gravit-panel-pending-install.json'
const fileAuthJvmOption = '--add-opens=java.base/java.time=com.google.gson'
const launchServerRestartMaintenance = [
  'rm -f /app/data/control-file',
  'sessions=/app/data/config/FileAuthSystem/Sessions.json',
  'database=/app/data/config/FileAuthSystem/Database.json',
  'if [ -f "$sessions" ] && [ ! -s "$sessions" ]; then printf "[]\\n" > "$sessions"; fi',
  'if [ -f "$database" ] && [ ! -s "$database" ]; then printf "{}\\n" > "$database"; fi',
].join('; ')

export class LauncherDockeredService {
  readonly installationsRoot: string

  constructor(
    installationsRoot: string,
    private readonly commandRunner: InstallerCommandRunner = runCommand,
    private readonly readinessWaiter: InstallationReadinessWaiter = waitForControlSocket,
  ) {
    this.installationsRoot = resolve(installationsRoot)
  }

  async install(
    input: LauncherDockeredInstallInput,
    context: JobTaskContext,
  ): Promise<LauncherDockeredInstallResult> {
    this.validateInput(input)
    context.progress(5, 'Installation request validated')

    const source =
      input.mode === 'clone'
        ? await this.cloneSource(input.installationName, context)
        : await this.importSource(input.importPath ?? '', context)

    try {
      await this.validateComposeProject(source.installationPath)
      context.progress(45, 'LauncherDockered project verified')

      if (input.mode === 'attach') {
        const existingEnvironment = await this.readExistingEnvironment(
          source.installationPath,
        )
        if (
          existingEnvironment.address !== input.address ||
          existingEnvironment.projectName !== input.projectName
        ) {
          throw new Error(
            `Attach metadata does not match .env (ADDRESS=${existingEnvironment.address}, PROJECTNAME=${existingEnvironment.projectName})`,
          )
        }
        context.log('Existing .env metadata verified without modification')
        context.progress(60, 'Inspecting existing LauncherDockered services')
        await this.runChecked(
          ['docker', 'compose', 'ps'],
          source.installationPath,
          context,
          'Reading existing Compose service status',
        )
        context.log('Waiting for existing LaunchServer control socket')
        await this.readinessWaiter(source.installationPath, context.signal)
        context.progress(95, 'Existing LaunchServer control socket is ready')
        return {
          installationPath: source.installationPath,
          mode: input.mode,
          address: input.address,
          projectName: input.projectName,
          sourceRepository: launcherDockeredSource.repository,
          sourceRevision: source.sourceRevision,
          environmentBackupPath: null,
        }
      }

      const environmentBackupPath = await this.writeEnvironment(
        source.installationPath,
        input,
        context,
      )
      await mkdir(join(source.installationPath, 'launcher'), { recursive: true })
      context.progress(60, 'Environment and persistent launcher directory are ready')

      await this.runChecked(
        ['docker', 'compose', 'up', '-d'],
        source.installationPath,
        context,
        'Starting LauncherDockered services',
      )
      context.progress(90, 'LauncherDockered services started')

      await this.runChecked(
        ['docker', 'compose', 'ps'],
        source.installationPath,
        context,
        'Reading Compose service status',
      )

      context.log('Waiting for LaunchServer control socket')
      await this.readinessWaiter(source.installationPath, context.signal)
      context.progress(95, 'LaunchServer control socket is ready')

      if (input.mode === 'clone') {
        await rm(join(source.installationPath, pendingInstallMarker), { force: true })
      }

      return {
        installationPath: source.installationPath,
        mode: input.mode,
        address: input.address,
        projectName: input.projectName,
        sourceRepository: launcherDockeredSource.repository,
        sourceRevision: source.sourceRevision,
        environmentBackupPath,
      }
    } catch (error) {
      if (input.mode === 'clone') {
        await this.rollbackFreshInstallation(source.installationPath, context)
      }
      throw error
    }
  }

  async removeInstallation(
    installation: GravitInstallation,
    context: JobTaskContext,
  ): Promise<Omit<LauncherDockeredRemovalResult, 'registrationRemoved'>> {
    const installationPath = resolve(installation.path)
    this.validateRemovalPath(installationPath)
    context.progress(5, 'Installation removal request validated')

    if (!(await exists(installationPath))) {
      context.log(`Installation directory is already absent: ${installationPath}`)
      return {
        installationId: installation.id,
        installationPath,
        composeResourcesRemoved: false,
        filesRemoved: false,
      }
    }

    const managedInstallation = dirname(installationPath) === this.installationsRoot
    if (!managedInstallation) {
      await this.validateComposeProject(installationPath)
      context.log('External installation path re-verified before deletion')
    }

    const getuid = process.getuid?.()
    const getgid = process.getgid?.()
    if (getuid === undefined || getgid === undefined) {
      throw new Error('Installation removal requires a Unix host user identity')
    }

    context.progress(15, 'Stopping LauncherDockered services')
    await this.runChecked(
      ['docker', 'compose', 'stop'],
      installationPath,
      context,
      'Stopping LauncherDockered services before ownership cleanup',
    )

    context.progress(35, 'Preparing Launcher data for removal')
    await this.runChecked(
      [
        'docker',
        'compose',
        'run',
        '--rm',
        '--no-deps',
        '--user',
        '0:0',
        '--entrypoint',
        'chown',
        'gravitlauncher',
        '-R',
        `${getuid}:${getgid}`,
        '/app/data',
      ],
      installationPath,
      context,
      'Preparing Launcher volume ownership',
    )

    context.progress(55, 'Removing LauncherDockered containers and volumes')
    await this.runChecked(
      ['docker', 'compose', 'down', '--volumes', '--remove-orphans'],
      installationPath,
      context,
      'Removing LauncherDockered Compose resources',
    )

    context.progress(75, 'Removing installation files')
    await rm(installationPath, { recursive: true, force: true })
    if (await exists(installationPath)) {
      throw new Error(`Installation directory still exists after removal: ${installationPath}`)
    }
    context.log(`Installation directory removed: ${installationPath}`)
    context.progress(90, 'Installation files and Compose resources removed')

    return {
      installationId: installation.id,
      installationPath,
      composeResourcesRemoved: true,
      filesRemoved: true,
    }
  }

  async restartLaunchServer(
    installation: GravitInstallation,
    context: JobTaskContext,
  ): Promise<void> {
    const installationPath = resolve(installation.path)
    await this.validateComposeProject(installationPath)
    await this.ensureLaunchServerJvmCompatibility(installationPath, context)
    await this.runChecked(
      ['docker', 'compose', 'stop', 'gravitlauncher'],
      installationPath,
      context,
      'Stopping LaunchServer before launcher binary initialization',
    )
    await this.runChecked(
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
        launchServerRestartMaintenance,
      ],
      installationPath,
      context,
      'Removing the stale control socket and repairing empty FileAuthSystem stores',
    )
    await this.runChecked(
      ['docker', 'compose', 'up', '-d', 'gravitlauncher'],
      installationPath,
      context,
      'Starting LaunchServer with launcher binary providers',
    )
    context.log('Waiting for LaunchServer control socket after restart')
    await this.readinessWaiter(installationPath, context.signal)
    context.log('LaunchServer control socket is ready after restart')
  }

  async checkLaunchServer(installation: GravitInstallation): Promise<LaunchServerRuntimeHealth> {
    const checkedAt = new Date().toISOString()
    const installationPath = resolve(installation.path)

    try {
      await this.validateComposeProject(installationPath)
      const result = await this.commandRunner(
        [
          'docker',
          'compose',
          'exec',
          '-T',
          'gravitlauncher',
          'test',
          '-S',
          '/app/data/control-file',
        ],
        installationPath,
        new AbortController().signal,
        () => {},
      )
      if (result.exitCode === 0) {
        return {
          installationId: installation.id,
          status: 'healthy',
          checkedAt,
          message: 'LaunchServer control socket is ready.',
        }
      }

      return {
        installationId: installation.id,
        status: 'unhealthy',
        checkedAt,
        message: result.output || 'LaunchServer container or control socket is unavailable.',
      }
    } catch (error) {
      return {
        installationId: installation.id,
        status: 'unhealthy',
        checkedAt,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private validateInput(input: LauncherDockeredInstallInput) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.installationName)) {
      throw new Error('Installation name must contain only letters, numbers, hyphens, and underscores')
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,254}$/.test(input.address)) {
      throw new Error('Address must be a hostname or host:port without a URL scheme or path')
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.projectName)) {
      throw new Error('Project name must contain only letters, numbers, hyphens, and underscores')
    }
    if (
      (input.mode === 'import' || input.mode === 'attach') &&
      (!input.importPath || !isAbsolute(input.importPath))
    ) {
      throw new Error('Import path must be an absolute path')
    }
  }

  private validateRemovalPath(installationPath: string) {
    if (
      installationPath === this.installationsRoot ||
      dirname(installationPath) === installationPath
    ) {
      throw new Error('Refusing to remove a broad installation path')
    }
    const workspacePath = resolve(process.cwd())
    const workspaceRelative = relative(installationPath, workspacePath)
    if (
      workspaceRelative === '' ||
      (!workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative))
    ) {
      throw new Error('Refusing to remove a path containing the panel workspace')
    }
  }

  private async cloneSource(installationName: string, context: JobTaskContext) {
    await mkdir(this.installationsRoot, { recursive: true })
    const installationPath = join(this.installationsRoot, installationName)
    if (await exists(installationPath)) {
      const markerPath = join(installationPath, pendingInstallMarker)
      if (!(await exists(markerPath))) {
        throw new Error(`Installation path already exists: ${installationPath}`)
      }
      context.log(`Recovering incomplete installation: ${installationPath}`)
      await this.rollbackFreshInstallation(installationPath, context)
    }

    const stagingPath = `${installationPath}.staging-${crypto.randomUUID()}`
    context.progress(15, 'Cloning pinned LauncherDockered source')

    try {
      await this.runChecked(
        ['git', 'clone', '--filter=blob:none', '--no-checkout', launcherDockeredSource.repository, stagingPath],
        this.installationsRoot,
        context,
        'Cloning LauncherDockered repository',
      )
      await this.runChecked(
        ['git', 'checkout', '--detach', launcherDockeredSource.revision],
        stagingPath,
        context,
        `Checking out ${launcherDockeredSource.revision}`,
      )
      await writeFile(
        join(stagingPath, pendingInstallMarker),
        `${JSON.stringify({
          sourceRepository: launcherDockeredSource.repository,
          sourceRevision: launcherDockeredSource.revision,
          createdAt: new Date().toISOString(),
        }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      )
      await rename(stagingPath, installationPath)
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true })
      throw error
    }

    context.progress(40, 'Pinned LauncherDockered source cloned')
    return { installationPath, sourceRevision: launcherDockeredSource.revision }
  }

  private async rollbackFreshInstallation(
    installationPath: string,
    context: JobTaskContext,
  ) {
    const resolvedPath = resolve(installationPath)
    if (dirname(resolvedPath) !== this.installationsRoot) {
      throw new Error(`Refusing to clean installation outside ${this.installationsRoot}`)
    }

    context.log(`Rolling back incomplete installation: ${resolvedPath}`)
    try {
      const result = await this.commandRunner(
        ['docker', 'compose', 'down', '--volumes', '--remove-orphans'],
        resolvedPath,
        new AbortController().signal,
        context.log,
      )
      if (result.exitCode !== 0) {
        context.log(`Compose cleanup exited with code ${result.exitCode}; removing files anyway`)
      }
    } catch (error) {
      context.log(
        `Compose cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    await rm(resolvedPath, { recursive: true, force: true })
    context.log(`Incomplete installation directory removed: ${resolvedPath}`)
  }

  private async importSource(importPath: string, context: JobTaskContext) {
    const installationPath = await realpath(importPath)
    context.progress(20, 'Inspecting existing LauncherDockered project')
    const remoteResult = await this.runChecked(
      ['git', 'remote', 'get-url', 'origin'],
      installationPath,
      context,
      'Reading imported source repository',
    )
    const normalizedRemote = remoteResult.output.trim().replace(/\.git$/, '')
    const supportedRemotes = new Set([
      launcherDockeredSource.repository,
      'git@github.com:GravitLauncher/LauncherDockered',
      'ssh://git@github.com/GravitLauncher/LauncherDockered',
    ])
    if (!supportedRemotes.has(normalizedRemote)) {
      throw new Error('Imported project origin is not GravitLauncher/LauncherDockered')
    }

    const revisionResult = await this.runChecked(
      ['git', 'rev-parse', 'HEAD'],
      installationPath,
      context,
      'Reading imported source revision',
    )
    const sourceRevision = revisionResult.output
      .split(/\s/)
      .find((value) => /^[a-f0-9]{40}$/.test(value))
    if (!sourceRevision) throw new Error('Imported project does not report a valid Git revision')

    return { installationPath, sourceRevision }
  }

  private async validateComposeProject(installationPath: string) {
    const composePath = join(installationPath, launcherDockeredSource.file)
    await access(composePath)
    const compose = await readFile(composePath, 'utf8')
    if (!compose.includes('gravitlauncher:') || !compose.includes('nginx:')) {
      throw new Error('The selected directory is not a supported LauncherDockered project')
    }
  }

  private async readExistingEnvironment(installationPath: string) {
    const contents = await readFile(join(installationPath, '.env'), 'utf8')
    const values = new Map<string, string>()
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const separator = line.indexOf('=')
      if (separator <= 0) continue
      values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
    }
    const address = values.get('ADDRESS')
    const projectName = values.get('PROJECTNAME')
    if (!address || !projectName) {
      throw new Error('Existing LauncherDockered .env must define ADDRESS and PROJECTNAME')
    }
    return { address, projectName }
  }

  private async writeEnvironment(
    installationPath: string,
    input: LauncherDockeredInstallInput,
    context: JobTaskContext,
  ) {
    const environmentPath = join(installationPath, '.env')
    let backupPath: string | null = null

    if (await exists(environmentPath)) {
      backupPath = join(installationPath, `.env.backup-${safeTimestamp()}`)
      await copyFile(environmentPath, backupPath)
      context.log(`Snapshot created: ${backupPath}`)
    }

    const temporaryPath = join(installationPath, `.env.pending-${crypto.randomUUID()}`)
    const contents =
      `ADDRESS=${input.address}\n` +
      `PROJECTNAME=${input.projectName}\n` +
      `JAVA_OPTS=${fileAuthJvmOption}\n`
    try {
      await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, environmentPath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
    context.log(`Environment written: ${environmentPath}`)

    return backupPath
  }

  private async ensureLaunchServerJvmCompatibility(
    installationPath: string,
    context: JobTaskContext,
  ) {
    const environmentPath = join(installationPath, '.env')
    const contents = await readFile(environmentPath, 'utf8')
    const lines = contents.replace(/\r\n/g, '\n').split('\n')
    const optionIndex = lines.findIndex((line) => line.startsWith('JAVA_OPTS='))
    if (
      optionIndex >= 0 &&
      lines[optionIndex]!.slice('JAVA_OPTS='.length).split(/\s+/).includes(fileAuthJvmOption)
    ) return

    if (optionIndex >= 0) {
      const current = lines[optionIndex]!.slice('JAVA_OPTS='.length).trim()
      lines[optionIndex] = `JAVA_OPTS=${current ? `${current} ` : ''}${fileAuthJvmOption}`
    } else {
      const insertionIndex = lines.at(-1) === '' ? lines.length - 1 : lines.length
      lines.splice(insertionIndex, 0, `JAVA_OPTS=${fileAuthJvmOption}`)
    }

    const backupPath = join(
      installationPath,
      `.env.backup-${safeTimestamp()}`,
    )
    await copyFile(environmentPath, backupPath)
    const temporaryPath = join(
      installationPath,
      `.env.pending-${crypto.randomUUID()}`,
    )
    try {
      await writeFile(temporaryPath, `${lines.join('\n').replace(/\n*$/, '')}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporaryPath, environmentPath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
    context.log(`LaunchServer JVM compatibility snapshot created: ${backupPath}`)
    context.log('Enabled the source-required FileAuthSystem java.time access')
  }

  private async runChecked(
    command: string[],
    cwd: string,
    context: JobTaskContext,
    description: string,
  ) {
    context.log(description)
    const result = await this.commandRunner(command, cwd, context.signal, context.log)
    if (result.exitCode !== 0) {
      throw new Error(`${description} failed with exit code ${result.exitCode}`)
    }
    return result
  }
}
