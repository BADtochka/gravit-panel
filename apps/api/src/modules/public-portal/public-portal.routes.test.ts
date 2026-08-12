import { expect, test } from 'bun:test'
import { publicPortalRoutes } from './public-portal.routes'

test('accepts a PNG skin filename with a cache-busting query', async () => {
  const response = await publicPortalRoutes.handle(new Request(
    'https://panel.example.com/public/skins/formallybad.png?v=2026-08-12T20:40:04.247Z',
  ))

  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ message: 'Skin not found.' })
})

test('rejects malformed skin filenames', async () => {
  const response = await publicPortalRoutes.handle(new Request(
    'https://panel.example.com/public/skins/formallybad.jpg',
  ))

  expect(response.status).toBe(422)
})
