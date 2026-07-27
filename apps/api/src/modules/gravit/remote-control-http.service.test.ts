import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { RemoteControlHttpService } from './remote-control-http.service'

const installation: GravitInstallation = {
  id: crypto.randomUUID(),
  name: 'test',
  path: '/srv/launcher',
  address: 'localhost:17549',
  projectName: 'TEST',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe('RemoteControlHttpService', () => {
  test('uses the source-defined query protocol and maps structured log lines', async () => {
    let requestedUrl: URL | null = null
    const service = new RemoteControlHttpService(async (input) => {
      requestedUrl = new URL(input.toString())
      return Response.json({
        data: {
          success: true,
          exception: null,
          lines: [
            { level: 'INFO', message: 'Show server status', exception: null },
            { level: 'WARN', message: 'Example warning', exception: 'Warning: details' },
          ],
        },
      })
    })

    const result = await service.execute(
      installation,
      { endpoint: 'http://localhost:17549', token: 'private-token' },
      'serverStatus',
    )

    const url = requestedUrl as URL | null
    expect(url?.pathname).toBe('/webapi/remotecontrol/command')
    expect(url?.searchParams.get('token')).toBe('private-token')
    expect(url?.searchParams.get('command')).toBe('serverStatus')
    expect(url?.searchParams.get('log')).toBe('true')
    expect(result).toMatchObject({
      transport: 'remote-control',
      lines: ['[INFO] Show server status', '[WARN] Example warning (Warning: details)'],
    })
  })

  test('rejects unsafe endpoint forms', () => {
    const service = new RemoteControlHttpService()
    expect(() => service.validateEndpoint('ftp://localhost')).toThrow('must use http or https')
    expect(() => service.validateEndpoint('http://user:pass@localhost')).toThrow(
      'must not contain credentials',
    )
  })

  test('turns network failures into an actionable proxy error without leaking the token', async () => {
    const service = new RemoteControlHttpService(async () => {
      throw new Error('The operation timed out.')
    })

    await expect(
      service.execute(
        installation,
        { endpoint: 'http://localhost:17549', token: 'private-token' },
        'serverStatus',
      ),
    ).rejects.toThrow('Ensure its nginx/HTTP proxy is running')

    try {
      await service.execute(
        installation,
        { endpoint: 'http://localhost:17549', token: 'private-token' },
        'serverStatus',
      )
    } catch (error) {
      expect(String(error)).not.toContain('private-token')
    }
  })
})
