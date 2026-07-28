import { describe, expect, test } from 'bun:test'
import { resolveLaunchServerRedirect } from '../src/lib/launchserver-routing'

describe('LaunchServer-aware routing', () => {
  test.each(['/clients', '/launcher', '/mods', '/modules', '/auth', '/jobs'])(
    'preserves %s after LaunchServer loads during a page reload',
    (path) => {
      expect(resolveLaunchServerRedirect(path, true)).toBeNull()
    },
  )

  test('opens status only when a configured server lands on the setup route', () => {
    expect(resolveLaunchServerRedirect('/', true)).toBe('/status')
  })

  test('opens LaunchServer setup when no server exists', () => {
    expect(resolveLaunchServerRedirect('/clients', false)).toBe('/')
    expect(resolveLaunchServerRedirect('/', false)).toBeNull()
  })
})
