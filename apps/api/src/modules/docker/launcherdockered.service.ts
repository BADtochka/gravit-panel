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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
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
const launcherNginxConfig = 'nginx.conf'
const launchServerConfig = join('launcher', 'LaunchServer.json')
const forwardedProtoMap = `map $http_x_forwarded_proto $launcher_forwarded_proto {
    default $http_x_forwarded_proto;
    '' $scheme;
}
`
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
      await this.ensureForwardedProtoConfiguration(source.installationPath, context)
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

      if (await this.synchronizeLaunchServerPublicUrls(source.installationPath, context)) {
        await this.restartLaunchServerProject(source.installationPath, context)
      }

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
    const proxyUpdated = await this.ensureForwardedProtoConfiguration(installationPath, context)
    if (proxyUpdated) {
      await this.runChecked(
        ['docker', 'compose', 'restart', 'nginx'],
        installationPath,
        context,
        'Reloading nginx with the preserved forwarded HTTPS scheme',
      )
    }
    await this.synchronizeLaunchServerPublicUrls(installationPath, context)
    await this.restartLaunchServerProject(installationPath, context)
  }

  private async restartLaunchServerProject(
    installationPath: string,
    context: JobTaskContext,
  ): Promise<void> {
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

  private async ensureForwardedProtoConfiguration(
    installationPath: string,
    context: JobTaskContext,
  ) {
    const configPath = join(installationPath, launcherNginxConfig)
    if (!(await exists(configPath))) {
      context.log('LauncherDockered nginx.conf is absent; no proxy scheme migration was needed')
      return false
    }

    const contents = await readFile(configPath, 'utf8')
    if (contents.includes('$launcher_forwarded_proto')) return false
    if (!contents.includes('proxy_set_header X-Forwarded-Proto $scheme;')) {
      context.log('LauncherDockered nginx.conf has no known forwarded-proto pattern; preserving it')
      return false
    }

    const serverMarker = '\nserver {'
    const markerIndex = contents.indexOf(serverMarker)
    if (markerIndex === -1) {
      throw new Error('LauncherDockered nginx.conf has no top-level server block for the HTTPS scheme migration')
    }

    const updated =
      contents.slice(0, markerIndex) +
      `\n${forwardedProtoMap}` +
      contents.slice(markerIndex).replaceAll(
        'proxy_set_header X-Forwarded-Proto $scheme;',
        'proxy_set_header X-Forwarded-Proto $launcher_forwarded_proto;',
      )
    const backupPath = join(installationPath, `nginx.conf.backup-${safeTimestamp()}`)
    await copyFile(configPath, backupPath)
    const temporaryPath = join(installationPath, `.nginx.conf.pending-${crypto.randomUUID()}`)
    try {
      await writeFile(temporaryPath, updated, { encoding: 'utf8', flag: 'wx', mode: 0o644 })
      await rename(temporaryPath, configPath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
    context.log(`LaunchServer proxy HTTPS-scheme snapshot created: ${backupPath}`)
    context.log('Preserved the outer HTTPS scheme for LaunchServer WebSocket requests')
    return true
  }

  private async synchronizeLaunchServerPublicUrls(
    installationPath: string,
    context: JobTaskContext,
  ) {
    const configPath = join(installationPath, launchServerConfig)
    if (!(await exists(configPath))) {
      context.log('LaunchServer.json is not generated yet; public URL synchronization will run on the next restart')
      return false
    }

    const { address } = await this.readExistingEnvironment(installationPath)
    const publicAddress = new URL(`http://${address}`)
    const localAddress = new Set(['localhost', '127.0.0.1', '::1']).has(
      publicAddress.hostname.toLowerCase(),
    )
    const secure = !localAddress && (!publicAddress.port || publicAddress.port === '443')
    const httpProtocol = secure ? 'https:' : 'http:'
    const websocketProtocol = secure ? 'wss:' : 'ws:'
    const contents = await readFile(configPath, 'utf8')
    const parsed: unknown = JSON.parse(contents)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('LaunchServer.json must contain a JSON object to synchronize public URLs')
    }
    const config = parsed as Record<string, unknown>
    let changed = false

    // The LauncherDockered nginx facade uses the updates directory itself as
    // its document root. Public URLs must therefore be root-relative to that
    // directory. Strip a duplicated "/<updatesDir>/" prefix that LaunchServer
    // may have persisted, otherwise requests resolve to
    // "<updatesDir>/<updatesDir>/..." and every launcher artifact download
    // ends in a 404.
    let updatesDir = 'updates'
    const updatesProvider = config.updatesProvider
    if (updatesProvider && typeof updatesProvider === 'object' && !Array.isArray(updatesProvider)) {
      const configured = (updatesProvider as Record<string, unknown>).updatesDir
      if (
        typeof configured === 'string' &&
        /^[a-zA-Z0-9._-]+$/.test(configured) &&
        basename(configured) === configured
      ) {
        updatesDir = configured
      }
    }
    const updatesPrefix = `/${updatesDir}/`

    const rewriteUrl = (value: unknown, protocol: string, normalizeUpdatesPath: boolean) => {
      if (typeof value !== 'string') return value
      try {
        const url = new URL(value)
        url.protocol = protocol
        url.host = publicAddress.host
        if (normalizeUpdatesPath && url.pathname.startsWith(updatesPrefix)) {
          url.pathname = url.pathname.slice(updatesPrefix.length - 1)
        }
        const rewritten = url.toString()
        if (rewritten !== value) changed = true
        return rewritten
      } catch {
        return value
      }
    }

    if (updatesProvider && typeof updatesProvider === 'object' && !Array.isArray(updatesProvider)) {
      const provider = updatesProvider as Record<string, unknown>
      const urls = provider.urls
      if (urls && typeof urls === 'object' && !Array.isArray(urls)) {
        const values = urls as Record<string, unknown>
        for (const [key, value] of Object.entries(values)) {
          values[key] = rewriteUrl(value, httpProtocol, true)
        }
      }
    }

    const netty = config.netty
    if (netty && typeof netty === 'object' && !Array.isArray(netty)) {
      const values = netty as Record<string, unknown>
      values.downloadURL = rewriteUrl(values.downloadURL, httpProtocol, true)
      values.address = rewriteUrl(values.address, websocketProtocol, false)
    }

    if (!changed) return false

    const backupPath = join(installationPath, 'launcher', `LaunchServer.json.backup-address-${safeTimestamp()}`)
    await copyFile(configPath, backupPath)
    const temporaryPath = join(installationPath, 'launcher', `.LaunchServer.json.pending-${crypto.randomUUID()}`)
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporaryPath, configPath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
    context.log(`LaunchServer public URL snapshot created: ${backupPath}`)
    context.log(`Synchronized launcher download URLs and WebSocket address to ${publicAddress.host}`)
    return true
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
