import type {
  FileAuthModuleConfig,
  FileAuthModuleConfigApplyInput,
  GravitInstallation,
} from '@gravit-panel/shared'
import { join } from 'node:path'
import { ContainerVolumeService } from '../docker/container-volume.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { fileAuthRecipeSource } from './auth-recipes'

interface AuthVolumeOperations {
  readFile(installation: GravitInstallation, relativePath: string): Promise<string>
  writeFileAtomic(
    installation: GravitInstallation,
    relativePath: string,
    bytes: Uint8Array,
    mode?: '0600' | '0644' | '0755',
  ): Promise<void>
  copy(installation: GravitInstallation, source: string, target: string): Promise<void>
  exists(installation: GravitInstallation, relativePath: string, kind?: 'file' | 'directory'): Promise<boolean>
}

const configPath = 'config/FileAuthSystem/Config.json'
const safeTimestamp = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')

export class AuthModuleConfigService {
  constructor(private readonly volume: AuthVolumeOperations = new ContainerVolumeService()) {}

  async getFileAuthConfig(installation: GravitInstallation): Promise<FileAuthModuleConfig> {
    if (!(await this.volume.exists(installation, configPath))) {
      return { autoSave: true }
    }
    try {
      const parsed = JSON.parse(await this.volume.readFile(installation, configPath)) as {
        autoSave?: unknown
      }
      return { autoSave: parsed.autoSave !== false }
    } catch (error) {
      throw new Error(
        `Unable to read FileAuthSystem module config: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
  }

  async applyFileAuthConfig(
    installation: GravitInstallation,
    input: FileAuthModuleConfigApplyInput,
    context: JobTaskContext,
  ) {
    const backupRelativePath = `${configPath}.backup-${safeTimestamp()}`
    let configBackupPath: string | null = null
    if (await this.volume.exists(installation, configPath)) {
      await this.volume.copy(installation, configPath, backupRelativePath)
      configBackupPath = join(installation.path, 'launcher', backupRelativePath)
      context.log(`FileAuthSystem config snapshot created: ${configBackupPath}`)
    }

    const next = { autoSave: input.autoSave }
    context.progress(60, 'Writing FileAuthSystem module configuration')
    await this.volume.writeFileAtomic(
      installation,
      configPath,
      new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
      '0644',
    )
    context.progress(95, `FileAuthSystem autoSave=${input.autoSave}`)
    return {
      installationId: installation.id,
      config: next,
      configBackupPath,
      source: fileAuthRecipeSource,
    }
  }
}
