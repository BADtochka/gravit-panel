import { workspaceApps } from '@gravit-panel/shared'
import { Elysia } from 'elysia'

export const setupRoutes = new Elysia({ prefix: '/setup' })
  .get('/plan', () => ({
    currentSlice: 'mvp-complete',
    completedSlices: [
      'workspace-scaffold',
      'jobs',
      'docker-preflight',
      'launcherdockered-install',
      'launchserver-command-transport',
      'remote-control',
      'modules',
      'side-project-compatibility',
      'launcher-build',
      'client-build',
      'mod-manager',
      'file-auth-recipe',
      'existing-server-attach',
      'profile-aware-layout',
    ],
    nextSlices: [],
  }))
  .get('/apps', () => workspaceApps)
