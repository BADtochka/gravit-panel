import { expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModrinthService } from '../mods/modrinth.service'
import { ServerPackService } from './server-pack.service'

test('deduplicates shared dependencies during bulk server mod installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gravit-server-pack-mods-'))
  const installation: GravitInstallation = {
    id: crypto.randomUUID(),
    name: 'default',
    path: root,
    address: 'localhost',
    projectName: 'TEST',
    sourceRepository: 'repository',
    sourceRevision: 'revision',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const bindingId = crypto.randomUUID()
  const downloads: string[] = []
  const artifact = (slug: string, digest: string) => ({
    projectId: `${slug}-id`,
    slug,
    title: slug,
    root: slug !== 'shared',
    version: { id: `${slug}-version` },
    file: {
      filename: `${slug}.jar`,
      size: slug.length,
      hashes: { sha1: digest, sha512: digest },
    },
  })
  const shared = artifact('shared', 'shared-digest')
  const service = new ServerPackService(
    { archivePath: () => null } as never,
    {
      get: () => ({
        id: bindingId,
        installationId: installation.id,
        profileName: 'main',
        packVersionId: null,
      }),
    } as never,
    { getProfile: async () => ({ minecraftVersion: '1.21.1', loader: 'NEOFORGE' }) } as never,
    {
      resolveServerInstall: async (slug: string) => [shared, artifact(slug, `${slug}-digest`)],
      download: async (file: { filename: string }) => {
        downloads.push(file.filename)
        return new TextEncoder().encode(file.filename)
      },
    } as unknown as ModrinthService,
  )

  try {
    const result = await service.installMods(
      installation,
      bindingId,
      ['first', 'second'],
    )

    expect(downloads).toEqual(['shared.jar', 'first.jar', 'second.jar'])
    expect(result.installed).toHaveLength(3)
    expect(await readFile(join(
      root,
      'server-packs',
      'main',
      'bindings',
      bindingId,
      'workspace',
      'mods',
      'shared.jar',
    ), 'utf8')).toBe('shared.jar')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
