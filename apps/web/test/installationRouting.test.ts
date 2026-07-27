import { describe, expect, test } from 'bun:test'
import { resolveInstallationRedirect } from '../src/lib/installation-routing'

describe('installation-aware routing', () => {
  test.each(['/clients', '/launcher', '/mods', '/modules', '/auth', '/jobs'])(
    'preserves %s after installations load during a page reload',
    (path) => {
      expect(resolveInstallationRedirect(path, 1)).toBeNull()
    },
  )

  test('opens status only when an installed workspace lands on the creation route', () => {
    expect(resolveInstallationRedirect('/', 1)).toBe('/status')
  })

  test('opens profile creation when no installations exist', () => {
    expect(resolveInstallationRedirect('/clients', 0)).toBe('/')
    expect(resolveInstallationRedirect('/', 0)).toBeNull()
  })
})
