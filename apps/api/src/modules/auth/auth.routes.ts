import type {
  AuthProviderApplyInput,
  AuthUserCreateInput,
  AuthUserDeleteInput,
  AuthUserPasswordInput,
  FileAuthInstallInput,
  FileAuthModuleConfigApplyInput,
  JobRecord,
} from '@gravit-panel/shared'
import { Elysia, t } from 'elysia'
import { env } from '../../core/env'
import { LauncherDockeredService } from '../docker/launcherdockered.service'
import { controlFileService, installationsStore } from '../gravit/gravit.runtime'
import type { InstallationsStore } from '../gravit/installations.store'
import type { JobsRunner } from '../jobs/jobs.runner'
import { activeJobForInstallation, jobsRunner } from '../jobs/jobs.runtime'
import { AuthModuleConfigService } from './auth-module-config.service'
import { AuthProviderService } from './auth-provider.service'
import { AuthUsersService } from './auth-users.service'

const lifecycle = new LauncherDockeredService(env.INSTALLATIONS_ROOT)
const providerService = new AuthProviderService(controlFileService, undefined, undefined, lifecycle)
const usersService = new AuthUsersService(controlFileService)
const moduleConfigService = new AuthModuleConfigService()

const installationId = t.String({ format: 'uuid' })
const authId = t.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$',
})
const username = t.String({
  minLength: 2,
  maxLength: 16,
  pattern: '^[a-zA-Z0-9_][a-zA-Z0-9_]*$',
})

export interface AuthRoutesDependencies {
  providers: Pick<
    AuthProviderService,
    'configuration' | 'providerDetail' | 'installFileAuth' | 'applyProvider'
  >
  users: Pick<AuthUsersService, 'list' | 'create' | 'setPassword' | 'delete'>
  moduleConfig: Pick<AuthModuleConfigService, 'getFileAuthConfig' | 'applyFileAuthConfig'>
  installations: Pick<InstallationsStore, 'get'>
  jobs: Pick<JobsRunner, 'create'>
  activeJob: (installationId: string) => JobRecord | null | undefined
}

export const createAuthRoutes = ({
  providers,
  users,
  moduleConfig,
  installations,
  jobs,
  activeJob,
}: AuthRoutesDependencies) => {
  const findInstallation = (id: string, set: { status?: number | string }) => {
    const installation = installations.get(id)
    if (!installation) set.status = 404
    return installation
  }

  const conflictOrNull = (
    installation: { id: string },
    set: { status?: number | string },
  ) => {
    const conflict = activeJob(installation.id)
    if (!conflict) return null
    set.status = 409
    return { message: 'Another installation operation is active.', jobId: conflict.id }
  }

  return new Elysia({ prefix: '/auth' })
    .get(
      '/configuration',
      ({ query, set }) => {
        const installation = findInstallation(query.installationId, set)
        if (!installation) return { message: 'LauncherDockered installation not found.' }
        return providers.configuration(installation)
      },
      { query: t.Object({ installationId }) },
    )
    .get(
      '/providers/:authId',
      async ({ params, query, set }) => {
        const installation = findInstallation(query.installationId, set)
        if (!installation) return { message: 'LauncherDockered installation not found.' }
        try {
          return await providers.providerDetail(installation, params.authId)
        } catch (error) {
          set.status = 400
          return { message: error instanceof Error ? error.message : String(error) }
        }
      },
      { params: t.Object({ authId }), query: t.Object({ installationId }) },
    )
    .post(
      '/providers/apply',
      ({ body, set }) => {
        const input = body as AuthProviderApplyInput
        const installation = findInstallation(input.installationId, set)
        if (!installation) return { message: 'LauncherDockered installation not found.' }
        const conflict = conflictOrNull(installation, set)
        if (conflict) return conflict
        const job = jobs.create(
          'gravit.auth.provider.apply',
          { ...input },
          `Auth provider ${input.authId} (${input.recipeId}) queued`,
          async (context) => ({
            ...(await providers.applyProvider(installation, input, context)),
          }),
        )
        set.status = 202
        return job
      },
      {
        body: t.Object({
          installationId,
          authId,
          recipeId: t.Union([
            t.Literal('memory'),
            t.Literal('sql'),
            t.Literal('http'),
            t.Literal('merge'),
            t.Literal('file'),
            t.Literal('mojang'),
            t.Literal('microsoft'),
          ]),
          displayName: t.String({ minLength: 1, maxLength: 64 }),
          isDefault: t.Boolean(),
          visible: t.Boolean(),
          textureProvider: t.Optional(
            t.Object({
              type: t.Union([t.Literal('void'), t.Literal('request')]),
              skinURL: t.Optional(t.String({ maxLength: 512 })),
              cloakURL: t.Optional(t.String({ maxLength: 512 })),
            }),
          ),
          sql: t.Optional(t.Any()),
          http: t.Optional(t.Any()),
          merge: t.Optional(
            t.Object({
              list: t.Array(authId, { minItems: 2, maxItems: 16 }),
            }),
          ),
          confirmConfigWrite: t.Literal(true),
        }),
      },
    )
    .post(
      '/file/install',
      ({ body, set }) => {
        const input = body as FileAuthInstallInput
        const installation = findInstallation(input.installationId, set)
        if (!installation) return { message: 'LauncherDockered installation not found.' }
        const conflict = conflictOrNull(installation, set)
        if (conflict) return conflict
        const job = jobs.create(
          'gravit.auth.file.install',
          { ...input },
          `FileAuthSystem recipe for ${input.authId} queued`,
          async (context) => ({
            ...(await providers.installFileAuth(installation, input.authId, context)),
          }),
        )
        set.status = 202
        return job
      },
      {
        body: t.Object({
          installationId,
          authId,
          confirmConfigWrite: t.Literal(true),
        }),
      },
    )
    .get(
      '/users',
      async ({ query, set }) => {
        const installation = findInstallation(query.installationId, set)
        if (!installation) return { message: 'LauncherDockered installation not found.' }
        try {
          return await users.list(installation, query.authId)
        } catch (error) {
          set.status = 400
          return { message: error instanceof Error ? error.message : String(error) }
        }
      },
      { query: t.Object({ installationId, authId }) },
    )
    .post(
      '/users',
      ({ body, set }) => {
        const input = body as AuthUserCreateInput
        const installation = findInstallation(input.installationId, set)
        if (!installation) return { message: 'LauncherDockered installation not found.' }
        const conflict = conflictOrNull(installation, set)
        if (conflict) return conflict
        const job = jobs.create(
          'gravit.auth.user.create',
          { ...input, password: '[redacted]' },
          `Create user ${input.username} queued`,
          async (context) => ({
            ...(await users.create(installation, input, context)),
          }),
        )
        set.status = 202
        return job
      },
      {
        body: t.Object({
          installationId,
          authId,
          username,
          email: t.String({ minLength: 3, maxLength: 254, format: 'email' }),
          password: t.String({ minLength: 4, maxLength: 128 }),
        }),
      },
    )
    .post(
      '/users/password',
      ({ body, set }) => {
        const input = body as AuthUserPasswordInput
        const installation = findInstallation(input.installationId, set)
        if (!installation) return { message: 'LauncherDockered installation not found.' }
        const conflict = conflictOrNull(installation, set)
        if (conflict) return conflict
        const job = jobs.create(
          'gravit.auth.user.password',
          { ...input, password: '[redacted]' },
          `Password update for ${input.username} queued`,
          async (context) => ({
            ...(await users.setPassword(installation, input, context)),
          }),
        )
        set.status = 202
        return job
      },
      {
        body: t.Object({
          installationId,
          authId,
          username,
          password: t.String({ minLength: 4, maxLength: 128 }),
        }),
      },
    )
    .post(
      '/users/delete',
      ({ body, set }) => {
        const input = body as AuthUserDeleteInput
        const installation = findInstallation(input.installationId, set)
        if (!installation) return { message: 'LauncherDockered installation not found.' }
        const conflict = conflictOrNull(installation, set)
        if (conflict) return conflict
        const job = jobs.create(
          'gravit.auth.user.delete',
          { ...input },
          `Delete user ${input.username} queued`,
          async (context) => ({
            ...(await users.delete(installation, input, context)),
          }),
        )
        set.status = 202
        return job
      },
      {
        body: t.Object({
          installationId,
          authId,
          username,
          confirmDelete: t.Literal(true),
        }),
      },
    )
    .get(
      '/modules/fileauthsystem',
      async ({ query, set }) => {
        const installation = findInstallation(query.installationId, set)
        if (!installation) return { message: 'LauncherDockered installation not found.' }
        try {
          return await moduleConfig.getFileAuthConfig(installation)
        } catch (error) {
          set.status = 400
          return { message: error instanceof Error ? error.message : String(error) }
        }
      },
      { query: t.Object({ installationId }) },
    )
    .post(
      '/modules/fileauthsystem',
      ({ body, set }) => {
        const input = body as FileAuthModuleConfigApplyInput
        const installation = findInstallation(input.installationId, set)
        if (!installation) return { message: 'LauncherDockered installation not found.' }
        const conflict = conflictOrNull(installation, set)
        if (conflict) return conflict
        const job = jobs.create(
          'gravit.module.config.apply',
          { ...input, moduleId: 'FileAuthSystem_module' },
          'FileAuthSystem module config queued',
          async (context) => ({
            ...(await moduleConfig.applyFileAuthConfig(installation, input, context)),
          }),
        )
        set.status = 202
        return job
      },
      {
        body: t.Object({
          installationId,
          autoSave: t.Boolean(),
          confirmConfigWrite: t.Literal(true),
        }),
      },
    )
}

export const authRoutes = createAuthRoutes({
  providers: providerService,
  users: usersService,
  moduleConfig: moduleConfigService,
  installations: installationsStore,
  jobs: jobsRunner,
  activeJob: activeJobForInstallation,
})
