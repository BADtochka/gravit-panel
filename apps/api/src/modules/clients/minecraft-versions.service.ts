import type { MinecraftVersionCatalog } from '@gravit-panel/shared'

export const minecraftVersionManifestUrl =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

interface VersionManifest {
  latest?: {
    release?: unknown
  }
  versions?: Array<{
    id?: unknown
    type?: unknown
    releaseTime?: unknown
  }>
}

const cacheDurationMs = 6 * 60 * 60 * 1000
const versionPattern = /^[0-9]+(?:\.[0-9]+){1,3}$/
type ManifestFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export class MinecraftVersionsService {
  private cached: { expiresAt: number; catalog: MinecraftVersionCatalog } | null = null

  constructor(
    private readonly fetcher: ManifestFetcher = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<MinecraftVersionCatalog> {
    const now = this.now()
    if (this.cached && this.cached.expiresAt > now.getTime()) return this.cached.catalog

    const response = await this.fetcher(minecraftVersionManifestUrl, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(`Minecraft version manifest request failed with status ${response.status}`)
    }

    const manifest = (await response.json()) as VersionManifest
    const items = (manifest.versions ?? [])
      .filter(
        (item) =>
          item.type === 'release' &&
          typeof item.id === 'string' &&
          versionPattern.test(item.id) &&
          typeof item.releaseTime === 'string' &&
          !Number.isNaN(Date.parse(item.releaseTime)),
      )
      .map((item) => ({
        id: item.id as string,
        releaseTime: item.releaseTime as string,
      }))
      .sort((left, right) => Date.parse(right.releaseTime) - Date.parse(left.releaseTime))

    const latestRelease = manifest.latest?.release
    if (
      !items.length ||
      typeof latestRelease !== 'string' ||
      !items.some((item) => item.id === latestRelease)
    ) {
      throw new Error('Minecraft version manifest did not contain a valid release catalog')
    }

    const catalog: MinecraftVersionCatalog = {
      items,
      latestRelease,
      source: {
        manifestUrl: minecraftVersionManifestUrl,
        fetchedAt: now.toISOString(),
      },
    }
    this.cached = {
      expiresAt: now.getTime() + cacheDurationMs,
      catalog,
    }
    return catalog
  }
}
