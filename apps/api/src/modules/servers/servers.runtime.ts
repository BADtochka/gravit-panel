import { env } from '../../core/env'
import { database } from '../../db/client'
import { clientBuildService } from '../clients/clients.routes'
import { controlFileService } from '../gravit/gravit.runtime'
import { ModrinthService } from '../mods/modrinth.service'
import { ServerBindingService } from './server-binding.service'
import { ServerBindingsStore } from './server-bindings.store'
import { ServerPackService } from './server-pack.service'
import { ServerPackStore } from './server-pack.store'
import { ServerBootstrapStore } from './server-bootstrap.store'
import { ServerBootstrapService } from './server-bootstrap.service'

export const serverBindingsStore = new ServerBindingsStore(database)
export const serverPackStore = new ServerPackStore(database)
export const serverBootstrapStore = new ServerBootstrapStore(database)
export const serverModrinthService = new ModrinthService()
export const serverBindingService = new ServerBindingService(
  serverBindingsStore,
  clientBuildService,
)
export const serverPackService = new ServerPackService(
  serverPackStore,
  serverBindingsStore,
  clientBuildService,
  serverModrinthService,
)
export const serverBootstrapService = new ServerBootstrapService(
  serverBootstrapStore,
  serverBindingsStore,
  serverPackStore,
  clientBuildService,
  controlFileService,
  env.PANEL_PUBLIC_URL,
)
