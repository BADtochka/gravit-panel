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
import { panelPublicPath } from './lib/public-path'

export const router = createRouter({
  history: createWebHistory(panelPublicPath || '/'),
  routes: [
    { path: '/', name: 'public-home', component: PublicHomeView, meta: { public: true } },
    { path: '/account', component: PlayerCabinetView, meta: { public: true } },
    { path: '/public-settings', component: PublicPageSettingsView },
    { path: '/setup', name: 'launchserver-setup', component: LaunchServerSetupView },
    { path: '/status', component: StatusView },
    { path: '/jobs', component: JobsView },
    { path: '/modules', component: ModulesView },
    { path: '/auth', component: AuthView },
    { path: '/users', component: UsersView },
    { path: '/launcher', component: LauncherView },
    { path: '/clients', component: ClientsView },
    { path: '/mods', component: ModsView },
    { path: '/servers', component: ServersView },
  ],
})
