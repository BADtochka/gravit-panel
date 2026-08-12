import { describe, expect, test } from 'bun:test'
import { resolveLaunchServerRedirect } from '../src/lib/launchserver-routing'

describe('LaunchServer-aware routing', () => {
  test.each(['/panel/clients', '/panel/servers', '/panel/launcher', '/panel/mods', '/panel/modules', '/panel/auth', '/panel/jobs'])(
    'preserves %s after LaunchServer loads during a page reload',
    (path) => {
      expect(resolveLaunchServerRedirect(path, true)).toBeNull()
    },
  )

  test('keeps the public page available after a server is configured', () => {
    expect(resolveLaunchServerRedirect('/', true)).toBeNull()
  })

  test('sends protected panel routes to setup when no server exists', () => {
    expect(resolveLaunchServerRedirect('/panel/status', false)).toBe('/panel/setup')
    expect(resolveLaunchServerRedirect('/panel/setup', false)).toBeNull()
    expect(resolveLaunchServerRedirect('/', false)).toBeNull()
  })

  test('returns setup to panel status after installation', () => {
    expect(resolveLaunchServerRedirect('/panel/setup', true)).toBe('/panel/status')
  })
})
