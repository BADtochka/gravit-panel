import { createRouter, createWebHistory } from 'vue-router'
import AuthView from './views/AuthView.vue'
import ClientsView from './views/ClientsView.vue'
import JobsView from './views/JobsView.vue'
import LauncherView from './views/LauncherView.vue'
import ModsView from './views/ModsView.vue'
import ModulesView from './views/ModulesView.vue'
import ProfileCreationView from './views/ProfileCreationView.vue'
import StatusView from './views/StatusView.vue'
import UsersView from './views/UsersView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'profile-creation', component: ProfileCreationView },
    { path: '/status', component: StatusView },
    { path: '/jobs', component: JobsView },
    { path: '/modules', component: ModulesView },
    { path: '/auth', component: AuthView },
    { path: '/users', component: UsersView },
    { path: '/launcher', component: LauncherView },
    { path: '/clients', component: ClientsView },
    { path: '/mods', component: ModsView },
  ],
})
