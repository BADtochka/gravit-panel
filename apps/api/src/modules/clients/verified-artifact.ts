import { createHash } from 'node:crypto'

export type VerifiedArtifactFetcher = (
  url: string,
  expectedSha256: string,
  maximumBytes: number,
) => Promise<Uint8Array>

export const sha256Bytes = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

export const fetchVerifiedArtifact: VerifiedArtifactFetcher = async (
  url,
  expectedSha256,
  maximumBytes,
) => {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'GravitPanel/0.1 source-verified-installer' },
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`Pinned artifact download failed with HTTP ${response.status}`)
  const declaredSize = Number(response.headers.get('content-length') ?? 0)
  if (declaredSize > maximumBytes) throw new Error('Pinned artifact exceeds the size limit')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maximumBytes) throw new Error('Pinned artifact exceeds the size limit')
  const actualSha256 = sha256Bytes(bytes)
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Pinned artifact checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`)
  }
  return bytes
}
