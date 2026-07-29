<template>
  <Card>
    <CardHeader>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle class="text-base">Client Java</CardTitle>
          <CardDescription>
            Publish your own Java runtimes through LaunchServer and define the compatible version
            range for this profile.
          </CardDescription>
        </div>
        <Badge variant="outline">customJavaDownload</Badge>
      </div>
    </CardHeader>
    <CardContent class="space-y-6">
      <Alert v-if="error" variant="destructive">
        <TriangleAlert class="size-4" />
        <AlertTitle>Java operation failed</AlertTitle>
        <AlertDescription>{{ error.message }}</AlertDescription>
      </Alert>

      <section v-if="profile" class="space-y-3">
        <div>
          <h3 class="text-sm font-medium">Profile compatibility</h3>
          <p class="text-xs text-muted-foreground">
            The launcher prefers the recommended version and accepts versions inside this range.
          </p>
        </div>
        <div class="grid gap-3 sm:grid-cols-3">
          <div>
            <label class="text-xs font-medium" for="java-min">Minimum</label>
            <Select
              :model-value="String(profileJava.min)"
              @update:model-value="profileJava.min = Number($event)"
            >
              <SelectTrigger id="java-min" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="version in javaVersionOptions.filter((item) => item !== 999)"
                  :key="version"
                  :value="String(version)"
                >
                  Java {{ version }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label class="text-xs font-medium" for="java-recommended">Recommended</label>
            <Select
              :model-value="String(profileJava.recommended)"
              @update:model-value="profileJava.recommended = Number($event)"
            >
              <SelectTrigger id="java-recommended" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="version in javaVersionOptions.filter((item) => item !== 999)"
                  :key="version"
                  :value="String(version)"
                >
                  Java {{ version }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label class="text-xs font-medium" for="java-max">Maximum</label>
            <Select
              :model-value="String(profileJava.max)"
              @update:model-value="profileJava.max = Number($event)"
            >
              <SelectTrigger id="java-max" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="version in javaVersionOptions"
                  :key="version"
                  :value="String(version)"
                >
                  {{ version === 999 ? 'Any newer Java' : `Java ${version}` }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          :disabled="disabled || !profileJavaValid"
          @click="saveProfileJava"
        >
          <Save /> Save profile Java range
        </Button>
      </section>

      <section class="space-y-3 border-t pt-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="text-sm font-medium">Published runtimes</h3>
            <p class="text-xs text-muted-foreground">
              Runtimes are stored under updates and embedded into the next launcher build.
            </p>
          </div>
          <label class="flex items-center gap-3 text-sm">
            <span>Force custom Java</span>
            <Switch
              :model-value="forceUseCustomJava"
              :disabled="disabled || (!state?.items.length && !forceUseCustomJava)"
              @update:model-value="saveForceSetting(Boolean($event))"
            />
          </label>
        </div>

        <div v-if="state?.items.length" class="divide-y border-y">
          <div
            v-for="item in state.items"
            :key="item.directory"
            class="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <p class="font-medium">{{ item.directory }}</p>
                <Badge :variant="item.installed ? 'secondary' : 'destructive'">
                  {{ item.installed ? 'Installed' : 'Files missing' }}
                </Badge>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">
                Java {{ item.version }} b{{ item.build }} · {{ osLabel(item.os) }} ·
                {{ item.arch }} · JavaFX {{ item.javafx ? 'yes' : 'no' }}
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger as-child>
                <Button size="sm" variant="ghost" :disabled="disabled">
                  <Trash2 /> Remove
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {{ item.directory }}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Its updates directory moves to recoverable trash, LaunchServer restarts, and
                    the launcher is rebuilt without this runtime.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction @click="removeRuntime(item.directory)">
                    Remove and rebuild
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
        <p v-else class="border-y py-4 text-sm text-muted-foreground">
          No custom Java runtimes are registered.
        </p>
      </section>

      <section class="space-y-4 border-t pt-5">
        <div>
          <h3 class="text-sm font-medium">Add Java runtime</h3>
          <p class="text-xs text-muted-foreground">
            Download the latest Eclipse Temurin release automatically, or upload a local ZIP as a
            fallback. The launcher is rebuilt after installation.
          </p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label class="text-xs font-medium" for="java-directory">Updates directory</label>
            <Input id="java-directory" v-model="form.directory" maxlength="64" />
          </div>
          <div>
            <label class="text-xs font-medium" for="java-version">Java version</label>
            <Select
              :model-value="String(form.version)"
              @update:model-value="form.version = Number($event)"
            >
              <SelectTrigger id="java-version" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="version in downloadableJavaVersions" :key="version" :value="String(version)">
                  Java {{ version }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label class="text-xs font-medium" for="java-image-type">Temurin package</label>
            <Select v-model="form.imageType">
              <SelectTrigger id="java-image-type" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="jre">JRE (recommended)</SelectItem>
                <SelectItem value="jdk">JDK</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label class="text-xs font-medium" for="java-os">Operating system</label>
            <Select v-model="form.os">
              <SelectTrigger id="java-os" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mustdie">Windows</SelectItem>
                <SelectItem value="linux">Linux</SelectItem>
                <SelectItem value="macosx">macOS</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label class="text-xs font-medium" for="java-arch">Architecture</label>
            <Select v-model="form.arch">
              <SelectTrigger id="java-arch" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="X86_64">X86_64</SelectItem>
                <SelectItem value="X86">X86</SelectItem>
                <SelectItem value="ARM64">ARM64</SelectItem>
                <SelectItem value="ARM32">ARM32</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label class="flex items-center justify-between gap-3 self-end rounded-md border px-3 py-2">
            <span class="text-sm">Local ZIP includes JavaFX</span>
            <Switch v-model="form.javafx" />
          </label>
          <div>
            <label class="text-xs font-medium" for="java-build">Local ZIP build number</label>
            <Input id="java-build" v-model.number="form.build" min="0" type="number" />
          </div>
          <div class="sm:col-span-2 lg:col-span-3">
            <label class="text-xs font-medium" for="java-archive">
              Local Java runtime ZIP (optional)
            </label>
            <Input
              id="java-archive"
              accept=".zip,application/zip"
              type="file"
              @change="selectArchive"
            />
            <p class="mt-1 text-xs text-muted-foreground">
              Must contain bin/java or bin/java.exe at its root or inside one top-level directory.
              Maximum size: 300 MiB.
            </p>
          </div>
        </div>
      </section>
    </CardContent>
    <CardFooter class="flex flex-wrap gap-2">
      <Button :disabled="disabled || !canDownload" @click="downloadRuntime">
        <Download /> Download Temurin and rebuild
      </Button>
      <Button variant="outline" :disabled="disabled || !canInstall" @click="installRuntime">
        <Upload /> Upload local ZIP
      </Button>
    </CardFooter>
  </Card>
</template>

<script setup lang="ts">
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type {
  ClientProfileDescriptor,
  JavaRuntimeArch,
  JavaRuntimeOs,
  JavaRuntimeState,
  JobRecord,
} from '@gravit-panel/shared'
import { Download, Save, Trash2, TriangleAlert, Upload } from '@lucide/vue'
import { useMutation, useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps<{
  installationId: string
  profile: ClientProfileDescriptor | null
  disabled: boolean
}>()
const emit = defineEmits<{
  job: [job: JobRecord]
  error: [error: Error]
}>()

const getJson = async <T>(url: string, init?: RequestInit) => {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => null) as T & { message?: string }
  if (!response.ok) throw new Error(body?.message ?? `Request failed with ${response.status}`)
  return body
}
const post = (url: string, body: Record<string, unknown>) =>
  getJson<JobRecord>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const archive = ref<File | null>(null)
const forceUseCustomJava = ref(false)
const profileJava = reactive({ min: 8, recommended: 21, max: 99 })
const form = reactive({
  directory: 'java21-windows-x86-64',
  version: 21,
  build: 0,
  os: 'mustdie' as JavaRuntimeOs,
  arch: 'X86_64' as JavaRuntimeArch,
  imageType: 'jre' as 'jre' | 'jdk',
  javafx: false,
})
const suggestedDirectory = () => {
  const os = form.os === 'mustdie' ? 'windows' : form.os === 'macosx' ? 'macos' : 'linux'
  const arch = form.arch.toLowerCase().replace('_', '-')
  return `java${form.version}-${os}-${arch}`
}
const lastSuggestedDirectory = ref(form.directory)
watch(
  () => [form.version, form.os, form.arch],
  () => {
    const next = suggestedDirectory()
    if (form.directory === lastSuggestedDirectory.value) form.directory = next
    lastSuggestedDirectory.value = next
  },
)
const { data: state, error: stateError } = useQuery({
  queryKey: computed(() => ['client-java', props.installationId]),
  queryFn: () => getJson<JavaRuntimeState>(
    `/api/clients/java?installationId=${encodeURIComponent(props.installationId)}`,
  ),
  enabled: computed(() => Boolean(props.installationId)),
})
watch(state, (value) => {
  forceUseCustomJava.value = value?.forceUseCustomJava ?? false
}, { immediate: true })
watch(
  () => props.profile,
  (profile) => {
    profileJava.min = profile?.minJavaVersion ?? 8
    profileJava.recommended = profile?.recommendJavaVersion ?? 8
    profileJava.max = profile?.maxJavaVersion ?? 99
  },
  { immediate: true },
)

const mutation = useMutation({
  mutationFn: ({ url, body }: { url: string; body: BodyInit | Record<string, unknown> }) =>
    body instanceof FormData
      ? getJson<JobRecord>(url, { method: 'POST', body })
      : post(url, body),
  onSuccess: (job) => emit('job', job),
  onError: (value) => emit('error', value instanceof Error ? value : new Error(String(value))),
})
const profileJavaValid = computed(
  () =>
    Number.isSafeInteger(profileJava.min) &&
    Number.isSafeInteger(profileJava.recommended) &&
    Number.isSafeInteger(profileJava.max) &&
    profileJava.min >= 8 &&
    profileJava.max <= 999 &&
    profileJava.min <= profileJava.recommended &&
    profileJava.recommended <= profileJava.max,
)
const javaVersionOptions = computed(() =>
  [...new Set([
    8,
    11,
    17,
    21,
    25,
    999,
    profileJava.min,
    profileJava.recommended,
    profileJava.max,
    ...(state.value?.items.map((item) => item.version) ?? []),
  ])]
    .filter((version) => Number.isSafeInteger(version) && version >= 8 && version <= 999)
    .sort((left, right) => left - right),
)
const downloadableJavaVersions = [8, 11, 17, 21, 25]
const commonInstallValid = computed(
  () =>
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(form.directory) &&
    Number.isSafeInteger(form.version) &&
    form.version >= 8 &&
    form.version <= 99,
)
const canDownload = computed(() => commonInstallValid.value)
const canInstall = computed(
  () =>
    Boolean(
      archive.value &&
      archive.value.size <= 300 * 1024 * 1024 &&
      commonInstallValid.value &&
      Number.isSafeInteger(form.build) &&
      form.build >= 0,
    ),
)
const error = computed(() => stateError.value as Error | null)
const selectArchive = (event: Event) => {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  if (file && (!file.name.toLowerCase().endsWith('.zip') || file.size > 300 * 1024 * 1024)) {
    archive.value = null
    emit('error', new Error('Choose a ZIP file up to 300 MiB.'))
    return
  }
  archive.value = file
}
const installRuntime = () => {
  if (!archive.value) return
  const body = new FormData()
  body.set('installationId', props.installationId)
  body.set('directory', form.directory)
  body.set('version', String(form.version))
  body.set('build', String(form.build))
  body.set('os', form.os)
  body.set('arch', form.arch)
  body.set('javafx', String(form.javafx))
  body.set('archive', archive.value)
  mutation.mutate({ url: '/api/clients/java/install', body })
}
const downloadRuntime = () => mutation.mutate({
  url: '/api/clients/java/temurin/install',
  body: {
    installationId: props.installationId,
    directory: form.directory,
    version: form.version,
    os: form.os,
    arch: form.arch,
    imageType: form.imageType,
  },
})
const removeRuntime = (directory: string) => mutation.mutate({
  url: '/api/clients/java/remove',
  body: {
    installationId: props.installationId,
    directory,
    confirmRemoval: true,
  },
})
const saveForceSetting = (value: boolean) => mutation.mutate({
  url: '/api/clients/java/settings',
  body: {
    installationId: props.installationId,
    forceUseCustomJava: value,
  },
})
const saveProfileJava = () => {
  if (!props.profile) return
  mutation.mutate({
    url: `/api/clients/profiles/${encodeURIComponent(props.profile.name)}/java`,
    body: {
      installationId: props.installationId,
      minJavaVersion: profileJava.min,
      recommendJavaVersion: profileJava.recommended,
      maxJavaVersion: profileJava.max,
    },
  })
}
const osLabel = (value: JavaRuntimeOs) =>
  value === 'mustdie' ? 'Windows' : value === 'macosx' ? 'macOS' : 'Linux'
</script>
