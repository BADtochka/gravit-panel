import { Elysia, t } from 'elysia'
import { env } from '../../core/env'
import {
  SelfUpdateConflictError,
  SelfUpdateService,
  SelfUpdateUnavailableError,
} from './self-update.service'

export const selfUpdateService = new SelfUpdateService({
  currentRevision: env.PANEL_REVISION,
  repository: env.PANEL_UPDATE_REPOSITORY,
  githubToken: env.PANEL_UPDATE_GITHUB_TOKEN,
  coolifyApiUrl: env.COOLIFY_API_URL,
  coolifyApiToken: env.COOLIFY_API_TOKEN,
  coolifyApplicationUuid: env.COOLIFY_APPLICATION_UUID,
})

export const selfUpdateRoutes = new Elysia({ prefix: '/self-update' })
  .get('/', ({ query }) => selfUpdateService.status(query.force === 'true'), {
    query: t.Object({ force: t.Optional(t.String()) }),
  })
  .post('/deploy', async ({ set }) => {
    try {
      set.status = 202
      return await selfUpdateService.deploy()
    } catch (error) {
      set.status = error instanceof SelfUpdateUnavailableError
        ? 503
        : error instanceof SelfUpdateConflictError
          ? 409
          : 502
      return { message: error instanceof Error ? error.message : String(error) }
    }
  })
