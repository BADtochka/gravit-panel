import { describe, expect, test } from 'bun:test'
import { ModrinthService } from './modrinth.service'

describe('ModrinthService', () => {
  test('searches only compatible Modrinth mod projects', async () => {
    let requestedUrl = ''
    const fetcher = (async (input: RequestInfo | URL) => {
      requestedUrl = input.toString()
      return Response.json({
        hits: [
          {
            project_id: 'AABBCCDD',
            slug: 'sodium',
            title: 'Sodium',
            description: 'Renderer',
            author: 'jellysquid3',
            icon_url: null,
            downloads: 10,
            versions: ['1.21.4'],
            categories: ['fabric'],
          },
        ],
      })
    }) as typeof fetch
    const service = new ModrinthService(fetcher)

    const result = await service.search('sodium', '1.21.4', 'FABRIC')

    const url = new URL(requestedUrl)
    expect(url.pathname).toBe('/v2/search')
    expect(url.searchParams.get('facets')).toContain('project_type:mod')
    expect(url.searchParams.get('facets')).toContain('versions:1.21.4')
    expect(result.items[0]?.slug).toBe('sodium')
  })

  test('verifies sha512 before returning a downloaded mod', async () => {
    const bytes = new TextEncoder().encode('verified-mod')
    const hash = new Bun.CryptoHasher('sha512').update(bytes).digest('hex')
    const service = new ModrinthService(
      (async () => new Response(bytes)) as unknown as typeof fetch,
    )

    const downloaded = await service.download({
      hashes: { sha1: '', sha512: hash },
      url: 'https://cdn.modrinth.com/data/test/mod.jar',
      filename: 'mod.jar',
      primary: true,
      size: bytes.byteLength,
    })

    expect(downloaded).toEqual(bytes)
  })
})
