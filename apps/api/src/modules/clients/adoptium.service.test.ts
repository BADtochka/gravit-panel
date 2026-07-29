import { describe, expect, test } from 'bun:test'
import { AdoptiumService } from './adoptium.service'

describe('AdoptiumService', () => {
  test('resolves and downloads the latest matching Temurin release', async () => {
    let requestedUrl = ''
    let downloadedUrl = ''
    const bytes = new Uint8Array([1, 2, 3])
    const service = new AdoptiumService(
      async (input) => {
        requestedUrl = String(input)
        return Response.json([
          {
            release_name: 'jdk-21.0.12+8',
            version_data: { major: 21, build: 8 },
            binaries: [
              {
                architecture: 'x64',
                image_type: 'jre',
                os: 'windows',
                package: {
                  checksum: 'a'.repeat(64),
                  link: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/runtime.zip',
                  name: 'runtime.zip',
                  size: bytes.length,
                },
              },
            ],
          },
        ])
      },
      async (url) => {
        downloadedUrl = url
        return bytes
      },
    )

    const result = await service.downloadLatest({
      version: 21,
      os: 'mustdie',
      arch: 'X86_64',
      imageType: 'jre',
    })

    const query = new URL(requestedUrl)
    expect(query.searchParams.get('architecture')).toBe('x64')
    expect(query.searchParams.get('os')).toBe('windows')
    expect(query.searchParams.get('image_type')).toBe('jre')
    expect(downloadedUrl).toBe(result.sourceUrl)
    expect(result).toMatchObject({
      archiveFormat: 'zip',
      build: 8,
      releaseName: 'jdk-21.0.12+8',
    })
  })

  test('rejects a runtime URL outside the official Temurin release repository', async () => {
    const service = new AdoptiumService(async () =>
      Response.json([
        {
          release_name: 'jdk-21.0.12+8',
          version_data: { major: 21, build: 8 },
          binaries: [
            {
              architecture: 'x64',
              image_type: 'jre',
              os: 'linux',
              package: {
                checksum: 'a'.repeat(64),
                link: 'https://example.com/runtime.tar.gz',
                name: 'runtime.tar.gz',
                size: 3,
              },
            },
          ],
        },
      ]),
    )

    await expect(service.downloadLatest({
      version: 21,
      os: 'linux',
      arch: 'X86_64',
      imageType: 'jre',
    })).rejects.toThrow('untrusted')
  })
})
