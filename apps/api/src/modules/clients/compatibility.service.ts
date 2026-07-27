import type { ClientCompatibility } from '@gravit-panel/shared'
import { mirrorHelperSource } from './client-sources'

const parseVersion = (value: string) => {
  const parts = value.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.some((part) => !Number.isFinite(part))) {
    throw new Error('Minecraft version must contain numeric dot-separated components')
  }
  return parts
}

const compareVersions = (left: string, right: string) => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export const resolveClientCompatibility = (minecraftVersion: string): ClientCompatibility => {
  let authlibArtifact: string
  if (compareVersions(minecraftVersion, '1.16.5') < 0) {
    authlibArtifact = 'LauncherAuthlib1.jar'
  } else if (compareVersions(minecraftVersion, '1.18') < 0) {
    authlibArtifact = 'LauncherAuthlib2.jar'
  } else if (compareVersions(minecraftVersion, '1.19') < 0) {
    authlibArtifact = 'LauncherAuthlib3.jar'
  } else if (compareVersions(minecraftVersion, '1.19') === 0) {
    authlibArtifact = 'LauncherAuthlib3-1.19.jar'
  } else if (compareVersions(minecraftVersion, '1.20') < 0) {
    authlibArtifact = 'LauncherAuthlib3-1.19.1.jar'
  } else if (compareVersions(minecraftVersion, '1.20.2') < 0) {
    authlibArtifact = 'LauncherAuthlib4.jar'
  } else if (compareVersions(minecraftVersion, '1.20.3') < 0) {
    authlibArtifact = 'LauncherAuthlib5.jar'
  } else if (compareVersions(minecraftVersion, '1.21.9') < 0) {
    authlibArtifact = 'LauncherAuthlib6.jar'
  } else if (compareVersions(minecraftVersion, '26.2') < 0) {
    authlibArtifact = 'LauncherAuthlib7.jar'
  } else {
    authlibArtifact = 'LauncherAuthlib9.jar'
  }

  return {
    minecraftVersion,
    requiresPatchedAuthlib: true,
    authlibArtifact,
    source: mirrorHelperSource,
  }
}
