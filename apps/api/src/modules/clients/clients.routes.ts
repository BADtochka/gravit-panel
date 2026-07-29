import type {
  ClientBuildInput,
  ClientProfileJavaUpdateInput,
  ClientProfileRemoveInput,
  ClientProfileUpdateInput,
  JobRecord,
  LaunchServerRuntimeHealth,
  MinecraftLoader,
  WorkspaceApplyInput,
} from '@gravit-panel/shared'
import { Elysia, t } from 'elysia'
import { env } from '../../core/env'
import { LauncherDockeredService } from '../docker/launcherdockered.service'
import { installationsStore, controlFileService } from '../gravit/gravit.runtime'
import type { InstallationsStore } from '../gravit/installations.store'
import type { JobsRunner } from '../jobs/jobs.runner'
import { activeJobForInstallation, jobsRunner } from '../jobs/jobs.runtime'
import { ClientBuildService } from './client-build.service'
import { LauncherRuntimeService } from './launcher-runtime.service'
import {
  launcherBuildSource,
  launcherRuntimeRelease,
  mirrorHelperSource,
  prestarterRelease,
  workspaceManifest,
} from './client-sources'
import { MinecraftVersionsService } from './minecraft-versions.service'
import { JavaRuntimeManagerService } from './java-runtime-manager.service'

const launcherLifecycle = new LauncherDockeredService(env.INSTALLATIONS_ROOT)
const launcherRuntimeService = new LauncherRuntimeService(
  controlFileService,
  undefined,
  undefined,
  undefined,
  launcherLifecycle,
)
export const clientBuildService = new ClientBuildService(
  controlFileService,
  undefined,
  undefined,
  undefined,
  launcherRuntimeService,
  undefined,
  launcherLifecycle,
)
const javaRuntimes = new JavaRuntimeManagerService(
  launcherLifecycle,
  clientBuildService,
)
const versions = new MinecraftVersionsService()
const installationId = t.String({ format: 'uuid' })
const profile = t.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
})
const minecraftVersion = t.String({
  minLength: 1,
  maxLength: 32,
  pattern: '^[0-9]+(?:\\.[0-9]+){1,3}$',
})
const loader = t.Union([
  t.Literal('VANILLA'),
  t.Literal('FABRIC'),
  t.Literal('FORGE'),
  t.Literal('NEOFORGE'),
  t.Literal('QUILT'),
])
const modSlug = t.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z0-9][a-z0-9_-]*$',
})

type ClientOperations = Pick<
  ClientBuildService,
  | 'compatibility'
  | 'preparationState'
  | 'profileState'
  | 'listProfiles'
  | 'updateProfile'
  | 'updateProfileJava'
  | 'removeProfile'
  | 'listLauncherArtifacts'
  | 'artifactPath'
  | 'applyWorkspace'
  | 'installPrestarter'
  | 'buildLauncher'
  | 'customizationState'
  | 'customizeLauncher'
  | 'buildClient'
>

type LaunchServerLifecycle = Pick<
  LauncherDockeredService,
  'checkLaunchServer' | 'restartLaunchServer'
>

export interface ClientsRoutesDependencies {
  service: ClientOperations
  lifecycle: LaunchServerLifecycle
  versions: Pick<MinecraftVersionsService, 'list'>
  installations: Pick<InstallationsStore, 'get'>
  jobs: Pick<JobsRunner, 'create'>
  activeJob: (installationId: string) => JobRecord | null | undefined
  javaRuntimes: Pick<
    JavaRuntimeManagerService,
    'state' | 'install' | 'installTemurin' | 'remove' | 'updateSettings'
  >
}

export const createClientsRoutes = ({
  service,
  lifecycle,
  versions,
  installations,
  jobs,
  activeJob,
  javaRuntimes,
}: ClientsRoutesDependencies) => {
  const findInstallation = (id: string, set: { status?: number | string }) => {
    const installation = installations.get(id)
    if (!installation) set.status = 404
    return installation
  }

  return new Elysia({ prefix: '/clients' })
  .get('/configuration', () => ({
    loaders: ['VANILLA', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT'] satisfies MinecraftLoader[],
    sources: {
      launcher: launcherBuildSource,
      runtime: launcherRuntimeRelease,
      mirrorHelper: mirrorHelperSource,
      workspace: workspaceManifest,
      prestarter: prestarterRelease,
    },
  }))
  .get('/minecraft-versions', () => versions.list())
  .get(
    '/profiles',
    ({ query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return service.listProfiles(installation)
    },
    { query: t.Object({ installationId }) },
  )
  .post(
    '/profiles/:name/update',
    ({ params, body, set }) => {
      const input = {
        ...body,
        name: params.name,
      } as ClientProfileUpdateInput
      const installation = findInstallation(input.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
        'gravit.profile.update',
        { ...input },
        `${input.name} profile update queued`,
        async (context) => ({
          ...(await service.updateProfile(installation, input, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      params: t.Object({ name: profile }),
      body: t.Object({
        installationId,
        title: t.String({ minLength: 1, maxLength: 64 }),
        description: t.String({ minLength: 1, maxLength: 512 }),
        sortIndex: t.Integer({ minimum: -10_000, maximum: 10_000 }),
      }),
    },
  )
  .post(
    '/profiles/:name/remove',
    ({ params, body, set }) => {
      const input = {
        ...body,
        name: params.name,
      } as ClientProfileRemoveInput
      const installation = findInstallation(input.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
        'gravit.profile.remove',
        { ...input },
        `${input.name} profile removal queued`,
        async (context) => ({
          ...(await service.removeProfile(installation, input, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      params: t.Object({ name: profile }),
      body: t.Object({
        installationId,
        confirmRemove: t.Literal(true),
      }),
    },
  )
  .post(
    '/profiles/:name/java',
    ({ params, body, set }) => {
      const input = { ...body, name: params.name } as ClientProfileJavaUpdateInput
      const installation = findInstallation(input.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
        'gravit.profile.java.update',
        { ...input },
        `${input.name} Java compatibility update queued`,
        async (context) => ({
          ...(await service.updateProfileJava(installation, input, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      params: t.Object({ name: profile }),
      body: t.Object({
        installationId,
        recommendJavaVersion: t.Integer({ minimum: 8, maximum: 99 }),
        minJavaVersion: t.Integer({ minimum: 8, maximum: 99 }),
        maxJavaVersion: t.Integer({ minimum: 8, maximum: 999 }),
      }),
    },
  )
  .get(
    '/java',
    ({ query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return javaRuntimes.state(installation)
    },
    { query: t.Object({ installationId }) },
  )
  .post(
    '/java/install',
    async ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const archive = new Uint8Array(await body.archive.arrayBuffer())
      const input = {
        directory: body.directory,
        version: body.version,
        build: body.build,
        os: body.os,
        arch: body.arch,
        javafx: body.javafx,
      }
      const job = jobs.create(
        'gravit.java.install',
        {
          installationId: installation.id,
          ...input,
          filename: body.archive.name,
          archiveSize: archive.length,
        },
        `Java ${body.version} ${body.os}/${body.arch} installation queued`,
        async (context) => ({
          ...(await javaRuntimes.install(installation, input, archive, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        directory: t.String({
          minLength: 1,
          maxLength: 64,
          pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
        }),
        version: t.Numeric({ minimum: 8, maximum: 99 }),
        build: t.Numeric({ minimum: 0, maximum: 999_999 }),
        os: t.Union([
          t.Literal('mustdie'),
          t.Literal('linux'),
          t.Literal('macosx'),
        ]),
        arch: t.Union([
          t.Literal('X86'),
          t.Literal('X86_64'),
          t.Literal('ARM32'),
          t.Literal('ARM64'),
        ]),
        javafx: t.BooleanString(),
        archive: t.File({ maxSize: 300 * 1024 * 1024 }),
      }),
    },
  )
  .post(
    '/java/temurin/install',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const input = {
        directory: body.directory,
        version: body.version,
        os: body.os,
        arch: body.arch,
        imageType: body.imageType,
      }
      const job = jobs.create(
        'gravit.java.temurin.install',
        { installationId: installation.id, ...input },
        `Latest Temurin ${body.imageType.toUpperCase()} ${body.version} installation queued`,
        async (context) => ({
          ...(await javaRuntimes.installTemurin(installation, input, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        directory: t.String({
          minLength: 1,
          maxLength: 64,
          pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
        }),
        version: t.Integer({ minimum: 8, maximum: 99 }),
        os: t.Union([
          t.Literal('mustdie'),
          t.Literal('linux'),
          t.Literal('macosx'),
        ]),
        arch: t.Union([
          t.Literal('X86'),
          t.Literal('X86_64'),
          t.Literal('ARM32'),
          t.Literal('ARM64'),
        ]),
        imageType: t.Union([t.Literal('jre'), t.Literal('jdk')]),
      }),
    },
  )
  .post(
    '/java/remove',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
        'gravit.java.remove',
        { ...body },
        `Java runtime ${body.directory} removal queued`,
        async (context) => ({
          ...(await javaRuntimes.remove(installation, body.directory, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        directory: t.String({
          minLength: 1,
          maxLength: 64,
          pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
        }),
        confirmRemoval: t.Literal(true),
      }),
    },
  )
  .post(
    '/java/settings',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
        'gravit.java.settings',
        { ...body },
        'Custom Java launcher setting update queued',
        async (context) => ({
          ...(await javaRuntimes.updateSettings(
            installation,
            body.forceUseCustomJava,
            context,
          )),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        forceUseCustomJava: t.Boolean(),
      }),
    },
  )
  .get(
    '/state',
    ({ query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return service.preparationState(installation)
    },
    { query: t.Object({ installationId }) },
  )
  .get(
    '/compatibility',
    ({ query }) => service.compatibility(query.minecraftVersion),
    { query: t.Object({ minecraftVersion }) },
  )
  .get(
    '/profile-state',
    ({ query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return service.profileState(installation, query.name)
    },
    { query: t.Object({ installationId, name: profile }) },
  )
  .get(
    '/launcher/artifacts',
    async ({ query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return { items: await service.listLauncherArtifacts(installation) }
    },
    { query: t.Object({ installationId }) },
  )
  .get(
    '/launcher/customization',
    ({ query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return service.customizationState(installation)
    },
    { query: t.Object({ installationId }) },
  )
  .get(
    '/launcher/health',
    async ({ query, set }): Promise<LaunchServerRuntimeHealth | { message: string }> => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return lifecycle.checkLaunchServer(installation)
    },
    { query: t.Object({ installationId }) },
  )
  .get(
    '/launcher/artifacts/:variant',
    async ({ params, query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const variant = params.variant as 'jar' | 'windows-x64'
      const path = await service.artifactPath(installation, variant)
      if (!path) {
        set.status = 404
        return { message: 'Launcher artifact not found. Run a launcher build first.' }
      }
      set.headers['content-disposition'] = `attachment; filename="${path.split('/').at(-1)}"`
      return Bun.file(path)
    },
    {
      params: t.Object({ variant: t.Union([t.Literal('jar'), t.Literal('windows-x64')]) }),
      query: t.Object({ installationId }),
    },
  )
  .post(
    '/workspace/apply',
    ({ body, set }) => {
      const input = body as WorkspaceApplyInput
      const installation = findInstallation(input.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
        'gravit.workspace.apply',
        { ...input },
        'Pinned MirrorHelper workspace apply queued',
        async (context) => ({ ...(await service.applyWorkspace(installation, context)) }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        confirmDestructive: t.Literal(true),
      }),
    },
  )
  .post(
    '/prestarter/install',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
        'gravit.prestarter.install',
        { ...body },
        'LauncherPrestarter installation queued',
        async (context) => ({ ...(await service.installPrestarter(installation, context)) }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({ installationId, confirmInstallation: t.Literal(true) }),
    },
  )
  .post(
    '/launcher/build',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
        'gravit.launcher.build',
        { ...body },
        'Launcher build queued',
        async (context) => ({ ...(await service.buildLauncher(installation, context)) }),
      )
      set.status = 202
      return job
    },
    { body: t.Object({ installationId }) },
  )
  .post(
    '/launcher/restart',
    ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
        'gravit.launchserver.restart',
        { installationId: installation.id },
        'LaunchServer restart queued',
        async (context) => {
          await lifecycle.restartLaunchServer(installation, context)
          return { installationId: installation.id, restarted: true }
        },
      )
      set.status = 202
      return job
    },
    { body: t.Object({ installationId }) },
  )
  .post(
    '/launcher/customization',
    async ({ body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const files = {
        logo: body.logo
          ? new Uint8Array(await body.logo.arrayBuffer())
          : undefined,
        background: body.background
          ? new Uint8Array(await body.background.arrayBuffer())
          : undefined,
        favicon: body.favicon
          ? new Uint8Array(await body.favicon.arrayBuffer())
          : undefined,
      }
      const selected = [
        body.logo ? { id: 'logo', name: body.logo.name, size: body.logo.size } : null,
        body.background
          ? { id: 'background', name: body.background.name, size: body.background.size }
          : null,
        body.favicon
          ? { id: 'favicon', name: body.favicon.name, size: body.favicon.size }
          : null,
      ].filter(Boolean)
      const job = jobs.create(
        'gravit.launcher.customize',
        { installationId: installation.id, assets: selected },
        'Launcher customization and rebuild queued',
        async (context) => ({
          ...(await service.customizeLauncher(installation, files, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        logo: t.Optional(t.File({ maxSize: 2 * 1024 * 1024 })),
        background: t.Optional(t.File({ maxSize: 8 * 1024 * 1024 })),
        favicon: t.Optional(t.File({ maxSize: 2 * 1024 * 1024 })),
      }),
    },
  )
  .post(
    '/build',
    ({ body, set }) => {
      const input = body as ClientBuildInput
      const installation = findInstallation(input.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = activeJob(installation.id)
      if (conflict) {
        set.status = 409
        return { message: 'Another client operation is active.', jobId: conflict.id }
      }
      const job = jobs.create(
        'gravit.client.build',
        { ...input },
        `${input.name} client build queued`,
        async (context) => ({ ...(await service.buildClient(installation, input, context)) }),
      )
      set.status = 202
      return job
    },
    {
      body: t.Object({
        installationId,
        name: profile,
        minecraftVersion,
        loader,
        mods: t.Array(modSlug, { maxItems: 64 }),
      }),
    },
  )
}

export const clientsRoutes = createClientsRoutes({
  service: clientBuildService,
  lifecycle: launcherLifecycle,
  versions,
  installations: installationsStore,
  jobs: jobsRunner,
  activeJob: activeJobForInstallation,
  javaRuntimes,
})
