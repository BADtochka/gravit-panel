import { Elysia, t } from 'elysia'
import { activeJobForInstallation } from '../jobs/jobs.runtime'
import { installationsStore, launchServerFilesService } from './gravit.runtime'

const installationId = t.String({ format: 'uuid' })
const path = t.String({ minLength: 1, maxLength: 512 })

const installationFor = (id: string, set: { status?: number | string }, mutation = false) => {
  const installation = installationsStore.get(id)
  if (!installation) {
    set.status = 404
    return null
  }
  if (mutation && activeJobForInstallation(id)) {
    set.status = 409
    return null
  }
  return installation
}

const fileError = (set: { status?: number | string }, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  set.status = /not found|no such file/i.test(message) ? 404 : 422
  return { message }
}

export const launchServerFilesRoutes = new Elysia({ prefix: '/gravit/files' })
  .get('/', async ({ query, set }) => {
    const installation = installationFor(query.installationId, set)
    if (!installation) return { message: 'LauncherDockered installation not found.' }
    try {
      return await launchServerFilesService.list(installation, query.path ?? '')
    } catch (error) {
      return fileError(set, error)
    }
  }, { query: t.Object({ installationId, path: t.Optional(t.String({ maxLength: 512 })) }) })
  .get('/file', async ({ query, set }) => {
    const installation = installationFor(query.installationId, set)
    if (!installation) return { message: 'LauncherDockered installation not found.' }
    try {
      return await launchServerFilesService.read(installation, query.path)
    } catch (error) {
      return fileError(set, error)
    }
  }, { query: t.Object({ installationId, path }) })
  .post('/file', async ({ body, set }) => {
    const installation = installationFor(body.installationId, set, true)
    if (!installation) return { message: 'LaunchServer files are unavailable during another machine operation.' }
    try {
      return await launchServerFilesService.write(
        installation,
        body.path,
        new TextEncoder().encode(body.content),
        body.overwrite,
      )
    } catch (error) {
      return fileError(set, error)
    }
  }, {
    body: t.Object({ installationId, path, content: t.String({ maxLength: 512 * 1024 }), overwrite: t.Boolean() }),
  })
  .post('/upload', async ({ body, set }) => {
    const installation = installationFor(body.installationId, set, true)
    if (!installation) return { message: 'LaunchServer files are unavailable during another machine operation.' }
    try {
      return await launchServerFilesService.write(
        installation,
        body.path,
        new Uint8Array(await body.file.arrayBuffer()),
        body.overwrite === 'true',
      )
    } catch (error) {
      return fileError(set, error)
    }
  }, {
    body: t.Object({ installationId, path, overwrite: t.String(), file: t.File({ maxSize: 512 * 1024 }) }),
  })
  .post('/operations', async ({ body, set }) => {
    const installation = installationFor(body.installationId, set, true)
    if (!installation) return { message: 'LaunchServer files are unavailable during another machine operation.' }
    try {
      if (body.action === 'mkdir') return await launchServerFilesService.mkdir(installation, body.path)
      if (body.action === 'move') {
        return await launchServerFilesService.move(installation, body.sourcePath, body.destinationPath)
      }
      return await launchServerFilesService.remove(installation, body.paths)
    } catch (error) {
      return fileError(set, error)
    }
  }, {
    body: t.Union([
      t.Object({ installationId, action: t.Literal('mkdir'), path }),
      t.Object({ installationId, action: t.Literal('move'), sourcePath: path, destinationPath: path }),
      t.Object({ installationId, action: t.Literal('delete'), paths: t.Array(path, { minItems: 1, maxItems: 100, uniqueItems: true }), confirmRemove: t.Literal(true) }),
    ]),
  })
