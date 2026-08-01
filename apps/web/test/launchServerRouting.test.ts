import { describe, expect, test } from 'bun:test'
import { resolveLaunchServerRedirect } from '../src/lib/launchserver-routing'

describe('LaunchServer-aware routing', () => {
  test.each(['/clients', '/servers', '/launcher', '/mods', '/modules', '/auth', '/jobs'])(
    'preserves %s after LaunchServer loads during a page reload',
    (path) => {
      expect(resolveLaunchServerRedirect(path, true)).toBeNull()
    },
  )

  test('keeps the public page available after a server is configured', () => {
    expect(resolveLaunchServerRedirect('/', true)).toBeNull()
  })

  test('returns the empty setup route to the public page', () => {
    expect(resolveLaunchServerRedirect('/setup', false)).toBe('/')
    expect(resolveLaunchServerRedirect('/', false)).toBeNull()
  })
})
