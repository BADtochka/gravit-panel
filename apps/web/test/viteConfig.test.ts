import { expect, test } from 'bun:test'
import config from '../vite.config'

test('development proxy forwards application WebSockets to the API', () => {
  const resolved = typeof config === 'function'
    ? config({ command: 'serve', mode: 'development', isSsrBuild: false, isPreview: false })
    : config
  const proxy = resolved.server?.proxy?.['/api']

  expect(proxy).toMatchObject({
    target: 'http://127.0.0.1:3000',
    changeOrigin: true,
    ws: true,
  })
  expect(resolved.server?.strictPort).toBe(true)
})
