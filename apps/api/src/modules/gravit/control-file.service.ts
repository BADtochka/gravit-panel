import type {
  GravitInstallation,
  LaunchServerCommandResult,
  LaunchServerInspectionCommand,
} from '@gravit-panel/shared'

export const launchServerCommandSource = {
  repository: 'https://github.com/GravitLauncher/Launcher',
  revision: 'fef9bae63da1afc0518d32e3333db20f409ab196',
  file: 'components/launchserver/src/main/java/pro/gravit/launchserver/socket/SocketCommandServer.java',
} as const

const controlSocketPath = '/app/data/control-file'
const maximumOutputBytes = 1024 * 1024
export type RemoteControlSetupCommand =
  | 'modules list'
  | 'modules available'
  | 'modules load RemoteControl'
  | 'remotecontrol reload'
export type ModuleControlCommand =
  | 'modules available'
  | 'modules list'
  | `modules load ${string}`
  | `modules launcher-load ${string}`
export type BuildControlCommand = 'build'
export type AuthControlCommand =
  | 'fileauthsystem install'
  | `fileauthsystem install ${string}`
  | `config auth.${string}.core register ${string} ${string} ${string}`
  | `config auth.${string}.core changePassword ${string} ${string}`
  | `config auth.${string}.core getuserbyusername ${string}`
  | `config auth.${string}.core reload`
  | `config auth.${string}.core save`
export type ClientControlCommand =
  | `applyworkspace ${string}`
  | 'mirrorhelper setDisableDownloadAssets true'
  | `downloadinstaller ${'FORGE' | 'NEOFORGE'} ${string}`
  | `installClient ${string} ${string} ${string}`
  | `installClient ${string} ${string} ${string} ${string}`
  | `installMods ${string} ${string} ${string} ${string}`

const stripAnsi = (value: string) =>
  value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    '',
  )

export class ControlFileBusyError extends Error {}

interface ControlCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type ControlCommandRunner = (
  command: string[],
  cwd: string,
  input: string,
  timeoutMs: number,
) => Promise<ControlCommandResult>

const readOutput = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  let receivedBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    receivedBytes += value.byteLength
    if (receivedBytes > maximumOutputBytes) {
      await reader.cancel()
      throw new Error('LaunchServer command output exceeded the 1 MiB safety limit')
    }
    output += decoder.decode(value, { stream: true })
  }

  return output + decoder.decode()
}

const runControlCommand: ControlCommandRunner = async (command, cwd, input, timeoutMs) => {
  const process = Bun.spawn(command, {
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    process.kill()
  }, timeoutMs)

  try {
    process.stdin.write(input)
    process.stdin.end()
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      readOutput(process.stdout),
      readOutput(process.stderr),
    ])
    if (timedOut) {
      throw new Error(
        command.includes('socat')
          ? `LaunchServer control socket stayed busy or the command stalled for ${timeoutMs}ms`
          : `LaunchServer command timed out after ${timeoutMs}ms`,
      )
    }
    return { exitCode, stdout, stderr }
  } catch (error) {
    process.kill()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

const socketProbeCommand = [
  'docker',
  'compose',
  'exec',
  '-T',
  'gravitlauncher',
  'test',
  '-S',
  controlSocketPath,
]

// LaunchServer closes the socket only after evalNative finishes. Keep socat
// reading after our one-line stdin reaches EOF so long commands stay attached.
const socketCommand = [
  'docker',
  'compose',
  'exec',
  '-T',
  '-w',
  '/app',
  'gravitlauncher',
  'socat',
  `UNIX-CONNECT:${controlSocketPath}`,
  'STDIO,ignoreeof',
]

const isTransientSocketFailure = (message: string) =>
  /ENOENT|no such file or directory|connection refused/i.test(message)

const assertCommandSucceeded = (command: string, lines: string[]) => {
  const failure = lines.find((line) => /error when execute command/i.test(line))
  if (failure) {
    throw new Error(`LaunchServer rejected command "${command}": ${failure}`)
  }
  return lines
}

export class ControlFileService {
  private readonly activeInstallations = new Set<string>()

  constructor(
    private readonly readinessTimeoutMs = 30_000,
    private readonly commandTimeoutMs = 60_000,
    private readonly commandRunner: ControlCommandRunner = runControlCommand,
    private readonly longCommandTimeoutMs = 30 * 60_000,
  ) {}

  async execute(
    installation: GravitInstallation,
    command: LaunchServerInspectionCommand,
  ): Promise<LaunchServerCommandResult> {
    const startedAt = new Date().toISOString()
    const lines = await this.executeCommand(installation, command)

    return {
      installationId: installation.id,
      command,
      transport: 'control-file',
      lines,
      startedAt,
      finishedAt: new Date().toISOString(),
      source: launchServerCommandSource,
    }
  }

  executeSetupCommand(installation: GravitInstallation, command: RemoteControlSetupCommand) {
    return this.executeCommand(installation, command)
  }

  executeModuleCommand(installation: GravitInstallation, command: ModuleControlCommand) {
    return this.executeCommand(installation, command)
  }

  executeBuildCommand(installation: GravitInstallation, command: BuildControlCommand) {
    return this.executeCommand(installation, command, this.longCommandTimeoutMs)
  }

  executeAuthCommand(installation: GravitInstallation, command: AuthControlCommand) {
    return this.executeCommand(installation, command)
  }

  executeClientCommand(installation: GravitInstallation, command: ClientControlCommand) {
    return this.executeCommand(installation, command, this.longCommandTimeoutMs)
  }

  private async executeCommand(
    installation: GravitInstallation,
    command: string,
    commandTimeoutMs = this.commandTimeoutMs,
  ) {
    if (this.activeInstallations.has(installation.id)) {
      throw new ControlFileBusyError('Another LaunchServer command is already running')
    }

    this.activeInstallations.add(installation.id)
    try {
      return await this.sendWhenReady(installation.path, command, commandTimeoutMs)
    } finally {
      this.activeInstallations.delete(installation.id)
    }
  }

  private async sendWhenReady(
    installationPath: string,
    command: string,
    commandTimeoutMs: number,
  ) {
    const deadline = Date.now() + this.readinessTimeoutMs

    while (Date.now() <= deadline) {
      const probe = await this.commandRunner(
        socketProbeCommand,
        installationPath,
        '',
        this.commandTimeoutMs,
      )
      if (probe.exitCode === 0) {
        const result = await this.commandRunner(
          socketCommand,
          installationPath,
          `${command}\n`,
          commandTimeoutMs,
        )
        if (result.exitCode === 0) {
          return assertCommandSucceeded(command, this.parseLines(result.stdout))
        }

        const details = stripAnsi(result.stderr || result.stdout).trim()
        if (!isTransientSocketFailure(details)) {
          throw new Error(details || `LaunchServer control command exited with code ${result.exitCode}`)
        }
      } else if (probe.stderr.trim()) {
        throw new Error(stripAnsi(probe.stderr).trim())
      }
      await Bun.sleep(250)
    }

    throw new Error(
      `LaunchServer control socket did not become ready within ${this.readinessTimeoutMs}ms`,
    )
  }

  private parseLines(output: string) {
    return stripAnsi(output)
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
  }
}
