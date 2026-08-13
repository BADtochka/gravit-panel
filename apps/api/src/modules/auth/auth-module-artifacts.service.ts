import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuthModuleArtifactsCleanupResult } from '@gravit-panel/shared'
import { discordAuthSystemJarName } from '../modules/module-catalog'

export class AuthModuleArtifactsService {
  constructor(private readonly directory: string) {}

  async cleanup(): Promise<AuthModuleArtifactsCleanupResult> {
    const removedFiles: string[] = []
    let removedBytes = 0
    const entries = await readdir(this.directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })

    for (const entry of entries) {
      if (!entry.isFile() || !this.isAuthArtifact(entry.name)) continue
      const path = join(this.directory, entry.name)
      const metadata = await lstat(path)
      if (!metadata.isFile()) continue
      await rm(path)
      removedFiles.push(entry.name)
      removedBytes += metadata.size
    }

    return { removedFiles, removedBytes }
  }

  private isAuthArtifact(name: string) {
    return name === discordAuthSystemJarName || name.startsWith(`${discordAuthSystemJarName}.pending-`)
  }
}
