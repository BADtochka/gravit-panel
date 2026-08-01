import { app } from './app'
import { env } from './core/env'
import { logger } from './core/logger'
import { javaRuntimes } from './modules/clients/clients.routes'
import { LauncherDockeredService } from './modules/docker/launcherdockered.service'
import { LaunchServerStartupService } from './modules/docker/launchserver-startup.service'
import { installationsStore } from './modules/gravit/gravit.runtime'

app.listen({
  hostname: env.HOST,
  port: env.PORT,
})

logger.info(`API listening on http://${env.HOST}:${env.PORT}`)

const launchServerStartup = new LaunchServerStartupService(
  installationsStore,
  new LauncherDockeredService(env.INSTALLATIONS_ROOT, undefined, undefined, env.LAUNCHSERVER_PUBLIC_URL),
  javaRuntimes,
)
void launchServerStartup.recoverUnhealthyInstallations().catch((error) => {
  logger.error('LaunchServer startup recovery could not inspect installations', error)
})
