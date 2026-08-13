import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthModuleArtifactsService } from './auth-module-artifacts.service'

test('removes auth build artifacts without touching unrelated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gravit-auth-artifacts-'))
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'DiscordAuthSystem_module.jar'), 'current')
    await writeFile(join(directory, 'DiscordAuthSystem_module.jar.pending-test'), 'pending')
    await writeFile(join(directory, 'other-module.jar'), 'keep')

    const result = await new AuthModuleArtifactsService(directory).cleanup()

    expect(result.removedFiles.sort()).toEqual([
      'DiscordAuthSystem_module.jar',
      'DiscordAuthSystem_module.jar.pending-test',
    ])
    expect(result.removedBytes).toBe(14)
    expect(await readFile(join(directory, 'other-module.jar'), 'utf8')).toBe('keep')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
