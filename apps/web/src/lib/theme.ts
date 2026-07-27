import { ref } from 'vue'

export type ColorTheme = 'light' | 'dark'

const storageKey = 'gravit-panel-theme'

const getInitialTheme = (): ColorTheme => {
  const stored = localStorage.getItem(storageKey)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const theme = ref<ColorTheme>(getInitialTheme())

const applyTheme = (value: ColorTheme) => {
  document.documentElement.classList.toggle('dark', value === 'dark')
  document.documentElement.style.colorScheme = value
}

export const initializeTheme = () => applyTheme(theme.value)

export const useTheme = () => ({
  theme,
  toggleTheme: () => {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
    localStorage.setItem(storageKey, theme.value)
    applyTheme(theme.value)
  },
})
