<template>
  <section class="space-y-6">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">Authentication</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Configure LaunchServer auth cores from the verified built-in recipes.
      </p>
    </div>

    <Alert v-if="pageError" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Authentication operation failed</AlertTitle>
      <AlertDescription>{{ pageError.message }}</AlertDescription>
    </Alert>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card>
        <CardHeader>
          <CardTitle class="text-base">Provider recipe</CardTitle>
          <CardDescription>
            Snapshots LaunchServer.json before writing. FileAuthSystem uses the install command;
            other cores restart LaunchServer after the write.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="text-xs font-medium" for="auth-provider">Target auth id</label>
              <Select v-model="authId">
                <SelectTrigger id="auth-provider" class="mt-1 w-full">
                  <SelectValue placeholder="Select auth provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="provider in configuration?.providers"
                    :key="provider.id"
                    :value="provider.id"
                  >
                    {{ provider.displayName }} · {{ provider.id }} · {{ provider.coreType }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label class="text-xs font-medium" for="auth-recipe">Core type</label>
              <Select v-model="recipeId">
                <SelectTrigger id="auth-recipe" class="mt-1 w-full">
                  <SelectValue placeholder="Select recipe" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="recipe in configuration?.recipes"
                    :key="recipe.id"
                    :value="recipe.id"
                  >
                    {{ recipe.title }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <p v-if="selectedRecipe" class="text-sm text-muted-foreground">
            {{ selectedRecipe.description }}
          </p>

          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="text-xs font-medium" for="auth-display-name">Display name</label>
              <Input id="auth-display-name" v-model="displayName" class="mt-1" />
            </div>
            <div class="flex items-end gap-4 pb-1">
              <label class="flex items-center gap-2 text-sm">
                <Checkbox :checked="isDefault" @update:checked="isDefault = Boolean($event)" />
                Default
              </label>
              <label class="flex items-center gap-2 text-sm">
                <Checkbox :checked="visible" @update:checked="visible = Boolean($event)" />
                Visible
              </label>
            </div>
          </div>

          <template v-if="recipeId === 'sql'">
            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label class="text-xs font-medium">SQL driver</label>
                <Select v-model="sqlDriver">
                  <SelectTrigger class="mt-1 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="postgresql">PostgreSQL</SelectItem>
                    <SelectItem value="mariadb">MariaDB</SelectItem>
                    <SelectItem value="mysql">MySQL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label class="text-xs font-medium">Password verifier</label>
                <Select v-model="sqlVerifier">
                  <SelectTrigger class="mt-1 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bcrypt">bcrypt</SelectItem>
                    <SelectItem value="digest">digest</SelectItem>
                    <SelectItem value="doubleDigest">doubleDigest</SelectItem>
                    <SelectItem value="phpass">phpass (AdditionalHash)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="sm:col-span-2">
                <label class="text-xs font-medium" for="sql-jdbc">JDBC URL</label>
                <Input id="sql-jdbc" v-model="sqlJdbcUrl" class="mt-1 font-mono text-xs" />
              </div>
              <div>
                <label class="text-xs font-medium" for="sql-user">DB username</label>
                <Input id="sql-user" v-model="sqlUsername" class="mt-1" />
              </div>
              <div>
                <label class="text-xs font-medium" for="sql-pass">DB password</label>
                <Input
                  id="sql-pass"
                  v-model="sqlPassword"
                  class="mt-1"
                  type="password"
                  :placeholder="sqlPasswordConfigured ? 'Configured (leave blank to keep)' : ''"
                />
              </div>
              <div>
                <label class="text-xs font-medium" for="sql-table">Users table</label>
                <Input id="sql-table" v-model="sqlTable" class="mt-1" />
              </div>
            </div>
          </template>

          <template v-else-if="recipeId === 'http'">
            <div class="grid gap-3">
              <Input v-model="http.userByUsername" class="font-mono text-xs" placeholder="userByUsername URL" />
              <Input v-model="http.userByUuid" class="font-mono text-xs" placeholder="userByUuid URL" />
              <Input v-model="http.userByToken" class="font-mono text-xs" placeholder="userByToken URL" />
              <Input v-model="http.refreshAccessToken" class="font-mono text-xs" placeholder="refreshAccessToken URL" />
              <Input v-model="http.authorize" class="font-mono text-xs" placeholder="authorize URL" />
              <Input v-model="http.checkServer" class="font-mono text-xs" placeholder="checkServer URL" />
              <Input v-model="http.joinServer" class="font-mono text-xs" placeholder="joinServer URL" />
              <Input
                v-model="httpBearer"
                class="font-mono text-xs"
                type="password"
                :placeholder="httpBearerConfigured ? 'Bearer configured (leave blank to keep)' : 'bearerToken'"
              />
            </div>
          </template>

          <template v-else-if="recipeId === 'merge'">
            <div class="space-y-2">
              <p class="text-xs text-muted-foreground">Select at least two existing providers.</p>
              <label
                v-for="provider in mergeCandidates"
                :key="provider.id"
                class="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  :checked="mergeList.includes(provider.id)"
                  @update:checked="toggleMerge(provider.id, Boolean($event))"
                />
                {{ provider.displayName }} · {{ provider.id }}
              </label>
            </div>
          </template>

          <Alert v-if="recipeId === 'memory'" variant="destructive">
            <TriangleAlert class="size-4" />
            <AlertTitle>Insecure for public servers</AlertTitle>
            <AlertDescription>
              Memory auth does not validate access tokens reliably and loses UUIDs on restart.
            </AlertDescription>
          </Alert>

          <Alert v-if="recipeId === 'discord'" variant="default">
            <AlertTitle>Discord OAuth</AlertTitle>
            <AlertDescription>
              Configure Discord OAuth in the modal. The DiscordAuthSystem module must be built and
              available in the LaunchServer image.
            </AlertDescription>
          </Alert>

          <div v-if="selectedRecipe" class="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p class="font-medium text-foreground">Verified source</p>
            <p class="mt-1 break-all font-mono">{{ selectedRecipe.source.repository }}</p>
            <p class="mt-1 break-all font-mono">{{ selectedRecipe.source.revision }}</p>
          </div>
        </CardContent>
        <CardFooter>
          <template v-if="recipeId === 'discord'">
            <Dialog v-model:open="discordModalOpen">
              <DialogTrigger as-child>
                <Button :disabled="!canApply">
                  <KeyRound />
                  Configure Discord OAuth
                </Button>
              </DialogTrigger>
              <DialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                  <DialogTitle>Discord OAuth configuration</DialogTitle>
                  <DialogDescription>
                    Settings are written to
                    <code class="rounded bg-muted px-1 py-0.5 text-xs">config/DiscordAuthSystem/Config.json</code>
                    and the auth provider is registered in LaunchServer.json.
                  </DialogDescription>
                </DialogHeader>
                <div class="grid gap-4 py-2">
                  <div class="grid gap-2">
                    <Label for="discord-client-id">Discord client ID</Label>
                    <Input id="discord-client-id" v-model="discord.clientId" />
                  </div>
                  <div class="grid gap-2">
                    <Label for="discord-client-secret">Discord client secret</Label>
                    <Input
                      id="discord-client-secret"
                      v-model="discord.clientSecret"
                      type="password"
                      :placeholder="discordClientSecretConfigured ? 'Configured (leave blank to keep)' : ''"
                    />
                  </div>
                  <div class="grid gap-2">
                    <Label for="discord-redirect-url">Redirect URL</Label>
                    <Input
                      id="discord-redirect-url"
                      v-model="discord.redirectUrl"
                      :placeholder="defaultDiscordRedirectUrl || 'http://127.0.0.1:9274/webapi/auth/discord'"
                    />
                  </div>
                  <div class="grid gap-2">
                    <Label>Required guild IDs</Label>
                    <div class="flex gap-2">
                      <Input
                        v-model="discordGuildInput"
                        placeholder="123456789012345678"
                        @keydown.enter.prevent="addDiscordGuild"
                      />
                      <Button type="button" variant="outline" @click="addDiscordGuild">Add</Button>
                    </div>
                    <div class="flex flex-wrap gap-1">
                      <Badge
                        v-for="(guildId, index) in discord.requiredGuildIds"
                        :key="guildId"
                        variant="secondary"
                        class="cursor-pointer"
                        @click="removeDiscordGuild(index)"
                      >
                        {{ guildId }} ×
                      </Badge>
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-4">
                    <div class="grid gap-2">
                      <Label for="discord-username-regex">Username regex</Label>
                      <Input id="discord-username-regex" v-model="discord.usernameRegex" />
                    </div>
                    <div class="grid gap-2">
                      <Label for="discord-username-format">Username format</Label>
                      <Input id="discord-username-format" v-model="discord.usernameFormat" />
                    </div>
                  </div>
                  <div class="flex items-center gap-4">
                    <label class="flex items-center gap-2 text-sm">
                      <Checkbox
                        :checked="discord.useGlobalNickname"
                        @update:checked="discord.useGlobalNickname = Boolean($event)"
                      />
                      Use global nickname
                    </label>
                    <label class="flex items-center gap-2 text-sm">
                      <Checkbox
                        :checked="discord.autoRegister"
                        @update:checked="discord.autoRegister = Boolean($event)"
                      />
                      Auto-register
                    </label>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" type="button" @click="discordModalOpen = false">Cancel</Button>
                  <Button type="button" :disabled="!discordValid" @click="applyDiscordProvider">
                    Apply Discord auth
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </template>
          <AlertDialog v-else>
            <AlertDialogTrigger as-child>
              <Button :disabled="!canApply">
                <KeyRound />
                Apply auth recipe
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Apply {{ selectedRecipe?.title }}?</AlertDialogTitle>
                <AlertDialogDescription>
                  LaunchServer.json will be snapshotted first. Non-file recipes restart LaunchServer.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <dl class="grid gap-2 rounded-md border bg-muted/40 p-4 text-sm">
                <div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
                  <dt class="text-muted-foreground">Server</dt>
                  <dd>LaunchServer</dd>
                </div>
                <div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
                  <dt class="text-muted-foreground">Auth id</dt>
                  <dd class="font-mono">{{ authId }}</dd>
                </div>
                <div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
                  <dt class="text-muted-foreground">Recipe</dt>
                  <dd>{{ selectedRecipe?.title }}</dd>
                </div>
              </dl>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction @click="applyProvider">Apply</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardFooter>
      </Card>

      <div class="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">Configured providers</CardTitle>
            <CardDescription>Sanitized view of the current LaunchServer auth map.</CardDescription>
          </CardHeader>
          <CardContent class="space-y-2">
            <div
              v-for="provider in configuration?.providers"
              :key="provider.id"
              class="rounded-md border p-3 text-sm"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="font-medium">{{ provider.displayName }}</span>
                <Badge :variant="provider.isDefault ? 'default' : 'secondary'">
                  {{ provider.isDefault ? 'Default' : 'Secondary' }}
                </Badge>
              </div>
              <p class="mt-1 font-mono text-xs text-muted-foreground">
                {{ provider.id }} · {{ provider.coreType }}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card v-if="selectedProviderIsFileAuth">
          <CardHeader>
            <CardTitle class="text-base">FileAuthSystem module config</CardTitle>
            <CardDescription>
              Module-level settings for the loaded FileAuthSystem provider.
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
              <div>
                <p class="text-sm font-medium">autoSave</p>
                <p class="text-xs text-muted-foreground">
                  Persist Database.json when LaunchServer stops.
                </p>
              </div>
              <Switch
                :model-value="fileAuthAutoSave"
                :disabled="fileAuthConfigPending || fileAuthConfigJobPending"
                @update:model-value="fileAuthAutoSave = Boolean($event)"
              />
            </div>
            <Button
              class="w-full"
              size="sm"
              type="button"
              variant="outline"
              :disabled="fileAuthConfigPending || fileAuthConfigJobPending"
              @click="applyFileAuthConfig"
            >
              Save module config
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>

    <JobLogCard :job="activeJob" title="Authentication job" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import JobLogCard from '@/components/jobs/JobLogCard.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { defaultDiscordRedirectUrl as resolveDiscordRedirectUrl } from '@/lib/discord-redirect'
import { useLaunchServerStore } from '@/stores/launchserver'
import type {
  AuthConfiguration,
  AuthCoreRecipeId,
  AuthDiscordCoreConfig,
  AuthProviderDetail,
  AuthSqlDriverPreset,
  AuthPasswordVerifierType,
  FileAuthModuleConfig,
  JobRecord,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { KeyRound, TriangleAlert } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'

const queryClient = useQueryClient()
const { launchServer, launchServerId: installationId } = storeToRefs(
  useLaunchServerStore(),
)
const authId = ref('')
const recipeId = ref<AuthCoreRecipeId>('file')
const displayName = ref('Default')
const isDefault = ref(true)
const visible = ref(true)
const sqlDriver = ref<AuthSqlDriverPreset>('postgresql')
const sqlVerifier = ref<AuthPasswordVerifierType>('bcrypt')
const sqlJdbcUrl = ref('jdbc:postgresql://localhost:5432/database')
const sqlUsername = ref('username')
const sqlPassword = ref('')
const sqlPasswordConfigured = ref(false)
const sqlTable = ref('users')
const http = reactive({
  userByUsername: '',
  userByUuid: '',
  userByToken: '',
  refreshAccessToken: '',
  authorize: '',
  checkServer: '',
  joinServer: '',
})
const httpBearer = ref('')
const httpBearerConfigured = ref(false)
const mergeList = ref<string[]>([])
const discord = reactive<AuthDiscordCoreConfig>({
  clientId: '',
  clientSecret: '',
  redirectUrl: '',
  discordAuthorizeUrl: 'https://discord.com/oauth2/authorize',
  discordTokenUrl: 'https://discord.com/api/oauth2/token',
  discordApiEndpoint: 'https://discord.com/api/v10',
  requiredGuildIds: [],
  useGlobalNickname: true,
  usernameRegex: '^[a-zA-Z0-9_]{3,16}$',
  usernameFormat: '{discord}',
  autoRegister: true,
})
const discordGuildInput = ref('')
const discordModalOpen = ref(false)
const discordClientSecretConfigured = ref(false)
const fileAuthAutoSave = ref(true)
const defaultDiscordRedirectUrl = computed(() =>
  resolveDiscordRedirectUrl(launchServer.value?.address),
)

const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => installationId.value,
  ['gravit.auth.file.install', 'gravit.auth.provider.apply', 'gravit.module.config.apply'],
)

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

const {
  data: configuration,
  error: configurationError,
  refetch: refetchConfiguration,
} = useQuery({
  queryKey: computed(() => ['auth-configuration', installationId.value]),
  queryFn: () =>
    getJson<AuthConfiguration>(
      `/api/auth/configuration?installationId=${encodeURIComponent(installationId.value)}`,
    ),
  enabled: computed(() => Boolean(installationId.value)),
  retry: false,
})

watch(installationId, () => {
  authId.value = ''
})

watch(
  () => configuration.value?.providers,
  (providers) => {
    if (!providers?.some((provider) => provider.id === authId.value)) {
      authId.value = providers?.find((provider) => provider.isDefault)?.id ?? providers?.[0]?.id ?? ''
    }
  },
  { immediate: true },
)

const { data: detail } = useQuery({
  queryKey: computed(() => ['auth-provider-detail', installationId.value, authId.value]),
  queryFn: () =>
    getJson<AuthProviderDetail>(
      `/api/auth/providers/${encodeURIComponent(authId.value)}?installationId=${encodeURIComponent(installationId.value)}`,
    ),
  enabled: computed(() => Boolean(installationId.value && authId.value)),
  retry: false,
})

watch(
  detail,
  (value) => {
    if (!value) return
    displayName.value = value.displayName
    isDefault.value = value.isDefault
    visible.value = value.visible
    const matched = configuration.value?.recipes.find((recipe) => recipe.coreType === value.coreType)
    if (matched) recipeId.value = matched.id
    if (value.sql) {
      sqlDriver.value = value.sql.holder.driverPreset
      sqlJdbcUrl.value = value.sql.holder.jdbcUrl
      sqlUsername.value = value.sql.holder.username
      sqlPasswordConfigured.value = value.sql.holder.passwordConfigured
      sqlTable.value = value.sql.table ?? 'users'
      sqlVerifier.value = value.sql.passwordVerifier.type
    }
    if (value.http) {
      Object.assign(http, {
        userByUsername: value.http.userByUsername,
        userByUuid: value.http.userByUuid,
        userByToken: value.http.userByToken,
        refreshAccessToken: value.http.refreshAccessToken,
        authorize: value.http.authorize,
        checkServer: value.http.checkServer,
        joinServer: value.http.joinServer,
      })
      httpBearerConfigured.value = value.http.bearerConfigured
    }
    if (value.merge) mergeList.value = [...value.merge.list]
    if (value.discord) {
      Object.assign(discord, {
        clientId: value.discord.clientId,
        clientSecret: '',
        redirectUrl: value.discord.redirectUrl || defaultDiscordRedirectUrl.value,
        discordAuthorizeUrl: value.discord.discordAuthorizeUrl,
        discordTokenUrl: value.discord.discordTokenUrl,
        discordApiEndpoint: value.discord.discordApiEndpoint,
        requiredGuildIds: [...value.discord.requiredGuildIds],
        useGlobalNickname: value.discord.useGlobalNickname,
        usernameRegex: value.discord.usernameRegex,
        usernameFormat: value.discord.usernameFormat,
        autoRegister: value.discord.autoRegister,
      })
      discordClientSecretConfigured.value = value.discord.clientSecretConfigured
    } else {
      discordClientSecretConfigured.value = false
    }
  },
  { immediate: true },
)

watch(defaultDiscordRedirectUrl, (value) => {
  if (value && !discord.redirectUrl) discord.redirectUrl = value
}, { immediate: true })

watch(sqlDriver, (driver) => {
  const prefixes = {
    postgresql: 'jdbc:postgresql://localhost:5432/database',
    mariadb: 'jdbc:mariadb://localhost:3306/database',
    mysql: 'jdbc:mysql://localhost:3306/database',
  }
  if (!sqlJdbcUrl.value || sqlJdbcUrl.value.startsWith('jdbc:')) {
    sqlJdbcUrl.value = prefixes[driver]
  }
})

const selectedProviderIsFileAuth = computed(
  () => detail.value?.coreType === 'fileauthsystem',
)

const {
  data: fileAuthConfig,
  error: fileAuthConfigQueryError,
  isFetching: fileAuthConfigPending,
} = useQuery({
  queryKey: computed(() => ['fileauth-module-config', installationId.value]),
  queryFn: () =>
    getJson<FileAuthModuleConfig>(
      `/api/auth/modules/fileauthsystem?installationId=${encodeURIComponent(installationId.value)}`,
    ),
  enabled: computed(() => Boolean(installationId.value && selectedProviderIsFileAuth.value)),
  retry: false,
})
watch(
  () => fileAuthConfig.value?.autoSave,
  (value) => {
    if (typeof value === 'boolean') fileAuthAutoSave.value = value
  },
  { immediate: true },
)

const selectedRecipe = computed(() =>
  configuration.value?.recipes.find((recipe) => recipe.id === recipeId.value),
)
const mergeCandidates = computed(
  () => configuration.value?.providers.filter((provider) => provider.id !== authId.value) ?? [],
)
const toggleMerge = (id: string, checked: boolean) => {
  if (checked) mergeList.value = [...new Set([...mergeList.value, id])]
  else mergeList.value = mergeList.value.filter((item) => item !== id)
}

const addDiscordGuild = () => {
  const id = discordGuildInput.value.trim()
  if (!id) return
  if (!/^\d{10,22}$/.test(id)) {
    alert('Guild ID must be a numeric Discord snowflake')
    return
  }
  if (!discord.requiredGuildIds.includes(id)) {
    discord.requiredGuildIds.push(id)
  }
  discordGuildInput.value = ''
}

const removeDiscordGuild = (index: number) => {
  discord.requiredGuildIds.splice(index, 1)
}

const discordValid = computed(() =>
  Boolean(
    authId.value &&
      displayName.value &&
      discord.clientId &&
      (discord.clientSecret || discordClientSecretConfigured.value) &&
      discord.redirectUrl &&
      discord.usernameRegex &&
      discord.usernameFormat,
  ),
)

const {
  mutate,
  isPending: mutationPending,
  error: mutationError,
} = useMutation({
  mutationFn: () => {
    const body: Record<string, unknown> = {
      installationId: installationId.value,
      authId: authId.value,
      recipeId: recipeId.value,
      displayName: displayName.value,
      isDefault: isDefault.value,
      visible: visible.value,
      confirmConfigWrite: true,
    }
    if (recipeId.value === 'sql') {
      body.sql = {
        holder: {
          driverPreset: sqlDriver.value,
          jdbcUrl: sqlJdbcUrl.value,
          username: sqlUsername.value,
          ...(sqlPassword.value ? { password: sqlPassword.value } : {}),
        },
        table: sqlTable.value,
        passwordVerifier: { type: sqlVerifier.value },
      }
    }
    if (recipeId.value === 'http') {
      body.http = {
        ...http,
        ...(httpBearer.value ? { bearerToken: httpBearer.value } : {}),
      }
    }
    if (recipeId.value === 'merge') body.merge = { list: mergeList.value }
    if (recipeId.value === 'discord') {
      const { clientSecret, ...configuration } = discord
      body.discord = {
        ...configuration,
        ...(clientSecret ? { clientSecret } : {}),
      }
    }
    return getJson<JobRecord>('/api/auth/providers/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  },
  onSuccess: attachJob,
})

const operationPending = computed(
  () =>
    mutationPending.value ||
    activeJob.value?.status === 'queued' ||
    activeJob.value?.status === 'running',
)
const canApply = computed(
  () => Boolean(authId.value && recipeId.value && displayName.value) && !operationPending.value,
)
const pageError = computed(
  () =>
    (configurationError.value ||
      mutationError.value ||
      fileAuthConfigQueryError.value ||
      fileAuthConfigError.value ||
      activeJobError.value) as Error | null,
)
const applyProvider = () => mutate()
const applyDiscordProvider = () => {
  if (!discordValid.value) return
  mutate()
  discordModalOpen.value = false
}

const {
  error: fileAuthConfigError,
  isPending: fileAuthConfigMutationPending,
  mutate: mutateFileAuthConfig,
} = useMutation({
  mutationFn: () =>
    getJson<JobRecord>('/api/auth/modules/fileauthsystem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: installationId.value,
        autoSave: fileAuthAutoSave.value,
        confirmConfigWrite: true,
      }),
    }),
  onSuccess: attachJob,
})

const fileAuthConfigJobPending = computed(
  () =>
    fileAuthConfigMutationPending.value ||
    activeJob.value?.status === 'queued' ||
    activeJob.value?.status === 'running',
)
const applyFileAuthConfig = () => mutateFileAuthConfig()

const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  await queryClient.invalidateQueries({ queryKey: ['auth-configuration', installationId.value] })
  await queryClient.invalidateQueries({
    queryKey: ['auth-provider-detail', installationId.value, authId.value],
  })
  await queryClient.invalidateQueries({
    queryKey: ['fileauth-module-config', installationId.value],
  })
  await refetchConfiguration()
}
</script>
