import { createRouter, createWebHistory } from 'vue-router'
import AuthView from './views/AuthView.vue'
import ClientsView from './views/ClientsView.vue'
import JobsView from './views/JobsView.vue'
import LauncherView from './views/LauncherView.vue'
import LaunchServerSetupView from './views/LaunchServerSetupView.vue'
import ModsView from './views/ModsView.vue'
import ServersView from './views/ServersView.vue'
import ModulesView from './views/ModulesView.vue'
import StatusView from './views/StatusView.vue'
import UsersView from './views/UsersView.vue'
import PublicHomeView from './views/PublicHomeView.vue'
import PlayerCabinetView from './views/PlayerCabinetView.vue'
import PublicPageSettingsView from './views/PublicPageSettingsView.vue'
import LaunchServerFilesView from './views/LaunchServerFilesView.vue'
import { panelPublicPath } from './lib/public-path'

export const router = createRouter({
  history: createWebHistory(panelPublicPath || '/'),
  routes: [
    { path: '/', name: 'public-home', component: PublicHomeView, meta: { public: true } },
    { path: '/account', component: PlayerCabinetView, meta: { public: true } },
    { path: '/panel', redirect: '/panel/status' },
    { path: '/panel/public-settings', component: PublicPageSettingsView },
    { path: '/panel/setup', name: 'launchserver-setup', component: LaunchServerSetupView },
    { path: '/panel/status', component: StatusView },
    { path: '/panel/jobs', component: JobsView },
    { path: '/panel/modules', component: ModulesView },
    { path: '/panel/files', component: LaunchServerFilesView },
    { path: '/panel/auth', component: AuthView },
    { path: '/panel/users', component: UsersView },
    { path: '/panel/launcher', component: LauncherView },
    { path: '/panel/clients', component: ClientsView },
    { path: '/panel/mods', component: ModsView },
    { path: '/panel/servers', redirect: '/panel/server/overview' },
    { path: '/panel/server/overview', component: ServersView, meta: { serverSection: 'overview' } },
    { path: '/panel/server/console', component: ServersView, meta: { serverSection: 'console' } },
    { path: '/panel/server/files', component: ServersView, meta: { serverSection: 'files' } },
    { path: '/panel/server/mods', redirect: '/panel/server/files' },
    { path: '/panel/server/deployment', component: ServersView, meta: { serverSection: 'deployment' } },
  ],
})
