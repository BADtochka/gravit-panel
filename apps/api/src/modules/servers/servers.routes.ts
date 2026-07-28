import type { JobRecord, ServerBindingInput } from '@gravit-panel/shared'
import { Elysia, t } from 'elysia'
import { basename } from 'node:path'
import { installationsStore } from '../gravit/gravit.runtime'
import { activeJobForInstallation, jobsRunner } from '../jobs/jobs.runtime'
import {
  serverBindingService,
  serverBindingsStore,
  serverBootstrapService,
  serverBootstrapStore,
  serverPackService,
  serverModrinthService,
} from './servers.runtime'

const installationId = t.String({ format: 'uuid' })
const profile = t.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
})
const bindingId = t.String({ format: 'uuid' })
const argument = t.String({ minLength: 1, maxLength: 256 })
const bindingBody = t.Object({
  installationId,
  name: t.String({ minLength: 1, maxLength: 64 }),
  serverAddress: t.String({ minLength: 1, maxLength: 253 }),
  serverPort: t.Integer({ minimum: 1, maximum: 65_535 }),
  isDefault: t.Boolean(),
  authId: t.String({ minLength: 1, maxLength: 64 }),
  packVersionId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
  xms: t.String({ minLength: 2, maxLength: 8 }),
  xmx: t.String({ minLength: 2, maxLength: 8 }),
  jvmArgs: t.Array(argument, { maxItems: 32 }),
  gameArgs: t.Array(argument, { maxItems: 32 }),
})

const findInstallation = (id: string, set: { status?: number | string }) => {
  const installation = installationsStore.get(id)
  if (!installation) set.status = 404
  return installation
}

const conflictFor = (
  installationIdValue: string,
  set: { status?: number | string },
): JobRecord | null | undefined => {
  const conflict = activeJobForInstallation(installationIdValue)
  if (conflict) set.status = 409
  return conflict
}

export const serversRoutes = new Elysia({ prefix: '/servers' })
  .get(
    '/modrinth/search',
    ({ query }) => serverModrinthService.searchServer(
      query.query,
      query.minecraftVersion,
      query.loader,
    ),
    {
      query: t.Object({
        query: t.String({ minLength: 1, maxLength: 100 }),
        minecraftVersion: t.String({
          minLength: 1,
          maxLength: 32,
          pattern: '^[0-9]+(?:\\.[0-9]+){1,3}$',
        }),
        loader: t.Union([
          t.Literal('FABRIC'),
          t.Literal('FORGE'),
          t.Literal('NEOFORGE'),
        ]),
      }),
    },
  )
  .get(
    '/profiles/:profile/bindings',
    ({ params, query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return serverBindingService.list(installation, params.profile)
    },
    { params: t.Object({ profile }), query: t.Object({ installationId }) },
  )
  .post(
    '/profiles/:profile/bindings',
    async ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another profile operation is active.', jobId: conflict.id }
      const input = { ...body, profileName: params.profile } as ServerBindingInput
      if (serverBindingsStore.getByName(installation.id, params.profile, input.name)) {
        set.status = 409
        return { message: 'A managed server with this name already exists.' }
      }
      const job = jobsRunner.create(
        'gravit.server.binding.apply',
        { ...input },
        `${input.name} server binding queued`,
        async (context) => ({ ...(await serverBindingService.apply(installation, input, context)) }),
      )
      set.status = 202
      return job
    },
    { params: t.Object({ profile }), body: bindingBody },
  )
  .post(
    '/bindings/:bindingId/update',
    ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another profile operation is active.', jobId: conflict.id }
      const current = serverBindingsStore.get(params.bindingId)
      if (!current || current.installationId !== installation.id) {
        set.status = 404
        return { message: 'Managed server binding not found.' }
      }
      const input = { ...body, profileName: current.profileName } as ServerBindingInput
      const job = jobsRunner.create(
        'gravit.server.binding.apply',
        { ...input, bindingId: current.id },
        `${input.name} server binding update queued`,
        async (context) => {
          const result = await serverBindingService.apply(
            installation,
            input,
            context,
            params.bindingId,
          )
          serverBootstrapStore.invalidateBinding(
            params.bindingId,
            'Server binding changed; prepare a new bootstrap bundle',
          )
          return { ...result }
        },
      )
      set.status = 202
      return job
    },
    { params: t.Object({ bindingId }), body: bindingBody },
  )
  .post(
    '/bindings/:bindingId/remove',
    ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another profile operation is active.', jobId: conflict.id }
      const job = jobsRunner.create(
        'gravit.server.binding.remove',
        { installationId: installation.id, bindingId: params.bindingId },
        'Server binding removal queued',
        async (context) => ({
          ...(await serverBindingService.remove(installation, params.bindingId, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      params: t.Object({ bindingId }),
      body: t.Object({ installationId, confirmRemove: t.Literal(true) }),
    },
  )
  .get(
    '/profiles/:profile/pack',
    ({ params, query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return serverPackService.listFiles(installation, params.profile)
    },
    { params: t.Object({ profile }), query: t.Object({ installationId }) },
  )
  .post(
    '/profiles/:profile/pack/files',
    async ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another server pack operation is active.', jobId: conflict.id }
      return serverPackService.putFile(
        installation,
        params.profile,
        body.path,
        new Uint8Array(await body.file.arrayBuffer()),
      )
    },
    {
      params: t.Object({ profile }),
      body: t.Object({
        installationId,
        path: t.String({ minLength: 1, maxLength: 512 }),
        file: t.File({ maxSize: 256 * 1024 * 1024 }),
      }),
    },
  )
  .post(
    '/profiles/:profile/pack/files/remove',
    async ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another server pack operation is active.', jobId: conflict.id }
      return serverPackService.removeFile(installation, params.profile, body.path)
    },
    {
      params: t.Object({ profile }),
      body: t.Object({
        installationId,
        path: t.String({ minLength: 1, maxLength: 512 }),
        confirmRemove: t.Literal(true),
      }),
    },
  )
  .post(
    '/profiles/:profile/pack/mods',
    ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another server pack operation is active.', jobId: conflict.id }
      const job = jobsRunner.create(
        'gravit.server-pack.modify',
        { installationId: installation.id, profileName: params.profile, slug: body.slug },
        `${body.slug} server mod installation queued`,
        async (context) => {
          context.progress(10, 'Resolving server-compatible Modrinth dependencies')
          const result = await serverPackService.installMod(
            installation,
            params.profile,
            body.slug,
          )
          context.progress(95, 'Server mod and required dependencies installed')
          return result
        },
      )
      set.status = 202
      return job
    },
    {
      params: t.Object({ profile }),
      body: t.Object({
        installationId,
        slug: t.String({
          minLength: 1,
          maxLength: 64,
          pattern: '^[a-z0-9][a-z0-9_-]*$',
        }),
      }),
    },
  )
  .post(
    '/profiles/:profile/pack/publish',
    ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another server pack operation is active.', jobId: conflict.id }
      const job = jobsRunner.create(
        'gravit.server-pack.publish',
        { installationId: installation.id, profileName: params.profile },
        `${params.profile} server pack publication queued`,
        async (context) => ({
          ...(await serverPackService.publish(installation, params.profile, context)),
        }),
      )
      set.status = 202
      return job
    },
    {
      params: t.Object({ profile }),
      body: t.Object({ installationId }),
    },
  )
  .get(
    '/bindings/:bindingId/bootstrap',
    ({ params, query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const binding = serverBindingsStore.get(params.bindingId)
      if (!binding || binding.installationId !== installation.id) {
        set.status = 404
        return { message: 'Managed server binding not found.' }
      }
      return serverBootstrapService.list(params.bindingId)
    },
    { params: t.Object({ bindingId }), query: t.Object({ installationId }) },
  )
  .post(
    '/bindings/:bindingId/bootstrap/prepare',
    ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another server operation is active.', jobId: conflict.id }
      const draft = serverBootstrapService.createDraft(installation, params.bindingId)
      const job = jobsRunner.create(
        'gravit.server-bootstrap.prepare',
        {
          installationId: installation.id,
          bindingId: params.bindingId,
          draftId: draft.id,
          profileName: draft.profileName,
          confirmEula: true,
        },
        'Server bootstrap bundle preparation queued',
        async (context) => ({
          ...(await serverBootstrapService.prepare(installation, draft.id, context)),
        }),
      )
      set.status = 202
      return { job, draft }
    },
    {
      params: t.Object({ bindingId }),
      body: t.Object({
        installationId,
        confirmEula: t.Literal(true),
      }),
    },
  )
  .post(
    '/bootstrap/:draftId/issue',
    async ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const draft = serverBootstrapStore.internal(params.draftId)
      if (!draft || draft.installation_id !== installation.id) {
        set.status = 404
        return { message: 'Bootstrap draft not found.' }
      }
      try {
        return await serverBootstrapService.issue(installation, params.draftId)
      } catch (error) {
        set.status = 409
        return { message: error instanceof Error ? error.message : String(error) }
      }
    },
    {
      params: t.Object({ draftId: t.String({ format: 'uuid' }) }),
      body: t.Object({ installationId }),
    },
  )

export const serverBootstrapRoutes = new Elysia({ prefix: '/server-bootstrap' })
  .get(
    '/:claim',
    async ({ params, set }) => {
      const installationIdValue = serverBootstrapService.claimInstallationId(params.claim)
      const installation = installationIdValue
        ? installationsStore.get(installationIdValue)
        : null
      if (!installation) {
        set.status = 404
        return 'Bootstrap link is invalid, expired, or already used.'
      }
      const script = await serverBootstrapService.claim(installation, params.claim)
      if (!script) {
        set.status = 404
        return 'Bootstrap link is invalid, expired, or already used.'
      }
      set.headers['content-type'] = 'text/x-shellscript; charset=utf-8'
      set.headers['cache-control'] = 'no-store'
      return script
    },
    {
      params: t.Object({
        claim: t.String({ minLength: 32, maxLength: 128 }),
      }),
    },
  )
  .get(
    '/artifacts/:token/:kind',
    ({ params, set }) => {
      const artifact = serverBootstrapService.artifact(params.token, params.kind)
      if (!artifact) {
        set.status = 404
        return 'Bootstrap artifact is invalid or expired.'
      }
      set.headers['content-disposition'] = `attachment; filename="${basename(artifact.path)}"`
      set.headers['x-content-sha256'] = artifact.digest
      set.headers['cache-control'] = 'private, no-store'
      return Bun.file(artifact.path)
    },
    {
      params: t.Object({
        token: t.String({ minLength: 32, maxLength: 128 }),
        kind: t.Union([
          t.Literal('bundle'),
          t.Literal('jre-x64'),
          t.Literal('jre-aarch64'),
        ]),
      }),
    },
  )
  .post(
    '/report/:token',
    ({ params, body, set }) => {
      const draft = serverBootstrapService.report(params.token, body.status, body.error)
      if (!draft) {
        set.status = 404
        return { message: 'Bootstrap report token is invalid.' }
      }
      return { received: true }
    },
    {
      params: t.Object({
        token: t.String({ minLength: 32, maxLength: 128 }),
      }),
      body: t.Object({
        status: t.Union([t.Literal('installed'), t.Literal('failed')]),
        error: t.Optional(t.String({ maxLength: 2000 })),
      }),
    },
  )
