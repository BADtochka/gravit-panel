import { expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
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

    const workspace = join(root, 'server-packs', 'main', 'bindings', bindingId, 'workspace', 'mods')
    expect((await service.removeMod(installation, bindingId, {
      projectId: 'first-id', slug: 'first', filename: 'first.jar',
    }, false)).removed).toEqual(['mods/first.jar'])
    await access(join(workspace, 'shared.jar'))
    await access(join(workspace, 'second.jar'))

    expect((await service.removeMod(installation, bindingId, {
      projectId: 'second-id', slug: 'second', filename: 'second.jar',
    }, true)).removed.sort()).toEqual(['mods/second.jar', 'mods/shared.jar'])
    await expect(access(join(workspace, 'shared.jar'))).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reads and writes UTF-8 text files in a binding workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gravit-server-pack-editor-'))
  const installation = {
    id: crypto.randomUUID(), name: 'default', path: root, address: 'localhost', projectName: 'TEST',
    sourceRepository: 'repository', sourceRevision: 'revision', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } satisfies GravitInstallation
  const bindingId = crypto.randomUUID()
  const service = new ServerPackService(
    { archivePath: () => null, list: () => [] } as never,
    { get: () => ({ id: bindingId, installationId: installation.id, profileName: 'main', packVersionId: null }) } as never,
    {} as never,
    {} as never,
  )

  try {
    await service.putTextFile(installation, bindingId, 'config/server.properties', 'motd=Hello\n')
    expect(await service.readTextFile(installation, bindingId, 'config/server.properties')).toMatchObject({ content: 'motd=Hello\n', size: 11 })
    await service.putTextFile(installation, bindingId, 'config/empty.txt', '')
    expect((await service.readTextFile(installation, bindingId, 'config/empty.txt')).content).toBe('')
    await service.putFile(installation, bindingId, 'mods/binary.jar', new Uint8Array([1, 0, 2]))
    await expect(service.readTextFile(installation, bindingId, 'mods/binary.jar')).rejects.toThrow('Binary files')

    await service.createDirectory(installation, bindingId, 'config/plugins')
    await service.createTextFile(installation, bindingId, 'config/plugins/example.toml', 'enabled=true\n')
    expect((await service.listEntries(installation, bindingId)).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'config/plugins', type: 'directory', size: null }),
      expect.objectContaining({ path: 'config/plugins/example.toml', type: 'file' }),
    ]))
    await service.moveEntry(
      installation,
      bindingId,
      'config/plugins/example.toml',
      'config/example.toml',
    )
    expect((await service.readTextFile(installation, bindingId, 'config/example.toml')).content).toBe('enabled=true\n')
    await expect(service.createDirectory(installation, bindingId, 'config')).rejects.toThrow('Destination already exists')
    await service.removeEntries(installation, bindingId, ['config/plugins', 'config/example.toml'])
    await expect(access(join(root, 'server-packs', 'main', 'bindings', bindingId, 'workspace', 'config', 'plugins'))).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
