import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { reconcileInstallationSelection } from '../src/stores/installations'

const installation = (id: string): GravitInstallation => ({
  id,
  name: id,
  path: `/srv/${id}`,
  address: 'localhost:17549',
  projectName: id.toUpperCase(),
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: '2026-07-27T12:00:00.000Z',
  updatedAt: '2026-07-27T12:00:00.000Z',
})

describe('installation selection reconciliation', () => {
  test('preserves a selected profile that still exists', () => {
    expect(
      reconcileInstallationSelection('secondary', [
        installation('primary'),
        installation('secondary'),
      ]),
    ).toBe('secondary')
  })

  test('selects the first profile when the previous selection is missing', () => {
    expect(reconcileInstallationSelection('missing', [installation('primary')])).toBe('primary')
    expect(reconcileInstallationSelection('missing', [])).toBe('')
  })
})
