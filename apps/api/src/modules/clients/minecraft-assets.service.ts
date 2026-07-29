import type { GravitInstallation } from '@gravit-panel/shared'
import { createHash } from 'node:crypto'
import {
  createReadStream,
} from 'node:fs'
import {
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { JobTaskContext } from '../jobs/jobs.runner'

const versionManifestUrl =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const metadataHosts = new Set([
  'piston-meta.mojang.com',
  'launchermeta.mojang.com',
])
const assetIndexHosts = new Set([
  ...metadataHosts,
  'launcher.mojang.com',
])
const assetObjectHost = 'resources.download.minecraft.net'
const safeSegmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const sha1Pattern = /^[a-f0-9]{40}$/
const maximumMetadataBytes = 16 * 1024 * 1024
const maximumAssetBytes = 128 * 1024 * 1024
const downloadConcurrency = 6

interface VersionManifest {
  versions?: Array<{ id?: unknown; url?: unknown }>
}

interface VersionMetadata {
  assetIndex?: {
    id?: unknown
    url?: unknown
  }
}

interface AssetIndex {
  objects?: Record<string, {
    hash?: unknown
    size?: unknown
  }>
}

export interface MinecraftAssetsProvider {
  ensureAssets(
    installation: GravitInstallation,
    minecraftVersion: string,
    assetDirectory: string,
    assetIndex: string,
    context: JobTaskContext,
  ): Promise<void>
}

type Fetcher = typeof fetch

const checkedUrl = (value: unknown, hosts: Set<string>, description: string) => {
  if (typeof value !== 'string') throw new Error(`${description} URL is missing`)
  const url = new URL(value)
  if (url.protocol !== 'https:' || !hosts.has(url.hostname)) {
    throw new Error(`${description} URL is not an allowed Mojang HTTPS endpoint`)
  }
  return url
}

const fetchBytes = async (
  fetcher: Fetcher,
  url: URL,
  maximumBytes: number,
  signal: AbortSignal,
) => {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    signal.throwIfAborted()
    try {
      const timeout = AbortSignal.timeout(30_000)
      const response = await fetcher(url, {
        signal: AbortSignal.any([signal, timeout]),
        headers: { 'user-agent': 'gravit-panel/1.0' },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const declaredLength = Number(response.headers.get('content-length') ?? 0)
      if (declaredLength > maximumBytes) {
        throw new Error(`response exceeds ${maximumBytes} bytes`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > maximumBytes) {
        throw new Error(`response exceeds ${maximumBytes} bytes`)
      }
      return bytes
    } catch (error) {
      lastError = error
      if (signal.aborted) signal.throwIfAborted()
      if (attempt < 3) await Bun.sleep(attempt * 250)
    }
  }
  throw new Error(
    `Failed to download ${url.hostname}${url.pathname}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

const sha1Bytes = (bytes: Uint8Array) =>
  createHash('sha1').update(bytes).digest('hex')

const sha1File = (path: string) =>
  new Promise<string>((resolveDigest, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveDigest(hash.digest('hex')))
  })

const existingFileMatches = async (path: string, size: number, hash: string) => {
  try {
    const stat = await lstat(path)
    return stat.isFile() && stat.size === size && await sha1File(path) === hash
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

const writeAtomic = async (path: string, bytes: Uint8Array) => {
  await mkdir(dirname(path), { recursive: true })
  const pending = `${path}.pending-${crypto.randomUUID()}`
  try {
    await writeFile(pending, bytes, { flag: 'wx', mode: 0o644 })
    await rename(pending, path)
  } catch (error) {
    await rm(pending, { force: true })
    throw error
  }
}

export class MinecraftAssetsService implements MinecraftAssetsProvider {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async ensureAssets(
    installation: GravitInstallation,
    minecraftVersion: string,
    assetDirectory: string,
    assetIndex: string,
    context: JobTaskContext,
  ) {
    if (!safeSegmentPattern.test(assetDirectory) || !safeSegmentPattern.test(assetIndex)) {
      throw new Error('Generated profile contains an unsafe Minecraft asset path')
    }

    const root = resolve(installation.path, 'launcher', 'updates', assetDirectory)
    const launcherRoot = resolve(installation.path, 'launcher')
    const rootRelative = relative(launcherRoot, root)
    if (!rootRelative || rootRelative.startsWith('..')) {
      throw new Error('Minecraft asset directory escapes Launcher data')
    }

    context.progress(50, `Resolving Minecraft ${minecraftVersion} assets`)
    const manifestBytes = await fetchBytes(
      this.fetcher,
      new URL(versionManifestUrl),
      maximumMetadataBytes,
      context.signal,
    )
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as VersionManifest
    const version = manifest.versions?.find((item) => item.id === minecraftVersion)
    const metadataUrl = checkedUrl(version?.url, metadataHosts, 'Minecraft version metadata')
    const metadataBytes = await fetchBytes(
      this.fetcher,
      metadataUrl,
      maximumMetadataBytes,
      context.signal,
    )
    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as VersionMetadata
    const officialAssetIndex = metadata.assetIndex
    if (
      typeof officialAssetIndex?.id === 'string' &&
      officialAssetIndex.id !== assetIndex
    ) {
      context.log(
        `Mapping profile asset index ${assetIndex} to Mojang index ${officialAssetIndex.id}`,
      )
    }
    const indexUrl = checkedUrl(officialAssetIndex?.url, assetIndexHosts, 'Minecraft asset index')
    const indexBytes = await fetchBytes(
      this.fetcher,
      indexUrl,
      maximumMetadataBytes,
      context.signal,
    )
    const index = JSON.parse(new TextDecoder().decode(indexBytes)) as AssetIndex
    if (!index.objects || typeof index.objects !== 'object') {
      throw new Error('Minecraft asset index does not contain objects')
    }

    const objects = [...new Map(
      Object.values(index.objects).map((value) => {
        const hash = value.hash
        const size = value.size
        if (
          typeof hash !== 'string' ||
          !sha1Pattern.test(hash) ||
          typeof size !== 'number' ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > maximumAssetBytes
        ) {
          throw new Error('Minecraft asset index contains an invalid object')
        }
        return [hash, { hash, size }] as const
      }),
    ).values()]

    const total = objects.length
    let completed = 0
    let reused = 0
    context.progress(55, `Downloading ${objects.length} Minecraft asset objects`)
    const workers = Array.from(
      { length: Math.min(downloadConcurrency, Math.max(1, objects.length)) },
      async () => {
        while (true) {
          context.signal.throwIfAborted()
          const object = objects.pop()
          if (!object) return
          const target = join(root, 'objects', object.hash.slice(0, 2), object.hash)
          if (await existingFileMatches(target, object.size, object.hash)) {
            reused += 1
          } else {
            const url = new URL(
              `https://${assetObjectHost}/${object.hash.slice(0, 2)}/${object.hash}`,
            )
            const bytes = await fetchBytes(
              this.fetcher,
              url,
              Math.max(object.size, 1),
              context.signal,
            )
            if (bytes.byteLength !== object.size || sha1Bytes(bytes) !== object.hash) {
              throw new Error(`Minecraft asset ${object.hash} failed size or SHA-1 verification`)
            }
            await writeAtomic(target, bytes)
          }
          completed += 1
          if (completed % 25 === 0 || completed === total) {
            context.progress(
              Math.min(85, 55 + Math.floor((completed / Math.max(1, total)) * 30)),
              `Minecraft assets: ${completed}/${total}`,
            )
          }
        }
      },
    )
    await Promise.all(workers)
    await writeAtomic(join(root, 'indexes', `${assetIndex}.json`), indexBytes)
    context.log(
      `Minecraft assets ready: ${completed} checked, ${reused} reused, ${completed - reused} downloaded`,
    )
  }
}
