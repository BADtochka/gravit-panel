import type {
  MinecraftLoader,
  ModrinthModpackInspection,
  ModrinthProject,
} from '@gravit-panel/shared'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

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
    client_side?: 'required' | 'optional' | 'unsupported' | 'unknown'
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
  title?: string
  description?: string
  client_side: 'required' | 'optional' | 'unsupported' | 'unknown'
  server_side: 'required' | 'optional' | 'unsupported' | 'unknown'
}

interface ModrinthPackIndex {
  formatVersion: number
  game: string
  versionId: string
  name: string
  summary?: string
  files: Array<{
    path: string
    hashes: { sha1: string; sha512: string }
    env?: {
      client?: 'required' | 'optional' | 'unsupported'
      server?: 'required' | 'optional' | 'unsupported'
    }
    downloads: string[]
    fileSize: number
  }>
  dependencies: Record<string, string>
}

export interface ResolvedModrinthPack {
  inspection: ModrinthModpackInspection
  files: ModrinthPackIndex['files']
  overrides: Array<{
    side: 'common' | 'client' | 'server'
    path: string
    bytes: Uint8Array
  }>
}

interface ParsedModrinthPack {
  index: ModrinthPackIndex
  overrides: ResolvedModrinthPack['overrides']
}

const requestHeaders = {
  Accept: 'application/json',
  'User-Agent': 'GravitPanel/0.1 (https://github.com/GravitLauncher)',
}

export class ModrinthService {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async search(query: string, minecraftVersion: string, loader: string) {
    return this.searchProjects(query, minecraftVersion, loader, 'mod')
  }

  async searchModpacks(query: string, minecraftVersion: string, loader: string) {
    return this.searchProjects(query, minecraftVersion, loader, 'modpack')
  }

  private async searchProjects(
    query: string,
    minecraftVersion: string,
    loader: string,
    projectType: 'mod' | 'modpack',
  ) {
    const facets = [
      [`project_type:${projectType}`],
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
          clientSide: item.client_side,
          serverSide: item.server_side,
        }),
      ),
      source: modrinthSource,
    }
  }

  async inspectModpack(
    projectId: string,
    minecraftVersion: string,
    loader: Exclude<MinecraftLoader, 'VANILLA'>,
  ) {
    const resolved = await this.resolveModpack(projectId, minecraftVersion, loader, false)
    return resolved.inspection
  }

  async resolveModpack(
    projectId: string,
    minecraftVersion: string,
    loader: Exclude<MinecraftLoader, 'VANILLA'>,
    includeOverrides = true,
  ): Promise<ResolvedModrinthPack> {
    const projectResponse = await this.fetcher(
      `${modrinthSource.api}/project/${encodeURIComponent(projectId)}`,
      { headers: requestHeaders },
    )
    if (!projectResponse.ok) throw new Error('Modrinth modpack project was not found')
    const project = (await projectResponse.json()) as ModrinthProjectDetail
    const versionsUrl = new URL(
      `${modrinthSource.api}/project/${encodeURIComponent(project.id)}/version`,
    )
    versionsUrl.searchParams.set('loaders', JSON.stringify([loader.toLowerCase()]))
    versionsUrl.searchParams.set('game_versions', JSON.stringify([minecraftVersion]))
    const versionsResponse = await this.fetcher(versionsUrl, { headers: requestHeaders })
    if (!versionsResponse.ok) {
      throw new Error(`Modrinth modpack versions failed with HTTP ${versionsResponse.status}`)
    }
    const version = ((await versionsResponse.json()) as ModrinthVersion[])[0]
    if (!version) {
      throw new Error(`The modpack has no ${minecraftVersion}/${loader} version`)
    }
    const packFile = version.files.find((file) => file.filename.endsWith('.mrpack'))
    if (!packFile) throw new Error('The selected Modrinth version has no .mrpack file')
    const archive = await this.download(packFile, 100 * 1024 * 1024)
    const parsed = await this.readModpackArchive(archive, includeOverrides)
    return this.describeModpack(parsed, minecraftVersion, loader, {
      projectId: project.id,
      slug: project.slug,
      name: parsed.index.name || project.title || project.slug,
      summary: parsed.index.summary ?? project.description ?? '',
      versionId: version.id,
      versionName: version.version_number,
    })
  }

  async inspectLocalModpack(
    archive: Uint8Array,
    minecraftVersion: string,
    loader: Exclude<MinecraftLoader, 'VANILLA'>,
  ) {
    const resolved = await this.resolveLocalModpack(
      archive,
      minecraftVersion,
      loader,
      false,
    )
    return resolved.inspection
  }

  async resolveLocalModpack(
    archive: Uint8Array,
    minecraftVersion: string,
    loader: Exclude<MinecraftLoader, 'VANILLA'>,
    includeOverrides = true,
  ) {
    if (!archive.length || archive.length > 100 * 1024 * 1024) {
      throw new Error('Local .mrpack must be between 1 byte and 100 MiB')
    }
    const parsed = await this.readModpackArchive(archive, includeOverrides)
    const digest = new Bun.CryptoHasher('sha256').update(archive).digest('hex')
    return this.describeModpack(parsed, minecraftVersion, loader, {
      projectId: `local-${digest.slice(0, 40)}`,
      slug: 'local-mrpack',
      name: parsed.index.name,
      summary: parsed.index.summary ?? '',
      versionId: parsed.index.versionId,
      versionName: parsed.index.versionId,
    })
  }

  private async describeModpack(
    parsed: ParsedModrinthPack,
    minecraftVersion: string,
    loader: Exclude<MinecraftLoader, 'VANILLA'>,
    metadata: {
      projectId: string
      slug: string
      name: string
      summary: string
      versionId: string
      versionName: string
    },
  ): Promise<ResolvedModrinthPack> {
    const loaderDependency = {
      FABRIC: 'fabric-loader',
      FORGE: 'forge',
      NEOFORGE: 'neoforge',
      QUILT: 'quilt-loader',
    }[loader]
    if (
      parsed.index.dependencies.minecraft !== minecraftVersion ||
      !parsed.index.dependencies[loaderDependency]
    ) {
      throw new Error('Modpack dependencies do not match the selected profile')
    }
    const versionsByHash = await this.versionsFromHashes(
      parsed.index.files.map((file) => file.hashes.sha1),
    )
    const projectIds = [...new Set(
      Object.values(versionsByHash).map((item) => item.project_id),
    )]
    const projects = await this.projectsByIds(projectIds)
    const files = parsed.index.files.map((file) => {
      const modVersion = versionsByHash[file.hashes.sha1]
      const modProject = modVersion ? projects[modVersion.project_id] : undefined
      return {
        path: file.path,
        size: file.fileSize,
        sha1: file.hashes.sha1,
        client: file.env?.client ?? 'required',
        server: file.env?.server ?? 'required',
        projectId: modVersion?.project_id ?? null,
        name: modProject?.title ?? basename(file.path),
        description: modProject?.description ?? '',
      }
    })
    return {
      inspection: {
        ...metadata,
        minecraftVersion,
        loader,
        loaderVersion: parsed.index.dependencies[loaderDependency]!,
        files,
        clientOverrideCount: parsed.overrides.filter(
          (item) => item.side !== 'server',
        ).length,
        serverOverrideCount: parsed.overrides.filter(
          (item) => item.side !== 'client',
        ).length,
      },
      files: parsed.index.files,
      overrides: parsed.overrides,
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
    return this.resolveInstall(slug, minecraftVersion, loader, 'server')
  }

  async resolveInstall(
    slug: string,
    minecraftVersion: string,
    loader: string,
    target: 'client' | 'server',
  ) {
    const resolved: Array<{
      projectId: string
      slug: string
      title: string
      root: boolean
      version: ModrinthVersion
      file: ModrinthVersion['files'][number]
    }> = []
    const visited = new Set<string>()
    const visit = async (projectRef: string, root = false) => {
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
      const side = target === 'server' ? project.server_side : project.client_side
      if (side === 'unsupported') {
        if (!root) return
        throw new Error(`${project.slug} is marked as unsupported on the ${target}`)
      }
      const versionsUrl = new URL(
        `${modrinthSource.api}/project/${encodeURIComponent(project.id)}/version`,
      )
      versionsUrl.searchParams.set('loaders', JSON.stringify([loader.toLowerCase()]))
      versionsUrl.searchParams.set('game_versions', JSON.stringify([minecraftVersion]))
      const versionsResponse = await this.fetcher(versionsUrl, { headers: requestHeaders })
      if (!versionsResponse.ok) {
        throw new Error(`Failed to resolve a ${target} version for ${project.slug}`)
      }
      const versions = (await versionsResponse.json()) as ModrinthVersion[]
      const version = versions[0]
      if (!version) {
        throw new Error(`${project.slug} has no compatible ${minecraftVersion}/${loader} version`)
      }
      for (const dependency of version.dependencies ?? []) {
        if (dependency.dependency_type !== 'required') continue
        if (dependency.project_id) {
          await visit(dependency.project_id, false)
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
        await visit(dependencyVersion.project_id, false)
      }
      const file = version.files.find((item) => item.primary) ?? version.files[0]
      if (!file) throw new Error(`${project.slug} version does not contain a downloadable file`)
      resolved.push({
        projectId: project.id,
        slug: project.slug,
        title: project.title ?? project.slug,
        root,
        version,
        file,
      })
    }
    await visit(slug, true)
    return resolved
  }

  async versionsFromHashes(hashes: string[]) {
    if (!hashes.length) return {} as Record<string, ModrinthVersion>
    const versions: Record<string, ModrinthVersion> = {}
    for (let index = 0; index < hashes.length; index += 100) {
      const response = await this.fetcher(`${modrinthSource.api}/version_files`, {
        method: 'POST',
        headers: { ...requestHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: hashes.slice(index, index + 100), algorithm: 'sha1' }),
      })
      if (!response.ok) {
        throw new Error(`Modrinth hash lookup failed with HTTP ${response.status}`)
      }
      Object.assign(
        versions,
        (await response.json()) as Record<string, ModrinthVersion>,
      )
    }
    return versions
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

  async download(
    file: ModrinthVersion['files'][number],
    maximumBytes = 200 * 1024 * 1024,
  ) {
    if (!file.url.startsWith('https://cdn.modrinth.com/')) {
      throw new Error('Modrinth returned a non-CDN artifact URL')
    }
    if (file.size > maximumBytes) throw new Error('Modrinth artifact exceeds the size limit')
    const response = await this.fetcher(file.url, { headers: requestHeaders })
    if (!response.ok) throw new Error(`Mod download failed with HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maximumBytes) throw new Error('Modrinth artifact exceeds the size limit')
    const digest = new Bun.CryptoHasher('sha512').update(bytes).digest('hex')
    if (digest !== file.hashes.sha512) throw new Error('Modrinth artifact checksum mismatch')
    return bytes
  }

  async downloadPackFile(file: ModrinthPackIndex['files'][number]) {
    if (file.fileSize > 200 * 1024 * 1024) {
      throw new Error(`Modpack file exceeds 200 MiB: ${file.path}`)
    }
    const url = file.downloads.find((candidate) => this.allowedPackDownload(candidate))
    if (!url) throw new Error(`Modpack file has no allowed HTTPS download: ${file.path}`)
    const response = await this.fetcher(url, { headers: requestHeaders, redirect: 'follow' })
    if (!response.ok) throw new Error(`Modpack file download failed with HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength !== file.fileSize || bytes.byteLength > 200 * 1024 * 1024) {
      throw new Error(`Modpack file size mismatch: ${file.path}`)
    }
    const digest = new Bun.CryptoHasher('sha512').update(bytes).digest('hex')
    if (digest !== file.hashes.sha512) {
      throw new Error(`Modpack file checksum mismatch: ${file.path}`)
    }
    return bytes
  }

  async projectsByIds(ids: string[]) {
    if (!ids.length) return {} as Record<string, ModrinthProjectDetail>
    const projects: Record<string, ModrinthProjectDetail> = {}
    for (let index = 0; index < ids.length; index += 100) {
      const url = new URL(`${modrinthSource.api}/projects`)
      url.searchParams.set('ids', JSON.stringify(ids.slice(index, index + 100)))
      const response = await this.fetcher(url, { headers: requestHeaders })
      if (!response.ok) continue
      for (const project of (await response.json()) as ModrinthProjectDetail[]) {
        projects[project.id] = project
      }
    }
    return projects
  }

  private allowedPackDownload(value: string) {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && [
        'cdn.modrinth.com',
        'github.com',
        'raw.githubusercontent.com',
        'gitlab.com',
      ].includes(url.hostname)
    } catch {
      return false
    }
  }

  private safePackPath(value: string) {
    return Boolean(
      value &&
      !value.includes('\\') &&
      !value.startsWith('/') &&
      !/^[a-zA-Z]:/.test(value) &&
      !value.split('/').some((part) => !part || part === '.' || part === '..'),
    )
  }

  private async readModpackArchive(
    bytes: Uint8Array,
    includeOverrides: boolean,
  ): Promise<ParsedModrinthPack> {
    const directory = await mkdtemp(join(tmpdir(), 'gravit-mrpack-'))
    const archivePath = join(directory, 'pack.mrpack')
    try {
      await writeFile(archivePath, bytes)
      const entries = (await this.runUnzip(['-Z1', archivePath]))
        .split(/\r?\n/)
        .filter(Boolean)
      if (entries.length > 4_000) throw new Error('Modpack archive contains too many files')
      if (!entries.includes('modrinth.index.json')) {
        throw new Error('Modpack archive has no modrinth.index.json')
      }
      if (entries.some((entry) => entry.startsWith('/') || entry.includes('../'))) {
        throw new Error('Modpack archive contains an unsafe path')
      }
      const sizes = new Map<string, number>()
      let expandedBytes = 0
      for (const line of (await this.runUnzip(['-l', archivePath])).split(/\r?\n/)) {
        const match = line.match(
          /^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/,
        )
        if (!match) continue
        const size = Number(match[1])
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error('Modpack archive contains an invalid expanded size')
        }
        sizes.set(match[2]!, size)
        expandedBytes += size
      }
      if (expandedBytes > 512 * 1024 * 1024) {
        throw new Error('Modpack archive expands beyond 512 MiB')
      }
      if ((sizes.get('modrinth.index.json') ?? 0) > 4 * 1024 * 1024) {
        throw new Error('Modpack manifest exceeds 4 MiB')
      }
      const indexBytes = await this.readZipEntry(archivePath, 'modrinth.index.json')
      if (indexBytes.byteLength > 4 * 1024 * 1024) {
        throw new Error('Modpack manifest exceeds 4 MiB')
      }
      const index = JSON.parse(new TextDecoder().decode(indexBytes)) as ModrinthPackIndex
      if (
        index.formatVersion !== 1 ||
        index.game !== 'minecraft' ||
        typeof index.name !== 'string' ||
        !index.name.trim() ||
        typeof index.versionId !== 'string' ||
        !index.versionId.trim() ||
        !Array.isArray(index.files) ||
        !index.dependencies ||
        typeof index.dependencies !== 'object'
      ) throw new Error('Unsupported Modrinth modpack manifest')
      if (index.files.length > 2_000) throw new Error('Modpack contains too many downloads')
      for (const file of index.files) {
        if (
          !this.safePackPath(file.path) ||
          !file.hashes?.sha1 ||
          !file.hashes?.sha512 ||
          !Array.isArray(file.downloads) ||
          !Number.isSafeInteger(file.fileSize) ||
          file.fileSize <= 0
        ) throw new Error(`Invalid Modrinth modpack file entry: ${file.path}`)
      }
      const overrides: ResolvedModrinthPack['overrides'] = []
      for (const entry of entries) {
        const scope = entry.startsWith('overrides/')
          ? 'common'
          : entry.startsWith('client-overrides/')
            ? 'client'
            : entry.startsWith('server-overrides/')
              ? 'server'
              : null
        if (!scope || entry.endsWith('/')) continue
        const path = entry.slice(entry.indexOf('/') + 1)
        if (!this.safePackPath(path)) throw new Error(`Unsafe modpack override: ${entry}`)
        if ((sizes.get(entry) ?? 0) > 64 * 1024 * 1024) {
          throw new Error(`Modpack override exceeds 64 MiB: ${entry}`)
        }
        const content = includeOverrides
          ? await this.readZipEntry(archivePath, entry)
          : new Uint8Array()
        if (includeOverrides && content.byteLength > 64 * 1024 * 1024) {
          throw new Error(`Modpack override exceeds 64 MiB: ${entry}`)
        }
        overrides.push({ side: scope, path, bytes: content })
      }
      return { index, overrides }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async readZipEntry(archive: string, entry: string) {
    const process = Bun.spawn(['unzip', '-p', archive, entry], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const bytes = new Uint8Array(await new Response(process.stdout).arrayBuffer())
    if (await process.exited !== 0) {
      throw new Error(`Failed to read ${entry} from Modrinth modpack`)
    }
    return bytes
  }

  private async runUnzip(args: string[]) {
    const process = Bun.spawn(['unzip', ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    if (exitCode !== 0) throw new Error(`Invalid Modrinth modpack archive: ${stderr.trim()}`)
    return stdout
  }
}
