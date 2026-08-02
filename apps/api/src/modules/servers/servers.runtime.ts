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
import { ServerAgentStore } from './server-agent.store'
import { ServerAgentEventHub } from './server-agent.events'
import { ServerAgentService } from './server-agent.service'
import { ServerBrowserEventsService } from './server-browser-events.service'

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
  env.LAUNCHSERVER_PUBLIC_URL,
)
export const serverAgentStore = new ServerAgentStore(database)
export const serverAgentEvents = new ServerAgentEventHub()
export const serverBrowserEventsService = new ServerBrowserEventsService(
  serverAgentStore,
  serverAgentEvents,
)
export const serverAgentService = new ServerAgentService(
  serverAgentStore,
  serverAgentEvents,
  (token) => {
    const binding = serverBootstrapService.updaterBinding(token)
    return binding?.id ? { id: binding.id } : null
  },
)
