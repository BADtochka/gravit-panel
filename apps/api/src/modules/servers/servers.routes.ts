import type { JobRecord, ServerBindingInput, ServerCommandType } from '@gravit-panel/shared'
import { Elysia, t } from 'elysia'
import { basename } from 'node:path'
import { installationsStore } from '../gravit/gravit.runtime'
import { activeJobForInstallation, jobsRunner } from '../jobs/jobs.runtime'
import {
  serverBindingService,
  serverAgentService,
  serverBrowserEventsService,
  serverBindingsStore,
  serverBootstrapService,
  serverBootstrapStore,
  serverPackService,
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
          if (result.deploymentChanged) {
            serverBootstrapStore.invalidateBinding(
              params.bindingId,
              'Server binding changed; prepare a new bootstrap bundle',
            )
          }
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
    '/bindings/:bindingId/pack',
    ({ params, query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      return serverPackService.listFiles(installation, params.bindingId)
    },
    { params: t.Object({ bindingId }), query: t.Object({ installationId }) },
  )
  .post(
    '/bindings/:bindingId/pack/files',
    async ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another server pack operation is active.', jobId: conflict.id }
      const bytes = new Uint8Array(await body.file.arrayBuffer())
      const job = jobsRunner.create(
        'gravit.server-pack.modify',
        { installationId: installation.id, bindingId: params.bindingId, path: body.path },
        'Server pack file upload queued',
        async (context) => {
          await serverPackService.putFile(installation, params.bindingId, body.path, bytes)
          const result = await serverPackService.publish(
            installation,
            params.bindingId,
            context,
          )
          serverBindingsStore.setDesiredPack(params.bindingId, result.version.id)
          return result
        },
      )
      set.status = 202
      return job
    },
    {
      params: t.Object({ bindingId }),
      body: t.Object({
        installationId,
        path: t.String({ minLength: 1, maxLength: 512 }),
        file: t.File({ maxSize: 256 * 1024 * 1024 }),
      }),
    },
  )
  .post(
    '/bindings/:bindingId/pack/files/remove',
    ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another server pack operation is active.', jobId: conflict.id }
      const job = jobsRunner.create(
        'gravit.server-pack.modify',
        { installationId: installation.id, bindingId: params.bindingId, path: body.path },
        'Server pack file removal queued',
        async (context) => {
          await serverPackService.removeFile(installation, params.bindingId, body.path)
          const result = await serverPackService.publish(
            installation,
            params.bindingId,
            context,
          )
          serverBindingsStore.setDesiredPack(params.bindingId, result.version.id)
          return result
        },
      )
      set.status = 202
      return job
    },
    {
      params: t.Object({ bindingId }),
      body: t.Object({
        installationId,
        path: t.String({ minLength: 1, maxLength: 512 }),
        confirmRemove: t.Literal(true),
      }),
    },
  )
  .post(
    '/bindings/:bindingId/pack/publish',
    ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another server pack operation is active.', jobId: conflict.id }
      const job = jobsRunner.create(
        'gravit.server-pack.publish',
        { installationId: installation.id, bindingId: params.bindingId },
        'Server pack publication queued',
        async (context) => {
          const result = await serverPackService.publish(
            installation,
            params.bindingId,
            context,
          )
          serverBindingsStore.setDesiredPack(params.bindingId, result.version.id)
          return result
        },
      )
      set.status = 202
      return job
    },
    {
      params: t.Object({ bindingId }),
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
    '/bindings/:bindingId/eula',
    ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const binding = serverBootstrapService.acceptEula(installation, params.bindingId)
      return { binding }
    },
    {
      params: t.Object({ bindingId }),
      body: t.Object({ installationId, accepted: t.Literal(true) }),
    },
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
          eulaAcceptedAt: serverBindingsStore.get(params.bindingId)?.eulaAcceptedAt,
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
      body: t.Object({ installationId }),
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
  .post(
    '/bootstrap/:draftId/revoke',
    ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      try {
        return { draft: serverBootstrapService.revoke(installation, params.draftId) }
      } catch (error) {
        set.status = 404
        return { message: error instanceof Error ? error.message : String(error) }
      }
    },
    {
      params: t.Object({ draftId: t.String({ format: 'uuid' }) }),
      body: t.Object({ installationId, confirmRevoke: t.Literal(true) }),
    },
  )
  .get(
    '/bindings/:bindingId/runtime',
    ({ params, query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const binding = serverBindingsStore.get(params.bindingId)
      if (!binding || binding.installationId !== installation.id) {
        set.status = 404
        return { message: 'Managed server binding not found.' }
      }
      return serverAgentService.runtime(binding.id!)
    },
    { params: t.Object({ bindingId }), query: t.Object({ installationId }) },
  )
  .post(
    '/bindings/:bindingId/commands',
    ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const binding = serverBindingsStore.get(params.bindingId)
      if (!binding || binding.installationId !== installation.id) {
        set.status = 404
        return { message: 'Managed server binding not found.' }
      }
      if (body.type === 'pack.apply') {
        const runtime = serverAgentService.runtime(binding.id!)
        if (!binding.updaterInstalledAt) {
          set.status = 409
          return { message: 'Server pack updater is not installed.' }
        }
        if (!binding.packVersionId || binding.packVersionId === binding.appliedPackVersionId) {
          set.status = 409
          return { message: 'The desired server pack is already applied.' }
        }
        if (!runtime.connected || !runtime.capabilities.includes('pack-updater')) {
          set.status = 409
          return { message: 'Connected host agent does not support immediate pack updates.' }
        }
      }
      try {
        const command = serverAgentService.createCommand(
          binding.id!,
          body.type as ServerCommandType,
          body.payload,
        )
        set.status = 202
        return command
      } catch (error) {
        set.status = 422
        return { message: error instanceof Error ? error.message : String(error) }
      }
    },
    {
      params: t.Object({ bindingId }),
      body: t.Object({
        installationId,
        type: t.Union([
          t.Literal('service.start'),
          t.Literal('service.stop'),
          t.Literal('service.restart'),
          t.Literal('console.execute'),
          t.Literal('pack.apply'),
        ]),
        payload: t.Object({
          command: t.Optional(t.String({ maxLength: 1000 })),
        }),
      }),
    },
  )
  .ws('/bindings/:bindingId/events/ws', {
    idleTimeout: 45,
    maxPayloadLength: 1024,
    query: t.Object({ installationId }),
    params: t.Object({ bindingId }),
    open: (socket) => {
      const { bindingId: bindingIdValue } = socket.data.params
      const installation = installationsStore.get(socket.data.query.installationId)
      const binding = serverBindingsStore.get(bindingIdValue)
      if (!installation || !binding || binding.installationId !== installation.id) {
        socket.close(1008, 'Managed server binding not found')
        return
      }
      serverBrowserEventsService.open(socket, binding.id!)
    },
    message: (socket, message) => serverBrowserEventsService.message(socket, message),
    close: (socket) => serverBrowserEventsService.close(socket),
  })

export const serverBootstrapRoutes = new Elysia({ prefix: '/server-bootstrap' })
  .get(
    '/:claim',
    ({ params, set }) => {
      const installationIdValue = serverBootstrapService.claimInstallationId(params.claim)
      const installation = installationIdValue
        ? installationsStore.get(installationIdValue)
        : null
      if (!installation) {
        set.status = 404
        return 'Bootstrap link is invalid or has completed.'
      }
      set.headers['content-type'] = 'text/x-shellscript; charset=utf-8'
      set.headers['cache-control'] = 'no-store'
      return serverBootstrapService.loader(params.claim)
    },
    {
      params: t.Object({
        claim: t.String({ minLength: 32, maxLength: 128 }),
      }),
    },
  )
  .post(
    '/:claim/start',
    async ({ params, set }) => {
      const installationIdValue = serverBootstrapService.claimInstallationId(params.claim)
      const installation = installationIdValue
        ? installationsStore.get(installationIdValue)
        : null
      if (!installation) {
        set.status = 404
        return 'Bootstrap link is invalid or has completed.'
      }
      try {
        const script = await serverBootstrapService.start(installation, params.claim)
        if (!script) {
          set.status = 404
          return 'Bootstrap link is invalid or has completed.'
        }
        set.headers['content-type'] = 'text/x-shellscript; charset=utf-8'
        set.headers['cache-control'] = 'no-store'
        return script
      } catch (error) {
        set.status = 409
        return error instanceof Error ? error.message : String(error)
      }
    },
    { params: t.Object({ claim: t.String({ minLength: 32, maxLength: 128 }) }) },
  )
  .get(
    '/:claim/artifacts/:kind',
    ({ params, set }) => {
      const artifact = serverBootstrapService.artifact(params.claim, params.kind)
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
        claim: t.String({ minLength: 32, maxLength: 128 }),
        kind: t.Union([
          t.Literal('bundle'),
          t.Literal('jre-x64'),
          t.Literal('jre-aarch64'),
        ]),
      }),
    },
  )
  .post(
    '/:claim/report',
    ({ params, body, set }) => {
      const draft = serverBootstrapService.report(
        params.claim,
        body.status,
        body.error,
        body.updaterToken,
      )
      if (!draft) {
        set.status = 404
        return { message: 'Bootstrap claim is invalid or has completed.' }
      }
      return { received: true }
    },
    {
      params: t.Object({
        claim: t.String({ minLength: 32, maxLength: 128 }),
      }),
      body: t.Object({
        status: t.Union([t.Literal('installed'), t.Literal('failed')]),
        error: t.Optional(t.String({ maxLength: 2000 })),
        updaterToken: t.Optional(t.String({ minLength: 32, maxLength: 128 })),
      }),
    },
  )

const bearerToken = (authorization: string | undefined) =>
  authorization?.match(/^Bearer ([A-Za-z0-9+/=_-]{32,256})$/)?.[1] ?? ''

export const serverAgentRoutes = new Elysia({ prefix: '/server-agent' })
  .ws('/connect', {
    idleTimeout: 45,
    maxPayloadLength: 1024 * 1024,
    open: (socket) => {
      serverAgentService.open(socket)
    },
    message: (socket, message) => {
      serverAgentService.handle(socket, message)
    },
    close: (socket) => {
      serverAgentService.close(socket)
    },
  })
  .get('/update', ({ headers, set }) => {
    const token = bearerToken(headers.authorization)
    const binding = serverBootstrapService.updaterBinding(token)
    if (!binding) {
      set.status = 401
      return 'Invalid updater credential.'
    }
    const script = serverBootstrapService.updaterScript(token)
    if (!script) {
      set.status = 204
      return ''
    }
    set.headers['content-type'] = 'text/x-shellscript; charset=utf-8'
    set.headers['cache-control'] = 'no-store'
    return script
  })
  .get(
    '/archive/:versionId',
    ({ params, headers, set }) => {
      const token = bearerToken(headers.authorization)
      const artifact = serverBootstrapService.updaterArchive(token, params.versionId)
      if (!artifact) {
        set.status = 404
        return 'Server pack is unavailable.'
      }
      set.headers['content-disposition'] = `attachment; filename="${basename(artifact.path)}"`
      set.headers['x-content-sha256'] = artifact.digest
      set.headers['cache-control'] = 'private, no-store'
      return Bun.file(artifact.path)
    },
    { params: t.Object({ versionId: t.String({ format: 'uuid' }) }) },
  )
  .post(
    '/report',
    ({ headers, body, set }) => {
      const token = bearerToken(headers.authorization)
      const binding = serverBootstrapService.reportUpdater(
        token,
        body.packVersionId,
        body.status,
        body.error,
      )
      if (!binding) {
        set.status = 404
        return { message: 'Updater credential or desired pack is invalid.' }
      }
      return { received: true }
    },
    {
      body: t.Object({
        packVersionId: t.String({ format: 'uuid' }),
        status: t.Union([t.Literal('installed'), t.Literal('failed')]),
        error: t.Optional(t.String({ maxLength: 2000 })),
      }),
    },
  )
