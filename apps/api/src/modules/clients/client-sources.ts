import type { SourcePin } from '@gravit-panel/shared'

export const launcherBuildSource = {
  repository: 'https://github.com/GravitLauncher/Launcher',
  revision: 'fef9bae63da1afc0518d32e3333db20f409ab196',
  file: 'components/launchserver/src/main/java/pro/gravit/launchserver/command/basic/BuildCommand.java',
} as const satisfies SourcePin

export const launcherRuntimeRelease = {
  repository: 'https://github.com/GravitLauncher/LauncherRuntime',
  tag: 'v5.0.7',
  revision: '755e5509b1f573817a977b4180a2f84517619025',
  compatibleLauncherVersion: '5.7.9',
  module: {
    filename: 'JavaRuntime.jar',
    url:
      'https://github.com/GravitLauncher/LauncherRuntime/releases/download/v5.0.7/JavaRuntime.jar',
    sha256: 'ba760774908c519d2de1ec9322336709cda54395f0f9ae9d4f606309d628b710',
  },
  resources: {
    filename: 'runtime.zip',
    directory: 'runtime',
    url:
      'https://github.com/GravitLauncher/LauncherRuntime/releases/download/v5.0.7/runtime.zip',
    sha256: '905b3345fb642c39ae368b4ef82c2c1740bf54e28d0ea436322b15071a891c27',
  },
} as const

export const mirrorHelperSource = {
  repository: 'https://github.com/GravitLauncher/LauncherModules',
  revision: '0fcdfade1960c353a9f0bbb2f92055f05e22867d',
  file:
    'MirrorHelper_module/src/main/java/pro/gravit/launchermodules/mirrorhelper/InstallClient.java',
} as const satisfies SourcePin

export const workspaceManifest = {
  url: 'https://mirror.gravitlauncher.com/5.7.x/workspace.json',
  sha256: '51772ff2d1f3326862ca2cfa8f6e91d3d86a0406cd65a4eb0abaa114b43b7728',
  source: mirrorHelperSource,
} as const

export const prestarterRelease = {
  repository: 'https://github.com/GravitLauncher/LauncherPrestarter',
  tag: 'v2.1.0',
  revision: '94bcc6949c1e4b7aec37bd1d00515203e2772bcb',
  asset: 'Prestarter.exe',
  url:
    'https://github.com/GravitLauncher/LauncherPrestarter/releases/download/v2.1.0/Prestarter.exe',
  sha256: 'e206a35615b91ae21a13154b7cb4dda9c742a2a45211880e79100bb09636de7f',
} as const
