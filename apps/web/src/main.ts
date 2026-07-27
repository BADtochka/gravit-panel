import { VueQueryPlugin } from '@tanstack/vue-query'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'
import { installPanelFetchRouting } from './lib/public-path'
import { initializeTheme } from './lib/theme'
import { router } from './router'

initializeTheme()
installPanelFetchRouting()
createApp(App).use(createPinia()).use(VueQueryPlugin).use(router).mount('#app')
