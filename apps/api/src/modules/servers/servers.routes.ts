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

const liveBinding = (
  installationIdValue: string,
  bindingIdValue: string,
  set: { status?: number | string },
) => {
  const installation = findInstallation(installationIdValue, set)
  if (!installation) return null
  const binding = serverBindingsStore.get(bindingIdValue)
  if (!binding || binding.installationId !== installation.id) {
    set.status = 404
    return null
  }
  return { installation, binding }
}

const liveFileError = (set: { status?: number | string }, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  set.status = message.includes('offline') || message.includes('does not support') ? 409 : 422
  return { message }
}

const serverPacksDisabled = (set: { status?: number | string }) => {
  set.status = 410
  return { message: 'Server packs are disabled. Use live server files instead.' }
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
  .get(
    '/profiles/:profile/mods',
    async ({ params, query, set }) => {
      const installation = findInstallation(query.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const bindings = serverBindingsStore.list(installation.id, params.profile)
        .filter((binding) => binding.managed && binding.id)
      const items = await Promise.all(bindings.map(async (binding) => {
        try {
          const result = await serverAgentService.requestFilesystem(binding.id!, 'list', {
            path: 'mods',
          }) as { entries?: Array<{ path: string; type: string; size: number | null; modifiedAt: string }> }
          return {
            bindingId: binding.id!,
            serverName: binding.name,
            connected: true,
            error: null,
            items: (result.entries ?? []).filter((entry) =>
              entry.type === 'file' && entry.path.toLowerCase().endsWith('.jar')),
          }
        } catch (error) {
          return {
            bindingId: binding.id!,
            serverName: binding.name,
            connected: false,
            error: error instanceof Error ? error.message : String(error),
            items: [],
          }
        }
      }))
      return { items }
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
  .get(
    '/bindings/:bindingId/files',
    async ({ params, query, set }) => {
      const target = liveBinding(query.installationId, params.bindingId, set)
      if (!target) return { message: 'Managed server binding not found.' }
      try {
        return await serverAgentService.requestFilesystem(params.bindingId, 'list', {
          path: query.path ?? '',
        })
      } catch (error) {
        return liveFileError(set, error)
      }
    },
    {
      params: t.Object({ bindingId }),
      query: t.Object({ installationId, path: t.Optional(t.String({ maxLength: 512 })) }),
    },
  )
  .get(
    '/bindings/:bindingId/files/file',
    async ({ params, query, set }) => {
      const target = liveBinding(query.installationId, params.bindingId, set)
      if (!target) return { message: 'Managed server binding not found.' }
      try {
        const result = await serverAgentService.requestFilesystem(params.bindingId, 'read', {
          path: query.path,
          maxBytes: 512 * 1024,
        }) as { data: string; [key: string]: unknown }
        const bytes = Buffer.from(result.data, 'base64')
        if (bytes.includes(0)) throw new Error('Binary files cannot be opened in the text editor')
        return { ...result, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), data: undefined }
      } catch (error) {
        return liveFileError(set, error)
      }
    },
    {
      params: t.Object({ bindingId }),
      query: t.Object({ installationId, path: t.String({ minLength: 1, maxLength: 512 }) }),
    },
  )
  .post(
    '/bindings/:bindingId/files/file',
    ({ params, body, set }) => {
      const target = liveBinding(body.installationId, params.bindingId, set)
      if (!target) return { message: 'Managed server binding not found.' }
      const conflict = conflictFor(target.installation.id, set)
      if (conflict) return { message: 'Another server operation is active.', jobId: conflict.id }
      const bytes = new TextEncoder().encode(body.content)
      if (bytes.length > 512 * 1024) {
        set.status = 422
        return { message: 'Live editor supports files up to 512 KiB.' }
      }
      const job = jobsRunner.create(
        'gravit.server.files.modify',
        { installationId: target.installation.id, bindingId: params.bindingId, action: 'write', path: body.path },
        'Live server file save queued',
        async (context) => {
          context.progress(20, 'Writing live server file')
          const result = await serverAgentService.requestFilesystem(params.bindingId, 'write', {
            path: body.path,
            data: Buffer.from(bytes).toString('base64'),
            overwrite: body.overwrite,
            maxBytes: 512 * 1024,
          })
          context.progress(95, 'Live server file applied')
          return result as Record<string, unknown>
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
        content: t.String({ maxLength: 512 * 1024 }),
        overwrite: t.Boolean(),
      }),
    },
  )
  .post(
    '/bindings/:bindingId/files/upload',
    async ({ params, body, set }) => {
      const target = liveBinding(body.installationId, params.bindingId, set)
      if (!target) return { message: 'Managed server binding not found.' }
       const conflict = conflictFor(target.installation.id, set)
       if (conflict) return { message: 'Another server operation is active.', jobId: conflict.id }
       const bytes = new Uint8Array(await body.file.arrayBuffer())
       if (bytes.length > 256 * 1024 * 1024) {
         set.status = 422
         return { message: 'Live uploads currently support files up to 256 MiB.' }
      }
       const job = jobsRunner.create(
         'gravit.server.files.modify',
         { installationId: target.installation.id, bindingId: params.bindingId, action: 'upload', path: body.path },
         'Live server file upload queued',
         async (context) => {
           context.progress(20, 'Uploading live server file')
           const result = await serverAgentService.requestFilesystem(params.bindingId, 'write', {
             path: body.path,
             data: Buffer.from(bytes).toString('base64'),
             overwrite: body.overwrite === 'true',
             maxBytes: 256 * 1024 * 1024,
           })
           context.progress(95, 'Live server file applied')
           return result as Record<string, unknown>
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
        overwrite: t.String(),
         file: t.File({ maxSize: 256 * 1024 * 1024 }),
      }),
    },
  )
  .post(
    '/bindings/:bindingId/files/operations',
    ({ params, body, set }) => {
      const target = liveBinding(body.installationId, params.bindingId, set)
      if (!target) return { message: 'Managed server binding not found.' }
      const conflict = conflictFor(target.installation.id, set)
      if (conflict) return { message: 'Another server operation is active.', jobId: conflict.id }
      const job = jobsRunner.create(
        'gravit.server.files.modify',
        { installationId: target.installation.id, bindingId: params.bindingId, action: body.action },
        `Live server file ${body.action} queued`,
        async (context) => {
          context.progress(20, `Applying live server file ${body.action}`)
          const result = body.action === 'mkdir'
            ? await serverAgentService.requestFilesystem(params.bindingId, 'mkdir', { path: body.path })
            : body.action === 'move'
              ? await serverAgentService.requestFilesystem(params.bindingId, 'move', {
                sourcePath: body.sourcePath,
                destinationPath: body.destinationPath,
              })
              : await serverAgentService.requestFilesystem(params.bindingId, 'delete', {
                paths: body.paths,
                confirm: true,
              })
          context.progress(95, 'Live server files applied')
          return result as Record<string, unknown>
        },
      )
      set.status = 202
      return job
    },
    {
      params: t.Object({ bindingId }),
      body: t.Union([
        t.Object({ installationId, action: t.Literal('mkdir'), path: t.String({ minLength: 1, maxLength: 512 }) }),
        t.Object({ installationId, action: t.Literal('move'), sourcePath: t.String({ minLength: 1, maxLength: 512 }), destinationPath: t.String({ minLength: 1, maxLength: 512 }) }),
        t.Object({ installationId, action: t.Literal('delete'), paths: t.Array(t.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 100, uniqueItems: true }), confirmRemove: t.Literal(true) }),
      ]),
    },
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
    ({ set }) => {
      return serverPacksDisabled(set)
    },
    { params: t.Object({ bindingId }), query: t.Object({ installationId }) },
  )
  .post(
    '/bindings/:bindingId/pack/files',
    ({ set }) => {
      return serverPacksDisabled(set)
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
    '/bindings/:bindingId/pack/operations',
    ({ set }) => {
      return serverPacksDisabled(set)
    },
    {
      params: t.Object({ bindingId }),
      body: t.Union([
        t.Object({
          installationId,
          action: t.Literal('mkdir'),
          path: t.String({ minLength: 1, maxLength: 512 }),
        }),
        t.Object({
          installationId,
          action: t.Literal('create-file'),
          path: t.String({ minLength: 1, maxLength: 512 }),
          content: t.Optional(t.String({ maxLength: 1024 * 1024 })),
        }),
        t.Object({
          installationId,
          action: t.Literal('move'),
          sourcePath: t.String({ minLength: 1, maxLength: 512 }),
          destinationPath: t.String({ minLength: 1, maxLength: 512 }),
        }),
        t.Object({
          installationId,
          action: t.Literal('delete'),
          paths: t.Array(t.String({ minLength: 1, maxLength: 512 }), {
            minItems: 1,
            maxItems: 200,
            uniqueItems: true,
          }),
          confirmRemove: t.Literal(true),
        }),
      ]),
    },
  )
  .get(
    '/bindings/:bindingId/pack/file',
    ({ set }) => {
      return serverPacksDisabled(set)
    },
    {
      params: t.Object({ bindingId }),
      query: t.Object({ installationId, path: t.String({ minLength: 1, maxLength: 512 }) }),
    },
  )
  .post(
    '/bindings/:bindingId/pack/file',
    ({ set }) => {
      return serverPacksDisabled(set)
    },
    {
      params: t.Object({ bindingId }),
      body: t.Object({
        installationId,
        path: t.String({ minLength: 1, maxLength: 512 }),
        content: t.String({ maxLength: 1024 * 1024 }),
      }),
    },
  )
  .post(
    '/bindings/:bindingId/pack/files/remove',
    ({ set }) => {
      return serverPacksDisabled(set)
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
    ({ set }) => {
      return serverPacksDisabled(set)
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
    async ({ params, body, set }) => {
      const installation = findInstallation(body.installationId, set)
      if (!installation) return { message: 'LauncherDockered installation not found.' }
      const conflict = conflictFor(installation.id, set)
      if (conflict) return { message: 'Another server operation is active.', jobId: conflict.id }
      const artifacts = await serverBootstrapService.agentArtifactsReadiness()
      if (!artifacts.ready) {
        set.status = 409
        return { message: artifacts.message }
      }
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
    '/bindings/:bindingId/pack/deploy',
    ({ set }) => {
      return serverPacksDisabled(set)
    },
    {
      params: t.Object({ bindingId }),
      body: t.Object({ installationId }),
    },
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
      try {
        const type = body.type as ServerCommandType
        if (type === 'console.execute') {
          const command = serverAgentService.createCommand(binding.id!, type, body.payload)
          set.status = 202
          return command
        }
        if (!serverAgentService.isConnected(binding.id!)) {
          set.status = 409
          return { message: 'Host agent is offline.' }
        }
        const conflict = conflictFor(installation.id, set)
        if (conflict) return { message: 'Another server operation is active.', jobId: conflict.id }
        const action = type.slice('service.'.length)
        const job = jobsRunner.create(
          'gravit.server.service',
          { installationId: installation.id, bindingId: binding.id!, type },
          `${binding.name} ${action} queued`,
          async (context) => {
            context.progress(10, `Requesting server ${action}`)
            const command = serverAgentService.createCommand(binding.id!, type, {})
            context.progress(40, 'Waiting for host agent')
            const completed = await serverAgentService.waitForCommand(command.id, context.signal)
            context.progress(95, `Server ${action} completed`)
            return { bindingId: binding.id!, commandId: completed.id, type }
          },
        )
        set.status = 202
        return job
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

export const serverAgentRoutes = new Elysia({ prefix: '/server-agent' })
  .ws('/connect', {
    idleTimeout: 45,
     maxPayloadLength: 384 * 1024 * 1024,
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
  .get('/update', ({ set }) => {
    return serverPacksDisabled(set)
  })
  .get(
    '/archive/:versionId',
    ({ set }) => {
      return serverPacksDisabled(set)
    },
    { params: t.Object({ versionId: t.String({ format: 'uuid' }) }) },
  )
  .post(
    '/report',
    ({ set }) => {
      return serverPacksDisabled(set)
    },
    {
      body: t.Object({
        packVersionId: t.String({ format: 'uuid' }),
        status: t.Union([t.Literal('installed'), t.Literal('failed')]),
        error: t.Optional(t.String({ maxLength: 2000 })),
      }),
    },
  )
