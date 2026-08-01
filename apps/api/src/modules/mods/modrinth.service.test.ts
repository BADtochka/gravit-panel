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
            client_side: 'required',
            server_side: 'optional',
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
    expect(result.items[0]?.clientSide).toBe('required')
    expect(result.items[0]?.serverSide).toBe('optional')
  })

  test('searches compatible Modrinth modpack projects separately from mods', async () => {
    let requestedUrl = ''
    const service = new ModrinthService((async (input: RequestInfo | URL) => {
      requestedUrl = input.toString()
      return Response.json({ hits: [] })
    }) as typeof fetch)

    await service.searchModpacks('adventure', '1.21.1', 'NEOFORGE')

    const facets = new URL(requestedUrl).searchParams.get('facets') ?? ''
    expect(facets).toContain('project_type:modpack')
    expect(facets).toContain('categories:neoforge')
    expect(facets).toContain('versions:1.21.1')
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

  test('retries transient CDN failures before verifying the artifact', async () => {
    const bytes = new TextEncoder().encode('retried-mod')
    const hash = new Bun.CryptoHasher('sha512').update(bytes).digest('hex')
    let attempts = 0
    const service = new ModrinthService(
      (async () => {
        attempts += 1
        return attempts < 3 ? new Response(null, { status: 429 }) : new Response(bytes)
      }) as unknown as typeof fetch,
      async () => {},
    )

    const downloaded = await service.download({
      hashes: { sha1: '', sha512: hash },
      url: 'https://cdn.modrinth.com/data/test/mod.jar',
      filename: 'mod.jar',
      primary: true,
      size: bytes.byteLength,
    })

    expect(attempts).toBe(3)
    expect(downloaded).toEqual(bytes)
  })

  test('skips required dependencies that are unsupported on the install target', async () => {
    const projects = {
      'dynamic-trees': {
        id: 'dynamic-trees-id',
        slug: 'dynamic-trees',
        title: 'Dynamic Trees',
        client_side: 'required',
        server_side: 'required',
      },
      lithostitched: {
        id: 'lithostitched-id',
        slug: 'lithostitched',
        title: 'Lithostitched',
        client_side: 'unsupported',
        server_side: 'required',
      },
      terrablender: {
        id: 'terrablender-id',
        slug: 'terrablender',
        title: 'TerraBlender',
        client_side: 'required',
        server_side: 'required',
      },
    } as const
    const versions = {
      'dynamic-trees-id': {
        id: 'dynamic-trees-version',
        project_id: 'dynamic-trees-id',
        name: 'Dynamic Trees',
        version_number: '1.0.0',
        loaders: ['neoforge'],
        game_versions: ['1.21.1'],
        files: [{
          hashes: { sha1: 'dynamic', sha512: 'dynamic' },
          url: 'https://cdn.modrinth.com/data/dynamic-trees.jar',
          filename: 'dynamic-trees.jar',
          primary: true,
          size: 1,
        }],
        dependencies: [
          {
            project_id: 'lithostitched',
            version_id: null,
            dependency_type: 'required',
          },
          {
            project_id: 'terrablender',
            version_id: null,
            dependency_type: 'required',
          },
        ],
      },
      'terrablender-id': {
        id: 'terrablender-version',
        project_id: 'terrablender-id',
        name: 'TerraBlender',
        version_number: '1.0.0',
        loaders: ['neoforge'],
        game_versions: ['1.21.1'],
        files: [{
          hashes: { sha1: 'terra', sha512: 'terra' },
          url: 'https://cdn.modrinth.com/data/terrablender.jar',
          filename: 'terrablender.jar',
          primary: true,
          size: 1,
        }],
        dependencies: [],
      },
    } as const
    const service = new ModrinthService((async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const projectMatch = url.pathname.match(/^\/v2\/project\/([^/]+)$/)
      if (projectMatch) {
        const project = projects[
          decodeURIComponent(projectMatch[1]!) as keyof typeof projects
        ]
        return project ? Response.json(project) : new Response(null, { status: 404 })
      }
      const versionMatch = url.pathname.match(/^\/v2\/project\/([^/]+)\/version$/)
      if (versionMatch) {
        const version = versions[
          decodeURIComponent(versionMatch[1]!) as keyof typeof versions
        ]
        return Response.json(version ? [version] : [])
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch)

    const resolved = await service.resolveInstall(
      'dynamic-trees',
      '1.21.1',
      'NEOFORGE',
      'client',
    )

    expect(resolved.map((item) => item.slug)).toEqual([
      'terrablender',
      'dynamic-trees',
    ])
    expect(resolved.map((item) => item.root)).toEqual([false, true])
  })

  test('still rejects a directly selected project unsupported on the target', async () => {
    const service = new ModrinthService(
      (async () => Response.json({
        id: 'server-only-id',
        slug: 'server-only',
        title: 'Server only',
        client_side: 'unsupported',
        server_side: 'required',
      })) as unknown as typeof fetch,
    )

    await expect(
      service.resolveInstall('server-only', '1.21.1', 'NEOFORGE', 'client'),
    ).rejects.toThrow('server-only is marked as unsupported on the client')
  })
})
