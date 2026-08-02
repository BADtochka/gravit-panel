import { describe, expect, test } from 'bun:test'
import { app } from './app'
import { jobsStore } from './modules/jobs/jobs.runtime'

const request = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://127.0.0.1${path}`, init))

describe('API smoke routes', () => {
  test('reports service health', async () => {
    const response = await request('/api/health')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      service: 'gravit-panel-api',
      status: 'ok',
      version: '0.1.0',
    })
    expect(new Date(body.time).toString()).not.toBe('Invalid Date')
  })

  test('reports the current setup slice', async () => {
    const response = await request('/api/setup/plan')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.currentSlice).toBe('mvp-complete')
    expect(body.completedSlices).toEqual([
      'workspace-scaffold',
      'jobs',
      'docker-preflight',
      'launcherdockered-install',
      'launchserver-command-transport',
      'remote-control',
      'modules',
      'side-project-compatibility',
      'launcher-build',
      'client-build',
      'mod-manager',
      'file-auth-recipe',
      'existing-server-attach',
      'profile-aware-layout',
    ])
    expect(body.nextSlices).toEqual([])
  })

  test('reports pinned client, compatibility, and Modrinth sources', async () => {
    const [clientsResponse, compatibilityResponse, providersResponse] = await Promise.all([
      request('/api/clients/configuration'),
      request('/api/clients/compatibility?minecraftVersion=1.21.4'),
      request('/api/mods/providers'),
    ])
    const clients = await clientsResponse.json()
    const compatibility = await compatibilityResponse.json()
    const providers = await providersResponse.json()

    expect(clients.sources.prestarter).toMatchObject({
      tag: 'v2.1.0',
      sha256: 'e206a35615b91ae21a13154b7cb4dda9c742a2a45211880e79100bb09636de7f',
    })
    expect(clients.sources.runtime).toMatchObject({
      repository: 'https://github.com/GravitLauncher/LauncherRuntime',
      tag: 'v5.0.7',
      revision: '755e5509b1f573817a977b4180a2f84517619025',
      compatibleLauncherVersion: '5.7.9',
    })
    expect(compatibility.authlibArtifact).toBe('LauncherAuthlib6.jar')
    expect(providers.source.revision).toBe('366f528853dc32701e9670fd8d9c51fa3d136441')
  })

  test('requires destructive confirmations for workspace and mod removal', async () => {
    const id = crypto.randomUUID()
    const [workspaceResponse, removeResponse] = await Promise.all([
      request('/api/clients/workspace/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installationId: id, confirmDestructive: false }),
      }),
      request('/api/mods/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          installationId: id,
          profile: 'fabric',
          filename: 'sodium.jar',
          confirmRemoval: false,
        }),
      }),
    ])

    expect(workspaceResponse.status).toBe(422)
    expect(removeResponse.status).toBe(422)
  })

  test('runs the Docker preflight with the source-verified default port', async () => {
    const response = await request('/api/docker/preflight')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.port).toBe(17549)
    expect(body.checkedAt).toBeString()
    expect(body.checks.map((check: { id: string }) => check.id)).toEqual([
      'docker-cli',
      'docker-compose',
      'docker-port',
    ])
    expect(body.source).toEqual({
      repository: 'https://github.com/GravitLauncher/LauncherDockered',
      revision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      file: 'docker-compose.yml',
    })
  })

  test('validates a custom Docker host port', async () => {
    const response = await request('/api/docker/preflight?port=70000')
    expect(response.status).toBe(422)
  })

  test('requires an explicit confirmation before installation', async () => {
    const configurationResponse = await request('/api/docker/install/configuration')
    const configuration = await configurationResponse.json()

    expect(configurationResponse.status).toBe(200)
    expect(configuration.launchServerPath).toStartWith('/')
    expect(configuration.defaultAddress).toBe('localhost:9274')
    expect(configuration).not.toHaveProperty('machineOperationsEnabled')

    const installResponse = await request('/api/docker/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'clone',
        address: 'localhost:17549',
        projectName: 'TEST_PROJECT',
        confirmInstallation: false,
      }),
    })

    expect(installResponse.status).toBe(422)
  })

  test('rejects LaunchServer commands for an unknown installation', async () => {
    const response = await request('/api/gravit/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: crypto.randomUUID() }),
    })
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.message).toContain('not found')
  })

  test('reports RemoteControl credential readiness without exposing secrets', async () => {
    const response = await request('/api/gravit/remote-control/configuration')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.encryptionConfigured).toBe(false)
    expect(body.encryptionSource).toBeNull()
    expect(body.canGenerateEncryptionKey).toBe(true)
    expect(body.allowedCommands).toEqual(['serverStatus', 'securitycheck'])
    expect(JSON.stringify(body)).not.toContain('token')
  })

  test('reports the single managed LaunchServer', async () => {
    const response = await request('/api/docker/launchserver')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.item).toBeNull()
  })

  test('returns a source-verified module catalog', async () => {
    const response = await request('/api/modules/catalog')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.source.repository).toBe('https://github.com/GravitLauncher/LauncherModules')
    expect(body.source.revision).toHaveLength(40)
    expect(body.release).toMatchObject({
      tag: 'v5.7.9',
      asset: 'LaunchServerBuild.zip',
    })
    expect(body.release.sha256).toHaveLength(64)
    expect(body.serverModules).toContainEqual(expect.objectContaining({
      id: 'Prestarter_module',
      name: 'Prestarter',
      directory: 'Prestarter_module',
      jar: 'Prestarter_module.jar',
      kind: 'server',
      category: 'server',
    }))
    expect(body.authModules).toContainEqual(expect.objectContaining({
      id: 'FileAuthSystem_module',
      name: 'FileAuthSystem',
      category: 'auth',
      source: {
        repository: 'https://github.com/GravitLauncher/LauncherModules',
        revision: body.source.revision,
        path: 'FileAuthSystem_module',
      },
    }))
    expect(body.authModules).toContainEqual(expect.objectContaining({
      id: 'DiscordAuthSystem_module',
      name: 'DiscordAuthSystem',
      category: 'auth',
      source: {
        repository: 'https://github.com/BADtochka/gravit-panel',
        revision: 'main',
        path: 'modules/DiscordAuthSystem_module',
      },
    }))
    expect(body.serverModules.some((item: { name: string }) => item.name === 'FileAuthSystem')).toBe(
      false,
    )
    expect(body.serverModules.some((item: { name: string }) => item.name === 'S3Updates')).toBe(false)
    expect(body.launcherModules.some((item: { name: string }) => item.name === 'JavaRuntime')).toBe(
      false,
    )
  })

  test('rejects module operations for an unknown installation', async () => {
    const installationId = crypto.randomUUID()
    const stateResponse = await request(`/api/modules/state?installationId=${installationId}`)
    const installResponse = await request('/api/modules/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId,
        moduleId: 'MirrorHelper_module',
      }),
    })

    expect(stateResponse.status).toBe(404)
    expect(installResponse.status).toBe(404)
  })

  test('requires explicit confirmation before generating an encryption key', async () => {
    const response = await request('/api/gravit/remote-control/encryption-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmGeneration: false }),
    })

    expect(response.status).toBe(422)
  })

  test('generates an in-memory test key without exposing its value', async () => {
    const response = await request('/api/gravit/remote-control/encryption-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmGeneration: true }),
    })
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body).toEqual({
      encryptionConfigured: true,
      encryptionSource: 'memory',
      canGenerateEncryptionKey: false,
    })
    expect(body).not.toHaveProperty('key')
    expect(body).not.toHaveProperty('credentialEncryptionKey')
  })

  test('allows configured local origins only', async () => {
    const allowed = await request('/api/health', {
      headers: { Origin: 'http://127.0.0.1:5173' },
    })
    const rejected = await request('/api/health', {
      headers: { Origin: 'https://example.com' },
    })

    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')
    expect(rejected.headers.has('access-control-allow-origin')).toBe(false)
  })
})

describe('jobs lifecycle', () => {
  test('persists a demo job and its events', async () => {
    const createResponse = await request('/api/jobs/demo', { method: 'POST' })
    const createdJob = await createResponse.json()

    expect(createResponse.status).toBe(202)
    expect(createdJob).toMatchObject({
      type: 'demo.noop',
      status: 'queued',
      progress: 0,
    })

    const deadline = Date.now() + 2_000
    let completedJob = await (await request(`/api/jobs/${createdJob.id}`)).json()
    while (completedJob.status !== 'succeeded' && Date.now() < deadline) {
      await Bun.sleep(10)
      completedJob = await (await request(`/api/jobs/${createdJob.id}`)).json()
    }

    expect(completedJob).toMatchObject({
      id: createdJob.id,
      status: 'succeeded',
      progress: 100,
      result: { message: 'No-op job completed successfully' },
    })

    const listResponse = await request('/api/jobs?limit=10')
    const jobs = await listResponse.json()
    expect(jobs.items.some((job: { id: string }) => job.id === createdJob.id)).toBe(true)
    expect(jobs.runningIds).not.toContain(createdJob.id)
    const eventTypes = jobsStore.listEvents(createdJob.id).map((event) => event.type)
    expect(eventTypes.slice(0, 2)).toEqual(['queued', 'started'])
    expect(eventTypes).toContain('progress')
    expect(eventTypes.at(-1)).toBe('completed')
  })

  test('cancels a running job and persists its terminal event', async () => {
    const createResponse = await request('/api/jobs/demo', { method: 'POST' })
    const createdJob = await createResponse.json()
    const cancelResponse = await request(`/api/jobs/${createdJob.id}/cancel`, {
      method: 'POST',
    })

    expect(cancelResponse.status).toBe(202)
    const deadline = Date.now() + 2_000
    let cancelledJob = await (await request(`/api/jobs/${createdJob.id}`)).json()
    while (cancelledJob.status !== 'cancelled' && Date.now() < deadline) {
      await Bun.sleep(10)
      cancelledJob = await (await request(`/api/jobs/${createdJob.id}`)).json()
    }
    expect(cancelledJob).toMatchObject({
      id: createdJob.id,
      status: 'cancelled',
      error: null,
    })

    expect(jobsStore.listEvents(createdJob.id).some((event) => event.type === 'cancelled')).toBe(true)
    const duplicateCancel = await request(`/api/jobs/${createdJob.id}/cancel`, {
      method: 'POST',
    })
    expect(duplicateCancel.status).toBe(409)
  })
})
