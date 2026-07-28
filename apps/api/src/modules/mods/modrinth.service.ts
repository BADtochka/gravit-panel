import type { ModrinthProject } from '@gravit-panel/shared'

export const modrinthSource = {
  repository: 'https://github.com/modrinth/code',
  revision: '366f528853dc32701e9670fd8d9c51fa3d136441',
  apiVersion: 'v2.7.0',
  file: 'apps/labrinth',
  api: 'https://api.modrinth.com/v2',
} as const

interface SearchResponse {
  hits: Array<{
    project_id: string
    slug: string
    title: string
    description: string
    author: string
    icon_url: string | null
    downloads: number
    versions: string[]
    categories: string[]
    server_side?: 'required' | 'optional' | 'unsupported' | 'unknown'
  }>
}

export interface ModrinthVersion {
  id: string
  project_id: string
  name: string
  version_number: string
  loaders: string[]
  game_versions: string[]
  files: Array<{
    hashes: { sha1: string; sha512: string }
    url: string
    filename: string
    primary: boolean
    size: number
  }>
  dependencies?: Array<{
    project_id: string | null
    version_id: string | null
    dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded'
  }>
}

interface ModrinthProjectDetail {
  id: string
  slug: string
  server_side: 'required' | 'optional' | 'unsupported' | 'unknown'
}

const requestHeaders = {
  Accept: 'application/json',
  'User-Agent': 'GravitPanel/0.1 (https://github.com/GravitLauncher)',
}

export class ModrinthService {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async search(query: string, minecraftVersion: string, loader: string) {
    const facets = [
      ['project_type:mod'],
      [`versions:${minecraftVersion}`],
      [`categories:${loader.toLowerCase()}`],
    ]
    const url = new URL(`${modrinthSource.api}/search`)
    url.searchParams.set('query', query)
    url.searchParams.set('facets', JSON.stringify(facets))
    url.searchParams.set('index', 'downloads')
    url.searchParams.set('limit', '30')
    const response = await this.fetcher(url, { headers: requestHeaders })
    if (!response.ok) throw new Error(`Modrinth search failed with HTTP ${response.status}`)
    const payload = (await response.json()) as SearchResponse
    return {
      items: payload.hits.map(
        (item): ModrinthProject => ({
          projectId: item.project_id,
          slug: item.slug,
          title: item.title,
          description: item.description,
          author: item.author,
          iconUrl: item.icon_url,
          downloads: item.downloads,
          versions: item.versions,
          loaders: item.categories,
          serverSide: item.server_side,
        }),
      ),
      source: modrinthSource,
    }
  }

  async searchServer(query: string, minecraftVersion: string, loader: string) {
    const result = await this.search(query, minecraftVersion, loader)
    return {
      ...result,
      items: result.items.filter((item) => item.serverSide !== 'unsupported'),
    }
  }

  async assertInstallable(slugs: string[], minecraftVersion: string, loader: string) {
    const projects: Array<{ slug: string; projectId: string }> = []
    for (const slug of slugs) {
      const url = new URL(`${modrinthSource.api}/project/${encodeURIComponent(slug)}/version`)
      url.searchParams.set('loaders', JSON.stringify([loader.toLowerCase()]))
      url.searchParams.set('game_versions', JSON.stringify([minecraftVersion]))
      const response = await this.fetcher(url, { headers: requestHeaders })
      if (!response.ok) {
        throw new Error(`${slug} is not available from the pinned Modrinth v2 API`)
      }
      const versions = (await response.json()) as ModrinthVersion[]
      if (!versions.length) {
        throw new Error(`${slug} has no compatible ${minecraftVersion}/${loader} version`)
      }
      projects.push({ slug, projectId: versions[0]!.project_id })
    }
    return projects
  }

  async resolveServerInstall(slug: string, minecraftVersion: string, loader: string) {
    const resolved: Array<{
      projectId: string
      slug: string
      version: ModrinthVersion
      file: ModrinthVersion['files'][number]
    }> = []
    const visited = new Set<string>()
    const visit = async (projectRef: string) => {
      if (visited.has(projectRef)) return
      if (visited.size >= 64) throw new Error('Modrinth dependency graph exceeds 64 projects')
      visited.add(projectRef)
      const projectResponse = await this.fetcher(
        `${modrinthSource.api}/project/${encodeURIComponent(projectRef)}`,
        { headers: requestHeaders },
      )
      if (!projectResponse.ok) {
        throw new Error(`${projectRef} is not available from the pinned Modrinth API`)
      }
      const project = (await projectResponse.json()) as ModrinthProjectDetail
      if (project.server_side === 'unsupported') {
        throw new Error(`${project.slug} is marked as unsupported on dedicated servers`)
      }
      const versionsUrl = new URL(
        `${modrinthSource.api}/project/${encodeURIComponent(project.id)}/version`,
      )
      versionsUrl.searchParams.set('loaders', JSON.stringify([loader.toLowerCase()]))
      versionsUrl.searchParams.set('game_versions', JSON.stringify([minecraftVersion]))
      const versionsResponse = await this.fetcher(versionsUrl, { headers: requestHeaders })
      if (!versionsResponse.ok) {
        throw new Error(`Failed to resolve a server version for ${project.slug}`)
      }
      const versions = (await versionsResponse.json()) as ModrinthVersion[]
      const version = versions[0]
      if (!version) {
        throw new Error(`${project.slug} has no compatible ${minecraftVersion}/${loader} version`)
      }
      for (const dependency of version.dependencies ?? []) {
        if (dependency.dependency_type !== 'required') continue
        if (dependency.project_id) {
          await visit(dependency.project_id)
          continue
        }
        if (!dependency.version_id) continue
        const dependencyResponse = await this.fetcher(
          `${modrinthSource.api}/version/${encodeURIComponent(dependency.version_id)}`,
          { headers: requestHeaders },
        )
        if (!dependencyResponse.ok) {
          throw new Error(`Failed to resolve required Modrinth dependency ${dependency.version_id}`)
        }
        const dependencyVersion = (await dependencyResponse.json()) as ModrinthVersion
        await visit(dependencyVersion.project_id)
      }
      const file = version.files.find((item) => item.primary) ?? version.files[0]
      if (!file) throw new Error(`${project.slug} version does not contain a downloadable file`)
      resolved.push({ projectId: project.id, slug: project.slug, version, file })
    }
    await visit(slug)
    return resolved
  }

  async versionsFromHashes(hashes: string[]) {
    if (!hashes.length) return {} as Record<string, ModrinthVersion>
    const response = await this.fetcher(`${modrinthSource.api}/version_files`, {
      method: 'POST',
      headers: { ...requestHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes, algorithm: 'sha1' }),
    })
    if (!response.ok) throw new Error(`Modrinth hash lookup failed with HTTP ${response.status}`)
    return (await response.json()) as Record<string, ModrinthVersion>
  }

  async latestFromHash(hash: string, minecraftVersion: string, loader: string) {
    const url = new URL(
      `${modrinthSource.api}/version_file/${encodeURIComponent(hash)}/update`,
    )
    url.searchParams.set('algorithm', 'sha1')
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: { ...requestHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loaders: [loader.toLowerCase()],
        game_versions: [minecraftVersion],
      }),
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Modrinth update lookup failed with HTTP ${response.status}`)
    return (await response.json()) as ModrinthVersion
  }

  async download(file: ModrinthVersion['files'][number]) {
    if (!file.url.startsWith('https://cdn.modrinth.com/')) {
      throw new Error('Modrinth returned a non-CDN artifact URL')
    }
    if (file.size > 200 * 1024 * 1024) throw new Error('Mod artifact exceeds 200 MiB')
    const response = await this.fetcher(file.url, { headers: requestHeaders })
    if (!response.ok) throw new Error(`Mod download failed with HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > 200 * 1024 * 1024) throw new Error('Mod artifact exceeds 200 MiB')
    const digest = new Bun.CryptoHasher('sha512').update(bytes).digest('hex')
    if (digest !== file.hashes.sha512) throw new Error('Modrinth artifact checksum mismatch')
    return bytes
  }
}
