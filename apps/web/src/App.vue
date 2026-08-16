<template>
  <div class="min-h-screen bg-background text-foreground">
    <Toaster
      class="pointer-events-auto"
      position="bottom-right"
      :theme="theme"
      rich-colors
      close-button
    />
    <JobNotificationCenter />
    <div v-if="authLoading && !route.meta.public" class="grid min-h-screen place-items-center">
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle class="size-4 animate-spin" />
        Checking access…
      </div>
    </div>

    <main v-else-if="bootError && !route.meta.public" class="grid min-h-screen place-items-center p-4">
      <section class="w-full max-w-md rounded-xl border border-destructive/30 bg-card p-6 shadow-sm">
        <TriangleAlert class="size-5 text-destructive" />
        <h1 class="mt-3 text-xl font-semibold">Panel failed to load</h1>
        <p class="mt-2 text-sm text-muted-foreground">{{ bootError.message }}</p>
        <Button class="mt-5" :disabled="bootRetrying" @click="retryBoot">
          <LoaderCircle v-if="bootRetrying" class="animate-spin" />
          <RefreshCw v-else />
          Retry
        </Button>
      </section>
    </main>

    <main v-else-if="loginRequired && !route.meta.public" class="grid min-h-screen place-items-center p-4">
      <section class="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm">
        <p class="text-sm font-medium text-muted-foreground">Gravit Panel</p>
        <h1 class="mt-2 text-2xl font-semibold tracking-tight">Sign in to continue</h1>
        <p class="mt-3 text-sm leading-6 text-muted-foreground">
          This panel is restricted to Discord accounts approved by its administrator.
        </p>
        <p v-if="authErrorMessage" class="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {{ authErrorMessage }}
        </p>
        <Button as="a" :href="panelLoginUrl" class="mt-6 w-full">
          Continue with Discord
        </Button>
      </section>
    </main>

    <div v-else-if="launchServerLoading && !route.meta.public" class="grid min-h-screen place-items-center">
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle class="size-4 animate-spin" />
        Loading LaunchServer…
      </div>
    </div>

    <main v-else-if="route.meta.public" class="min-h-screen">
      <RouterView />
    </main>

    <main v-else-if="!hasLaunchServer" class="min-h-screen p-4 md:p-8">
      <div class="mx-auto max-w-7xl">
        <SelfUpdateBanner />
        <RouterView />
      </div>
    </main>

    <template v-else>
      <aside class="fixed inset-y-0 left-0 hidden w-64 border-r bg-card md:block">
        <div class="flex h-16 items-center gap-3 border-b px-4">
          <img
            :src="panelUrl('/gravit-panel-icon.png')"
            alt=""
            class="size-10 shrink-0 rounded-xl"
            aria-hidden="true"
          />
          <div class="min-w-0">
            <p class="text-sm font-semibold">Gravit Panel</p>
            <p class="text-xs text-muted-foreground">Admin workspace</p>
          </div>
        </div>
        <div class="flex h-[calc(100vh-4rem)] flex-col">
          <div class="min-h-0 flex-1 overflow-y-auto">
            <ProfileSwitcher v-if="dashboardMode === 'client'" class="border-b p-3" />
            <ServerSwitcher v-else class="border-b p-3" />
            <nav class="p-3">
              <p class="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">{{ activeNavGroup.label }}</p>
              <div class="space-y-1">
            <RouterLink
              v-for="item in activeNavGroup.items"
              :key="item.to"
              :to="navTarget(item)"
              class="flex cursor-pointer items-center rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              :class="{ 'bg-accent text-accent-foreground': navItemActive(item) }"
            >
              <component :is="item.icon" class="mr-3 size-4" aria-hidden="true" />
              {{ item.label }}
            </RouterLink>
              </div>
            </nav>
          </div>
          <div class="border-t p-3">
            <Button
              class="mb-1 w-full justify-start"
              :variant="route.path === '/panel/mods' ? 'secondary' : 'ghost'"
              @click="openMods"
            >
              <PackageSearch />Mods
            </Button>
            <Button
              class="mb-2 w-full justify-start"
              :variant="route.path === '/panel/jobs' ? 'secondary' : 'ghost'"
              @click="openJobs"
            >
              <ListChecks />Jobs
            </Button>
            <Button class="w-full justify-start" variant="outline" @click="switchDashboard">
              <ServerCog v-if="dashboardMode === 'client'" />
              <Boxes v-else />
              {{ dashboardMode === 'client' ? 'Open server panel' : 'Open client panel' }}
              <ArrowRightLeft class="ml-auto size-4 text-muted-foreground" />
            </Button>
          </div>
        </div>
      </aside>

      <main class="md:pl-64">
        <header class="flex h-16 items-center justify-between gap-3 border-b px-4 md:px-8">
          <div class="flex min-w-0 items-center gap-3">
            <Sheet v-model:open="mobileNavOpen">
              <SheetTrigger as-child>
                <Button
                  class="shrink-0 md:hidden"
                  variant="outline"
                  size="icon"
                  type="button"
                  title="Open navigation"
                  aria-label="Open navigation"
                >
                  <Menu class="size-4" aria-hidden="true" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" class="w-72 gap-0 p-0 sm:max-w-72">
                <SheetHeader class="flex h-16 flex-row items-center gap-3 border-b px-4 text-left">
                  <img
                    :src="panelUrl('/gravit-panel-icon.png')"
                    alt=""
                    class="size-10 shrink-0 rounded-xl"
                    aria-hidden="true"
                  />
                  <div class="min-w-0">
                    <SheetTitle class="text-sm">Gravit Panel</SheetTitle>
                    <SheetDescription class="text-xs">Admin workspace</SheetDescription>
                  </div>
                </SheetHeader>
                <div class="flex min-h-0 flex-1 flex-col">
                  <div class="min-h-0 flex-1 overflow-y-auto">
                    <ProfileSwitcher v-if="dashboardMode === 'client'" class="border-b p-3" @selected="mobileNavOpen = false" />
                    <ServerSwitcher v-else class="border-b p-3" @selected="mobileNavOpen = false" />
                    <nav class="p-3">
                      <p class="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">{{ activeNavGroup.label }}</p>
                      <div class="space-y-1">
                    <RouterLink
                      v-for="item in activeNavGroup.items"
                      :key="item.to"
                      :to="navTarget(item)"
                      class="flex cursor-pointer items-center rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      :class="{ 'bg-accent text-accent-foreground': navItemActive(item) }"
                      @click="mobileNavOpen = false"
                    >
                      <component :is="item.icon" class="mr-3 size-4" aria-hidden="true" />
                      {{ item.label }}
                    </RouterLink>
                      </div>
                    </nav>
                  </div>
                  <div class="border-t p-3">
                    <Button
                      class="mb-1 w-full justify-start"
                      :variant="route.path === '/panel/mods' ? 'secondary' : 'ghost'"
                      @click="openMods"
                    >
                      <PackageSearch />Mods
                    </Button>
                    <Button
                      class="mb-2 w-full justify-start"
                      :variant="route.path === '/panel/jobs' ? 'secondary' : 'ghost'"
                      @click="openJobs"
                    >
                      <ListChecks />Jobs
                    </Button>
                    <Button class="w-full justify-start" variant="outline" @click="switchDashboard">
                      <ServerCog v-if="dashboardMode === 'client'" />
                      <Boxes v-else />
                      {{ dashboardMode === 'client' ? 'Open server panel' : 'Open client panel' }}
                      <ArrowRightLeft class="ml-auto size-4 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
            <div class="min-w-0">
              <h1 class="truncate text-base font-semibold">
                LaunchServer
              </h1>
              <p class="hidden truncate text-xs text-muted-foreground sm:block">
                {{ launchServer?.projectName }} · {{ launchServer?.address }}
              </p>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Button
              v-if="panelUpdate"
              variant="outline"
              size="icon"
              type="button"
              title="Check for panel updates"
              aria-label="Check for panel updates"
              :disabled="checkingPanelUpdate"
              @click="checkPanelUpdate"
            >
              <RefreshCw class="size-4" :class="{ 'animate-spin': checkingPanelUpdate }" aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              type="button"
              :title="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
              :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
              @click="toggleTheme"
            >
              <Sun v-if="theme === 'dark'" class="size-4" aria-hidden="true" />
              <Moon v-else class="size-4" aria-hidden="true" />
            </Button>
            <span class="hidden rounded-md border px-2 py-1 text-xs text-muted-foreground sm:inline">
              {{ panelAuth?.user?.globalName ?? panelAuth?.user?.username ?? 'Local' }}
            </span>
            <Button
              v-if="panelAuth?.enabled"
              variant="outline"
              size="sm"
              type="button"
              @click="logout"
            >
              Sign out
            </Button>
          </div>
        </header>

        <div class="p-4 md:p-8">
          <SelfUpdateBanner />
          <RouterView />
        </div>
      </main>
    </template>
  </div>
</template>

<script setup lang="ts">
import JobNotificationCenter from '@/components/jobs/JobNotificationCenter.vue'
import ProfileSwitcher from '@/components/layout/ProfileSwitcher.vue'
import SelfUpdateBanner from '@/components/layout/SelfUpdateBanner.vue'
import ServerSwitcher from '@/components/layout/ServerSwitcher.vue'
import { Button } from '@/components/ui/button'
import { usePanelSelfUpdate } from '@/composables/usePanelSelfUpdate'
import { Toaster } from '@/components/ui/sonner'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { resolveLaunchServerRedirect } from '@/lib/launchserver-routing'
import { panelFetch, panelUrl } from '@/lib/public-path'
import { useTheme } from '@/lib/theme'
import { useLaunchServerStore } from '@/stores/launchserver'
import { useJobsStore } from '@/stores/jobs'
import type { GravitInstallation } from '@gravit-panel/shared'
import { useQuery } from '@tanstack/vue-query'
import {
  Activity,
  ArrowRightLeft,
  Blocks,
  Boxes,
  KeyRound,
  ListChecks,
  LoaderCircle,
  Menu,
  Moon,
  PackageSearch,
  FilePenLine,
  Files,
  Gauge,
  Rocket,
  RefreshCw,
  ServerCog,
  SquareTerminal,
  Sun,
  TriangleAlert,
  Users,
} from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import 'vue-sonner/style.css'

interface LaunchServerResponse {
  item: GravitInstallation | null
}

interface PanelAuthSession {
  enabled: boolean
  configured: boolean
  authenticated: boolean
  user: {
    discordId: string
    username: string
    globalName: string | null
    avatarHash: string | null
  } | null
}

const { theme, toggleTheme } = useTheme()
const launchServerStore = useLaunchServerStore()
const { launchServer } = storeToRefs(launchServerStore)
const mobileNavOpen = ref(false)
const route = useRoute()
const router = useRouter()
const { data: panelUpdate, isFetching: checkingPanelUpdate, checkNow: checkPanelUpdateNow } = usePanelSelfUpdate()
const checkPanelUpdate = () => void checkPanelUpdateNow()
const jobsStore = useJobsStore()
type DashboardMode = 'client' | 'server'
const dashboardMode = ref<DashboardMode>(
  typeof window !== 'undefined' && window.localStorage.getItem('gravit-panel:dashboard-mode') === 'server'
    ? 'server'
    : 'client',
)

const getPanelAuthSession = async () => {
  const response = await panelFetch('/api/panel-auth/session', { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Authentication request failed with status ${response.status}`)
  return response.json() as Promise<PanelAuthSession>
}

const { data: panelAuth, error: panelAuthError, isLoading: authLoading, isFetching: authFetching, refetch: refetchPanelAuth } = useQuery({
  queryKey: ['panel-auth-session'],
  queryFn: getPanelAuthSession,
  retry: false,
})
const loginRequired = computed(
  () => Boolean(panelAuth.value?.enabled) && !panelAuth.value?.authenticated,
)
const panelLoginUrl = computed(
  () => `${panelUrl('/api/panel-auth/login')}?returnTo=${encodeURIComponent(route.fullPath)}`,
)
const authErrorMessage = computed(() => {
  const error = route.query.authError
  if (error === 'not-authorized') return 'This Discord account is not on the access list.'
  if (error === 'state') return 'The sign-in request expired. Please try again.'
  if (error === 'configuration') return 'Discord sign-in is not configured yet.'
  if (error === 'discord') return 'Discord sign-in failed. Please try again.'
  return null
})

const logout = async () => {
  await panelFetch('/api/panel-auth/logout', { method: 'POST' })
  window.location.assign(panelUrl(route.fullPath))
}

const getLaunchServer = async () => {
  const response = await panelFetch('/api/docker/launchserver', { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`LaunchServer request failed with status ${response.status}`)
  return response.json() as Promise<LaunchServerResponse>
}

const { data, error: launchServerError, isLoading: launchServerLoading, isFetching: launchServerFetching, refetch: refetchLaunchServer } = useQuery({
  queryKey: ['docker-launchserver'],
  queryFn: getLaunchServer,
  enabled: computed(
    () => panelAuth.value !== undefined && (!panelAuth.value.enabled || panelAuth.value.authenticated),
  ),
  retry: false,
})
const bootError = computed(() => (panelAuthError.value || launchServerError.value) as Error | null)
const bootRetrying = computed(() => authFetching.value || launchServerFetching.value)
const retryBoot = async () => {
  if (panelAuthError.value) {
    const result = await refetchPanelAuth()
    if (result.data?.enabled && !result.data.authenticated) return
  }
  await refetchLaunchServer()
}
watch(
  [() => data.value?.item, () => route.path],
  ([item, path]) => {
    if (item === undefined) return
    launchServerStore.setLaunchServer(item)
    const redirect = resolveLaunchServerRedirect(path, Boolean(item))
    if (redirect) void router.replace(redirect)
  },
  { immediate: true },
)
const hasLaunchServer = computed(() => Boolean(launchServer.value))

interface NavItem { to: string; label: string; icon: unknown }
const navGroups: Array<{ label: string; items: NavItem[] }> = [
  { label: 'Client & Launcher', items: [
    { to: '/panel/status', label: 'Status', icon: Activity },
    { to: '/panel/modules', label: 'Modules', icon: Blocks },
    { to: '/panel/files', label: 'Files', icon: Files },
    { to: '/panel/auth', label: 'Auth', icon: KeyRound },
    { to: '/panel/users', label: 'Users', icon: Users },
    { to: '/panel/launcher', label: 'Launcher', icon: Rocket },
    { to: '/panel/clients', label: 'Clients', icon: Boxes },
    { to: '/panel/public-settings', label: 'Public page', icon: FilePenLine },
  ] },
  { label: 'Server', items: [
    { to: '/panel/server/overview', label: 'Overview', icon: Gauge },
    { to: '/panel/server/console', label: 'Console', icon: SquareTerminal },
    { to: '/panel/server/files', label: 'Files & Mods', icon: Files },
    { to: '/panel/server/deployment', label: 'Deployment', icon: ServerCog },
  ] },
]
const activeNavGroup = computed(() => navGroups[dashboardMode.value === 'client' ? 0 : 1]!)
const navTarget = (item: NavItem) => item.to
const navItemActive = (item: NavItem) => route.path === item.to
const openJobs = () => {
  jobsStore.openFor(dashboardMode.value)
  mobileNavOpen.value = false
  void router.push('/panel/jobs')
}
const openMods = () => {
  mobileNavOpen.value = false
  void router.push('/panel/mods')
}
const switchDashboard = () => {
  dashboardMode.value = dashboardMode.value === 'client' ? 'server' : 'client'
  window.localStorage.setItem('gravit-panel:dashboard-mode', dashboardMode.value)
  mobileNavOpen.value = false
  void router.push(dashboardMode.value === 'server'
    ? '/panel/server/overview'
    : '/panel/status')
}
watch(() => route.path, (path) => {
  if (path === '/panel/jobs' || path === '/panel/mods') return
  const nextMode: DashboardMode = path.startsWith('/panel/server/') ? 'server' : 'client'
  if (dashboardMode.value === nextMode) return
  dashboardMode.value = nextMode
  window.localStorage.setItem('gravit-panel:dashboard-mode', nextMode)
}, { immediate: true })
</script>
