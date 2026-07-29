import { sha256Bytes } from './verified-artifact'

export type LoaderInstallerType = 'FORGE' | 'NEOFORGE'

export interface LoaderInstallerArtifact {
  bytes: Uint8Array
  filename: string
  loaderVersion: string
  sha256: string
  url: string
}

export interface LoaderInstallerProvider {
  versions(
    loader: LoaderInstallerType,
    minecraftVersion: string,
  ): Promise<string[]>
  download(
    loader: LoaderInstallerType,
    minecraftVersion: string,
    loaderVersion?: string,
  ): Promise<LoaderInstallerArtifact>
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface NeoForgeVersions {
  versions?: unknown
}

interface ForgePromotions {
  promos?: unknown
}

const neoForgeVersionsUrl =
  'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'
const forgePromotionsUrl =
  'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
const forgeMetadataUrl =
  'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'
const maximumMetadataBytes = 2 * 1024 * 1024
const maximumInstallerBytes = 128 * 1024 * 1024
const requestHeaders = {
  'User-Agent': 'GravitPanel/0.1 source-verified-installer',
}
const loaderVersionPattern = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,127}$/
const versionCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

const minecraftVersionParts = (version: string) =>
  version.split('.').map((part) => Number(part))

const isMinecraftAtMost = (version: string, expected: string) => {
  const left = minecraftVersionParts(version)
  const right = minecraftVersionParts(expected)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference < 0
  }
  return true
}

export class LoaderInstallerService implements LoaderInstallerProvider {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async versions(loader: LoaderInstallerType, minecraftVersion: string) {
    if (!/^[0-9]+(?:\.[0-9]+){1,3}$/.test(minecraftVersion)) {
      throw new Error('Minecraft version has an invalid format')
    }
    if (loader === 'NEOFORGE') {
      const metadata = await this.fetchJson<NeoForgeVersions>(
        neoForgeVersionsUrl,
        'NeoForge version metadata',
      )
      if (!Array.isArray(metadata.versions)) {
        throw new Error('NeoForge version metadata does not contain a versions array')
      }
      const prefix = minecraftVersion.startsWith('1.')
        ? `${minecraftVersion.slice(2)}.`
        : `${minecraftVersion}.`
      return metadata.versions
        .filter((version): version is string =>
          typeof version === 'string' &&
          version.startsWith(prefix) &&
          loaderVersionPattern.test(version),
        )
        .sort(versionCollator.compare)
        .reverse()
    }

    const metadata = await this.fetchText(
      forgeMetadataUrl,
      'Forge version metadata',
      maximumMetadataBytes,
    )
    const prefix = `${minecraftVersion}-`
    return [...metadata.matchAll(/<version>([^<]+)<\/version>/g)]
      .map((match) => match[1]!)
      .filter((version) => version.startsWith(prefix))
      .map((version) => {
        const withoutMinecraft = version.slice(prefix.length)
        const legacySuffix = `-${minecraftVersion}`
        return withoutMinecraft.endsWith(legacySuffix)
          ? withoutMinecraft.slice(0, -legacySuffix.length)
          : withoutMinecraft
      })
      .filter((version, index, values) =>
        loaderVersionPattern.test(version) && values.indexOf(version) === index,
      )
      .sort(versionCollator.compare)
      .reverse()
  }

  async download(
    loader: LoaderInstallerType,
    minecraftVersion: string,
    loaderVersion?: string,
  ): Promise<LoaderInstallerArtifact> {
    const resolved = loader === 'NEOFORGE'
      ? await this.resolveNeoForge(minecraftVersion, loaderVersion)
      : await this.resolveForge(minecraftVersion, loaderVersion)
    const expectedSha256 = await this.fetchText(
      `${resolved.url}.sha256`,
      'installer checksum',
      1024,
    )
    const digest = expectedSha256.trim().split(/\s+/, 1)[0]?.toLowerCase()
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`${loader} Maven repository returned an invalid SHA-256 checksum`)
    }

    const bytes = await this.fetchBytes(
      resolved.url,
      `${loader} installer`,
      maximumInstallerBytes,
      120_000,
    )
    const actualSha256 = sha256Bytes(bytes)
    if (actualSha256 !== digest) {
      throw new Error(
        `${loader} installer checksum mismatch: expected ${digest}, got ${actualSha256}`,
      )
    }
    return {
      ...resolved,
      bytes,
      sha256: actualSha256,
    }
  }

  private async resolveNeoForge(minecraftVersion: string, requestedVersion?: string) {
    const versions = await this.versions('NEOFORGE', minecraftVersion)
    const loaderVersion = requestedVersion ?? versions[0]
    if (!loaderVersion) {
      throw new Error(`NeoForge has no installer for Minecraft ${minecraftVersion}`)
    }
    if (!versions.includes(loaderVersion)) {
      throw new Error(
        `NeoForge ${loaderVersion} is not available for Minecraft ${minecraftVersion}`,
      )
    }
    const filename = `neoforge-${minecraftVersion}-installer-nogui.jar`
    return {
      filename,
      loaderVersion,
      url:
        `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/` +
        `neoforge-${loaderVersion}-installer.jar`,
    }
  }

  private async resolveForge(minecraftVersion: string, requestedVersion?: string) {
    let loaderVersion = requestedVersion
    if (loaderVersion) {
      const versions = await this.versions('FORGE', minecraftVersion)
      if (!versions.includes(loaderVersion)) {
        throw new Error(
          `Forge ${loaderVersion} is not available for Minecraft ${minecraftVersion}`,
        )
      }
    } else {
      const metadata = await this.fetchJson<ForgePromotions>(
        forgePromotionsUrl,
        'Forge promotions metadata',
      )
      if (!metadata.promos || typeof metadata.promos !== 'object') {
        throw new Error('Forge promotions metadata does not contain a promos object')
      }
      const promoted = (metadata.promos as Record<string, unknown>)[
        `${minecraftVersion}-latest`
      ]
      if (typeof promoted === 'string') loaderVersion = promoted
    }
    if (!loaderVersion || !loaderVersionPattern.test(loaderVersion)) {
      throw new Error(`Forge has no installer for Minecraft ${minecraftVersion}`)
    }
    const legacy = isMinecraftAtMost(minecraftVersion, '1.10')
    const filename = `forge-${minecraftVersion}-installer${legacy ? '' : '-nogui'}.jar`
    const artifactVersion = legacy
      ? `${minecraftVersion}-${loaderVersion}-${minecraftVersion}`
      : `${minecraftVersion}-${loaderVersion}`
    return {
      filename,
      loaderVersion,
      url:
        `https://maven.minecraftforge.net/net/minecraftforge/forge/${artifactVersion}/` +
        `forge-${artifactVersion}-installer.jar`,
    }
  }

  private async fetchJson<T>(url: string, label: string) {
    const bytes = await this.fetchBytes(url, label, maximumMetadataBytes, 30_000)
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T
    } catch {
      throw new Error(`${label} returned invalid JSON`)
    }
  }

  private async fetchText(
    url: string,
    label: string,
    maximumBytes: number,
  ) {
    return new TextDecoder().decode(
      await this.fetchBytes(url, label, maximumBytes, 30_000),
    )
  }

  private async fetchBytes(
    url: string,
    label: string,
    maximumBytes: number,
    timeoutMs: number,
  ) {
    let response: Response
    try {
      response = await this.fetcher(url, {
        headers: requestHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`${label} request failed: ${detail}`, { cause: error })
    }
    if (!response.ok) {
      throw new Error(`${label} request failed with HTTP ${response.status}`)
    }
    const declaredSize = Number(response.headers.get('content-length') ?? 0)
    if (declaredSize > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes} byte size limit`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes} byte size limit`)
    }
    return bytes
  }
}
