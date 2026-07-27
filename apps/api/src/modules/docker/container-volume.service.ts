import type { GravitInstallation } from '@gravit-panel/shared'
import { posix } from 'node:path'

interface ContainerCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type ContainerCommandRunner = (
  installationPath: string,
  command: string[],
  input?: Uint8Array,
) => Promise<ContainerCommandResult>

const maximumDiagnosticBytes = 64 * 1024

const readDiagnostic = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maximumDiagnosticBytes) {
      await reader.cancel()
      throw new Error('Container command diagnostics exceeded 64 KiB')
    }
    output += decoder.decode(value, { stream: true })
  }
  return output + decoder.decode()
}

const runContainerCommand: ContainerCommandRunner = async (
  installationPath,
  command,
  input,
) => {
  const process = Bun.spawn(
    ['docker', 'compose', 'exec', '-T', 'gravitlauncher', ...command],
    {
      cwd: installationPath,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const timeout = setTimeout(() => process.kill(), 60_000)
  try {
    if (input) process.stdin.write(input)
    process.stdin.end()
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      readDiagnostic(process.stdout),
      readDiagnostic(process.stderr),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timeout)
  }
}

export interface VolumeFileOperations {
  exists(installation: GravitInstallation, relativePath: string, kind?: 'file' | 'directory'): Promise<boolean>
  readFile?(installation: GravitInstallation, relativePath: string): Promise<string>
  listFiles?(installation: GravitInstallation, relativeDirectory: string): Promise<string[]>
  ensureDirectory(installation: GravitInstallation, relativePath: string): Promise<void>
  writeFileAtomic(
    installation: GravitInstallation,
    relativePath: string,
    bytes: Uint8Array,
    mode?: '0600' | '0644' | '0755',
  ): Promise<void>
  copy(installation: GravitInstallation, source: string, target: string): Promise<void>
  move(installation: GravitInstallation, source: string, target: string): Promise<void>
  remove(
    installation: GravitInstallation,
    relativePath: string,
    recursive?: boolean,
  ): Promise<void>
  sha256?(
    installation: GravitInstallation,
    relativePath: string,
  ): Promise<string | null>
}

export class ContainerVolumeService implements VolumeFileOperations {
  constructor(private readonly runner: ContainerCommandRunner = runContainerCommand) {}

  async exists(
    installation: GravitInstallation,
    relativePath: string,
    kind: 'file' | 'directory' = 'file',
  ) {
    const path = this.absolute(relativePath)
    const result = await this.runner(installation.path, [
      'test',
      kind === 'directory' ? '-d' : '-f',
      path,
    ])
    if (result.exitCode === 0) return true
    if (result.exitCode === 1 && !result.stderr.trim()) return false
    throw this.commandError('inspect volume path', result)
  }

  async readFile(installation: GravitInstallation, relativePath: string) {
    const result = await this.runner(installation.path, ['cat', '--', this.absolute(relativePath)])
    if (result.exitCode !== 0) throw this.commandError('read volume file', result)
    return result.stdout
  }

  async listFiles(installation: GravitInstallation, relativeDirectory: string) {
    if (!(await this.exists(installation, relativeDirectory, 'directory'))) return []
    const result = await this.runner(installation.path, [
      'find',
      this.absolute(relativeDirectory),
      '-maxdepth',
      '1',
      '-type',
      'f',
    ])
    if (result.exitCode !== 0) throw this.commandError('list volume directory', result)
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((path) => posix.basename(path))
      .sort((left, right) => left.localeCompare(right))
  }

  async sha256(installation: GravitInstallation, relativePath: string) {
    const path = this.absolute(relativePath)
    const result = await this.runner(installation.path, ['sha256sum', '--', path])
    if (result.exitCode === 1 && !result.stderr.trim()) return null
    if (result.exitCode !== 0) throw this.commandError('hash volume file', result)
    const digest = result.stdout.trim().split(/\s+/, 1)[0]
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error('Container returned an invalid SHA-256 digest')
    }
    return digest
  }

  async ensureDirectory(installation: GravitInstallation, relativePath: string) {
    await this.checked(installation, ['mkdir', '-p', '--', this.absolute(relativePath)], 'create directory')
  }

  async writeFileAtomic(
    installation: GravitInstallation,
    relativePath: string,
    bytes: Uint8Array,
    mode: '0600' | '0644' | '0755' = '0644',
  ) {
    const path = this.absolute(relativePath)
    const pending = `${path}.pending-${crypto.randomUUID()}`
    await this.ensureParentDirectory(installation, relativePath)
    try {
      await this.checked(
        installation,
        ['sh', '-c', 'umask "$1"; cat > "$2"', 'gravit-panel', mode === '0755' ? '022' : mode === '0644' ? '022' : '077', pending],
        'write pending volume file',
        bytes,
      )
      await this.checked(installation, ['chmod', mode, '--', pending], 'set volume file mode')
      await this.checked(installation, ['mv', '-f', '--', pending, path], 'publish volume file')
    } catch (error) {
      await this.runner(installation.path, ['rm', '-f', '--', pending])
      throw error
    }
  }

  async copy(installation: GravitInstallation, source: string, target: string) {
    await this.ensureParentDirectory(installation, target)
    await this.checked(
      installation,
      ['cp', '-a', '--', this.absolute(source), this.absolute(target)],
      'copy volume path',
    )
  }

  async move(installation: GravitInstallation, source: string, target: string) {
    await this.ensureParentDirectory(installation, target)
    await this.checked(
      installation,
      ['mv', '--', this.absolute(source), this.absolute(target)],
      'move volume path',
    )
  }

  async remove(
    installation: GravitInstallation,
    relativePath: string,
    recursive = false,
  ) {
    await this.checked(
      installation,
      ['rm', recursive ? '-rf' : '-f', '--', this.absolute(relativePath)],
      'remove volume path',
    )
  }

  async extractZipToNewDirectory(
    installation: GravitInstallation,
    archiveRelativePath: string,
    targetRelativePath: string,
  ) {
    const archive = this.absolute(archiveRelativePath)
    const target = this.absolute(targetRelativePath)
    if (
      await this.exists(installation, targetRelativePath, 'directory') ||
      await this.exists(installation, targetRelativePath, 'file')
    ) {
      throw new Error(`Refusing to replace existing volume path: ${targetRelativePath}`)
    }

    const listing = await this.runner(installation.path, ['unzip', '-Z1', archive])
    if (listing.exitCode !== 0) throw this.commandError('inspect runtime archive', listing)
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
    if (!entries.length) throw new Error('Runtime archive is empty')
    for (const entry of entries) {
      const normalized = posix.normalize(entry)
      if (
        entry.includes('\0') ||
        posix.isAbsolute(entry) ||
        normalized === '..' ||
        normalized.startsWith('../')
      ) {
        throw new Error(`Runtime archive contains an unsafe path: ${entry}`)
      }
    }

    const pendingRelativePath = `${this.relative(targetRelativePath)}.pending-${crypto.randomUUID()}`
    const pending = this.absolute(pendingRelativePath)
    await this.ensureDirectory(installation, pendingRelativePath)
    try {
      await this.checked(
        installation,
        ['unzip', '-q', archive, '-d', pending],
        'extract runtime archive',
      )
      await this.checked(
        installation,
        ['mv', '--', pending, target],
        'publish runtime directory',
      )
    } catch (error) {
      await this.remove(installation, pendingRelativePath, true)
      throw error
    }
  }

  private async checked(
    installation: GravitInstallation,
    command: string[],
    action: string,
    input?: Uint8Array,
  ) {
    const result = await this.runner(installation.path, command, input)
    if (result.exitCode !== 0) throw this.commandError(action, result)
  }

  private commandError(action: string, result: ContainerCommandResult) {
    const details = (result.stderr || result.stdout).trim()
    return new Error(
      details
        ? `Unable to ${action}: ${details}`
        : `Unable to ${action}: container command exited with code ${result.exitCode}`,
    )
  }

  private async ensureParentDirectory(
    installation: GravitInstallation,
    relativePath: string,
  ) {
    const parent = posix.dirname(this.relative(relativePath))
    if (parent !== '.') await this.ensureDirectory(installation, parent)
  }

  private relative(path: string) {
    if (!path || path.includes('\0') || posix.isAbsolute(path)) {
      throw new Error('Volume path must be a non-empty relative path')
    }
    const normalized = posix.normalize(path)
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      throw new Error('Volume path escapes /app/data')
    }
    return normalized
  }

  private absolute(path: string) {
    return posix.join('/app/data', this.relative(path))
  }
}
