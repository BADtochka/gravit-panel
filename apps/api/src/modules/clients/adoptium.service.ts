import type {
  JavaRuntimeArch,
  JavaRuntimeOs,
} from '@gravit-panel/shared'
import {
  fetchVerifiedArtifact,
  type VerifiedArtifactFetcher,
} from './verified-artifact'

export interface TemurinRuntimeRequest {
  version: number
  os: JavaRuntimeOs
  arch: JavaRuntimeArch
  imageType: 'jre' | 'jdk'
}

type AdoptiumFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface TemurinRuntimeDownload {
  bytes: Uint8Array
  archiveFormat: 'zip' | 'tar.gz'
  build: number
  releaseName: string
  filename: string
  sha256: string
  sourceUrl: string
}

interface AdoptiumRelease {
  release_name?: string
  version_data?: {
    build?: number
    major?: number
    openjdk_version?: string
  }
  binaries?: Array<{
    architecture?: string
    image_type?: string
    os?: string
    package?: {
      checksum?: string
      link?: string
      name?: string
      size?: number
    }
  }>
}

const maximumRuntimeBytes = 300 * 1024 * 1024
const requestHeaders = {
  Accept: 'application/json',
  'User-Agent': 'GravitPanel/0.1 (https://github.com/BADtochka/gravit-panel)',
}

export class AdoptiumService {
  constructor(
    private readonly fetcher: AdoptiumFetcher = fetch,
    private readonly artifactFetcher: VerifiedArtifactFetcher = fetchVerifiedArtifact,
  ) {}

  async downloadLatest(input: TemurinRuntimeRequest): Promise<TemurinRuntimeDownload> {
    this.validate(input)
    const architecture = {
      X86: 'x86',
      X86_64: 'x64',
      ARM32: 'arm',
      ARM64: 'aarch64',
    }[input.arch]
    const os = input.os === 'mustdie' ? 'windows' : input.os === 'macosx' ? 'mac' : 'linux'
    const url = new URL(
      `https://api.adoptium.net/v3/assets/feature_releases/${input.version}/ga`,
    )
    for (const [key, value] of Object.entries({
      architecture,
      heap_size: 'normal',
      image_type: input.imageType,
      jvm_impl: 'hotspot',
      os,
      page: '0',
      page_size: '1',
      project: 'jdk',
      sort_method: 'DEFAULT',
      sort_order: 'DESC',
      vendor: 'eclipse',
    })) url.searchParams.set(key, value)

    const response = await this.fetcher(url, { headers: requestHeaders })
    if (!response.ok) {
      throw new Error(`Adoptium release lookup failed with HTTP ${response.status}`)
    }
    const release = ((await response.json()) as AdoptiumRelease[])[0]
    const binary = release?.binaries?.[0]
    const artifact = binary?.package
    if (
      !release ||
      release.version_data?.major !== input.version ||
      !Number.isSafeInteger(release.version_data.build) ||
      binary?.architecture !== architecture ||
      binary.image_type !== input.imageType ||
      binary.os !== os ||
      !artifact ||
      typeof artifact.link !== 'string' ||
      typeof artifact.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(artifact.checksum) ||
      typeof artifact.name !== 'string' ||
      typeof artifact.size !== 'number' ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      artifact.size > maximumRuntimeBytes
    ) {
      throw new Error('Adoptium returned an invalid or unavailable runtime release')
    }
    const artifactUrl = new URL(artifact.link)
    if (
      artifactUrl.protocol !== 'https:' ||
      artifactUrl.hostname !== 'github.com' ||
      !artifactUrl.pathname.startsWith('/adoptium/temurin')
    ) {
      throw new Error('Adoptium returned an untrusted runtime download URL')
    }
    const archiveFormat = artifact.name.endsWith('.zip')
      ? 'zip'
      : artifact.name.endsWith('.tar.gz')
        ? 'tar.gz'
        : null
    if (!archiveFormat) throw new Error('Adoptium returned an unsupported archive format')
    const bytes = await this.artifactFetcher(
      artifact.link,
      artifact.checksum,
      maximumRuntimeBytes,
    )
    if (bytes.length !== artifact.size) {
      throw new Error('Adoptium runtime size does not match release metadata')
    }
    return {
      bytes,
      archiveFormat,
      build: release.version_data.build!,
      releaseName: release.release_name ?? release.version_data.openjdk_version ?? artifact.name,
      filename: artifact.name,
      sha256: artifact.checksum,
      sourceUrl: artifact.link,
    }
  }

  private validate(input: TemurinRuntimeRequest) {
    if (!Number.isSafeInteger(input.version) || input.version < 8 || input.version > 99) {
      throw new Error('Temurin version must be between 8 and 99')
    }
  }
}
