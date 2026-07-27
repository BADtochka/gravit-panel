import { VueQueryPlugin } from '@tanstack/vue-query'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'
import { initializeTheme } from './lib/theme'
import { router } from './router'

initializeTheme()
createApp(App).use(createPinia()).use(VueQueryPlugin).use(router).mount('#app')
