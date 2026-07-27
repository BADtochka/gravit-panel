import { describe, expect, test } from 'bun:test'
import {
  MinecraftVersionsService,
  minecraftVersionManifestUrl,
} from './minecraft-versions.service'

describe('MinecraftVersionsService', () => {
  test('returns release versions newest first and caches the verified response', async () => {
    let requests = 0
    const now = new Date('2026-07-27T12:00:00.000Z')
    const service = new MinecraftVersionsService(
      async (input) => {
        requests += 1
        expect(input).toBe(minecraftVersionManifestUrl)
        return Response.json({
          latest: { release: '1.21.4', snapshot: '25w01a' },
          versions: [
            { id: '1.20.1', type: 'release', releaseTime: '2023-06-12T10:00:00.000Z' },
            { id: '25w01a', type: 'snapshot', releaseTime: '2025-01-01T10:00:00.000Z' },
            { id: '1.21.4', type: 'release', releaseTime: '2024-12-03T10:00:00.000Z' },
            { id: 'invalid', type: 'release', releaseTime: '2026-01-01T10:00:00.000Z' },
          ],
        })
      },
      () => now,
    )

    const first = await service.list()
    const second = await service.list()

    expect(first).toEqual({
      items: [
        { id: '1.21.4', releaseTime: '2024-12-03T10:00:00.000Z' },
        { id: '1.20.1', releaseTime: '2023-06-12T10:00:00.000Z' },
      ],
      latestRelease: '1.21.4',
      source: {
        manifestUrl: minecraftVersionManifestUrl,
        fetchedAt: now.toISOString(),
      },
    })
    expect(second).toBe(first)
    expect(requests).toBe(1)
  })

  test('rejects malformed or unsuccessful upstream responses', async () => {
    const unavailable = new MinecraftVersionsService(async () =>
      new Response('', { status: 503 }))
    const malformed = new MinecraftVersionsService(async () =>
      Response.json({ latest: { release: '1.21.4' }, versions: [] }))

    await expect(unavailable.list()).rejects.toThrow('status 503')
    await expect(malformed.list()).rejects.toThrow('valid release catalog')
  })
})
