import { app } from './app'
import { env } from './core/env'
import { logger } from './core/logger'

app.listen({
  hostname: env.HOST,
  port: env.PORT,
})

logger.info(`API listening on http://${env.HOST}:${env.PORT}`)
