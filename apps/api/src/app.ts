import { cors } from '@elysiajs/cors'
import { swagger } from '@elysiajs/swagger'
import { Elysia } from 'elysia'
import { env } from './core/env'
import { authRoutes } from './modules/auth/auth.routes'
import { clientsRoutes } from './modules/clients/clients.routes'
import { dockerRoutes } from './modules/docker/docker.routes'
import { gravitRoutes } from './modules/gravit/gravit.routes'
import { jobsRoutes } from './modules/jobs/jobs.routes'
import { modsRoutes } from './modules/mods/mods.routes'
import { modulesRoutes } from './modules/modules/modules.routes'
import { createPanelAuthGuard, createPanelAuthRoutes } from './modules/panel-auth/panel-auth.routes'
import { panelAuthService } from './modules/panel-auth/panel-auth.runtime'
import { setupRoutes } from './modules/setup/setup.routes'

export const app = new Elysia({ prefix: '/api' })
  .use(
    cors({
      origin: env.CORS_ORIGINS,
    }),
  )
  .onBeforeHandle(createPanelAuthGuard(panelAuthService))
  .use(
    swagger({
      documentation: {
        info: {
          title: 'Gravit Panel API',
          version: '0.1.0',
        },
      },
    }),
  )
  .get('/health', () => ({
    service: 'gravit-panel-api',
    status: 'ok',
    version: '0.1.0',
    time: new Date().toISOString(),
  }))
  .use(createPanelAuthRoutes(panelAuthService))
  .use(setupRoutes)
  .use(dockerRoutes)
  .use(authRoutes)
  .use(gravitRoutes)
  .use(jobsRoutes)
  .use(modulesRoutes)
  .use(clientsRoutes)
  .use(modsRoutes)

export type App = typeof app
