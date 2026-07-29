import { describe, expect, test } from 'bun:test'
import { LoaderInstallerService } from './loader-installer.service'
import { sha256Bytes } from './verified-artifact'

const response = (body: string, status = 200) => {
  const bytes = new TextEncoder().encode(body)
  return new Response(body, {
    status,
    headers: { 'Content-Length': String(bytes.byteLength) },
  })
}

describe('LoaderInstallerService', () => {
  test('resolves the latest Minecraft-compatible NeoForge and verifies its SHA-256', async () => {
    const installer = new TextEncoder().encode('neoforge-installer')
    const digest = sha256Bytes(installer)
    const requests: string[] = []
    const service = new LoaderInstallerService(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/api/maven/versions/')) {
        return response(JSON.stringify({
          isSnapshot: false,
          versions: ['21.1.100', '21.2.1', '21.1.244'],
        }))
      }
      if (url.endsWith('.sha256')) return response(digest)
      return response(new TextDecoder().decode(installer))
    })

    const artifact = await service.download('NEOFORGE', '1.21.1')

    expect(artifact.filename).toBe('neoforge-1.21.1-installer-nogui.jar')
    expect(artifact.loaderVersion).toBe('21.1.244')
    expect(artifact.sha256).toBe(digest)
    expect(requests).toEqual([
      'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
      'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.244/neoforge-21.1.244-installer.jar.sha256',
      'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.244/neoforge-21.1.244-installer.jar',
    ])
  })

  test('downloads the exact selected NeoForge version instead of the latest one', async () => {
    const installer = new TextEncoder().encode('neoforge-21.1.243-installer')
    const digest = sha256Bytes(installer)
    const requests: string[] = []
    const service = new LoaderInstallerService(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/api/maven/versions/')) {
        return response(JSON.stringify({
          versions: ['21.1.244', '21.1.243', '21.2.1'],
        }))
      }
      if (url.endsWith('.sha256')) return response(digest)
      return response(new TextDecoder().decode(installer))
    })

    const artifact = await service.download('NEOFORGE', '1.21.1', '21.1.243')

    expect(artifact.loaderVersion).toBe('21.1.243')
    expect(requests.slice(-2)).toEqual([
      'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.243/neoforge-21.1.243-installer.jar.sha256',
      'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.243/neoforge-21.1.243-installer.jar',
    ])
  })

  test('uses the source-defined legacy Forge artifact path', async () => {
    const installer = new TextEncoder().encode('forge-installer')
    const digest = sha256Bytes(installer)
    const requests: string[] = []
    const service = new LoaderInstallerService(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('promotions_slim.json')) {
        return response(JSON.stringify({ promos: { '1.7.10-latest': '10.13.4.1614' } }))
      }
      if (url.endsWith('.sha256')) return response(digest)
      return response(new TextDecoder().decode(installer))
    })

    const artifact = await service.download('FORGE', '1.7.10')

    expect(artifact.filename).toBe('forge-1.7.10-installer.jar')
    expect(artifact.loaderVersion).toBe('10.13.4.1614')
    expect(requests.at(-1)).toBe(
      'https://maven.minecraftforge.net/net/minecraftforge/forge/' +
      '1.7.10-10.13.4.1614-1.7.10/forge-1.7.10-10.13.4.1614-1.7.10-installer.jar',
    )
  })

  test('rejects an installer whose bytes do not match the Maven checksum', async () => {
    const service = new LoaderInstallerService(async (input) => {
      const url = String(input)
      if (url.includes('/api/maven/versions/')) {
        return response(JSON.stringify({ versions: ['21.1.244'] }))
      }
      if (url.endsWith('.sha256')) return response('a'.repeat(64))
      return response('tampered-installer')
    })

    await expect(service.download('NEOFORGE', '1.21.1')).rejects.toThrow(
      'installer checksum mismatch',
    )
  })

  test('fails clearly when no compatible NeoForge version exists', async () => {
    const service = new LoaderInstallerService(async () =>
      response(JSON.stringify({ versions: ['21.2.1'] })),
    )

    await expect(service.download('NEOFORGE', '1.21.1')).rejects.toThrow(
      'NeoForge has no installer for Minecraft 1.21.1',
    )
  })
})
