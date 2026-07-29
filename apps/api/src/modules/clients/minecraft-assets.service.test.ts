import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { MinecraftAssetsService } from './minecraft-assets.service'

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('MinecraftAssetsService', () => {
  test('downloads verified asset objects and reuses them on the next build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gravit-assets-'))
    const objectBytes = new TextEncoder().encode('verified minecraft asset')
    const hash = createHash('sha1').update(objectBytes).digest('hex')
    const requests: string[] = []
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('version_manifest_v2.json')) {
        return jsonResponse({
          versions: [{
            id: '1.21.1',
            url: 'https://piston-meta.mojang.com/v1/packages/version/1.21.1.json',
          }],
        })
      }
      if (url.endsWith('/version/1.21.1.json')) {
        return jsonResponse({
          assetIndex: {
            id: '17',
            url: 'https://launcher.mojang.com/v1/packages/index/17.json',
          },
        })
      }
      if (url.endsWith('/index/17.json')) {
        return jsonResponse({
          objects: {
            'minecraft/sounds/test.ogg': {
              hash,
              size: objectBytes.byteLength,
            },
          },
        })
      }
      if (url === `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`) {
        return new Response(objectBytes, {
          status: 200,
          headers: { 'content-length': String(objectBytes.byteLength) },
        })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    const service = new MinecraftAssetsService(fetcher)
    const now = new Date().toISOString()
    const installation: GravitInstallation = {
      id: crypto.randomUUID(),
      name: 'default',
      path: root,
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      createdAt: now,
      updatedAt: now,
    }
    const logs: string[] = []
    const context: JobTaskContext = {
      signal: new AbortController().signal,
      log: (message) => logs.push(message),
      progress: () => {},
    }

    try {
      await service.ensureAssets(installation, '1.21.1', 'assets', '17', context)
      await service.ensureAssets(installation, '1.21.1', 'assets', '17', context)

      expect(
        new Uint8Array(
          await readFile(
            join(root, 'launcher', 'updates', 'assets', 'objects', hash.slice(0, 2), hash),
          ),
        ),
      ).toEqual(objectBytes)
      const writtenIndex = JSON.parse(
        await readFile(
          join(root, 'launcher', 'updates', 'assets', 'indexes', '17.json'),
          'utf8',
        ),
      )
      expect(writtenIndex.objects['minecraft/sounds/test.ogg']).toEqual({
        hash,
        size: objectBytes.byteLength,
      })
      expect(
        requests.filter((url) => url.includes('resources.download.minecraft.net')),
      ).toHaveLength(1)
      expect(logs.at(-1)).toContain('1 reused, 0 downloaded')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
