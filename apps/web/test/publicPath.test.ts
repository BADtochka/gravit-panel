import { describe, expect, test } from 'bun:test'

describe('panel public path', () => {
  test('keeps root deployment URLs unchanged', async () => {
    globalThis.window = { __GRAVIT_PANEL_CONFIG__: { publicPath: '' } } as Window & typeof globalThis
    const { panelUrl } = await import(`../src/lib/public-path.ts?root=${crypto.randomUUID()}`)
    expect(panelUrl('/api/health')).toBe('/api/health')
  })

  test('prefixes browser-visible API URLs under a subroute', async () => {
    globalThis.window = { __GRAVIT_PANEL_CONFIG__: { publicPath: '/panel/' } } as Window & typeof globalThis
    const { panelUrl } = await import(`../src/lib/public-path.ts?subroute=${crypto.randomUUID()}`)
    expect(panelUrl('/api/health')).toBe('/panel/api/health')
    expect(panelUrl('https://discord.com/api')).toBe('https://discord.com/api')
  })
})
