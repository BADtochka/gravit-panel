import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

describe('panel public path', () => {
  test('leaves a runtime placeholder for the HTML base URL', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
    expect(html).toContain('<base href="__GRAVIT_PANEL_BASE_HREF__" />')
  })

  test('keeps root deployment URLs unchanged', async () => {
    globalThis.window = { __GRAVIT_PANEL_CONFIG__: { publicPath: '' } } as Window & typeof globalThis
    const { panelUrl } = await import(`../src/lib/public-path.ts?root=${crypto.randomUUID()}`)
    expect(panelUrl('/api/health')).toBe('/api/health')
  })

  test('prefixes browser-visible API URLs under a subroute', async () => {
    globalThis.window = { __GRAVIT_PANEL_CONFIG__: { publicPath: '/panel/' } } as Window & typeof globalThis
    const { panelUrl } = await import(`../src/lib/public-path.ts?subroute=${crypto.randomUUID()}`)
    expect(panelUrl('/api/health')).toBe('/panel/api/health')
    expect(panelUrl('/api/clients/launcher/artifacts/windows-x64?installationId=example')).toBe(
      '/panel/api/clients/launcher/artifacts/windows-x64?installationId=example',
    )
    expect(panelUrl('/gravit-panel-icon.png')).toBe('/panel/gravit-panel-icon.png')
    expect(panelUrl('/panel/api/health')).toBe('/panel/api/health')
    expect(panelUrl('https://discord.com/api')).toBe('https://discord.com/api')
  })
})
