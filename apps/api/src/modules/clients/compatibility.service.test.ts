import { describe, expect, test } from 'bun:test'
import { resolveClientCompatibility } from './compatibility.service'

describe('resolveClientCompatibility', () => {
  test.each([
    ['1.16.4', 'LauncherAuthlib1.jar'],
    ['1.16.5', 'LauncherAuthlib2.jar'],
    ['1.18.2', 'LauncherAuthlib3.jar'],
    ['1.19', 'LauncherAuthlib3-1.19.jar'],
    ['1.19.4', 'LauncherAuthlib3-1.19.1.jar'],
    ['1.20.1', 'LauncherAuthlib4.jar'],
    ['1.20.2', 'LauncherAuthlib5.jar'],
    ['1.21.8', 'LauncherAuthlib6.jar'],
    ['1.21.9', 'LauncherAuthlib7.jar'],
    ['26.2', 'LauncherAuthlib9.jar'],
  ])('maps Minecraft %s to %s from MirrorHelper source', (version, artifact) => {
    const result = resolveClientCompatibility(version)
    expect(result.authlibArtifact).toBe(artifact)
    expect(result.requiresPatchedAuthlib).toBe(true)
    expect(result.source.revision).toHaveLength(40)
  })
})

