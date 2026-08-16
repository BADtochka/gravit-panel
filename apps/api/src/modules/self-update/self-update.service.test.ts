import { expect, test } from 'bun:test'
import {
  SelfUpdateConflictError,
  SelfUpdateService,
  SelfUpdateUnavailableError,
} from './self-update.service'

const currentRevision = 'a'.repeat(40)
const latestRevision = 'b'.repeat(40)

test('detects a newer successfully published panel revision', async () => {
  const service = new SelfUpdateService({
    currentRevision,
    repository: 'BADtochka/gravit-panel',
    githubToken: 'github-token',
  }, async () => Response.json({ tag_name: `panel-${latestRevision}` }))

  expect(await service.status()).toMatchObject({
    configured: false,
    deployEnabled: false,
    currentRevision,
    latestRevision,
    updateAvailable: true,
    message: null,
  })
})

test('checks public releases without an update token', async () => {
  let requests = 0
  const service = new SelfUpdateService({
    currentRevision,
    repository: 'BADtochka/gravit-panel',
  }, async () => {
    requests += 1
    return Response.json({ tag_name: `panel-${latestRevision}` })
  })

  expect(await service.status()).toMatchObject({
    latestRevision,
    updateAvailable: true,
    deployEnabled: false,
    message: null,
  })
  expect(requests).toBe(1)
})

test('bypasses the release cache for a forced status check', async () => {
  let revision = latestRevision
  const service = new SelfUpdateService({
    currentRevision,
    repository: 'BADtochka/gravit-panel',
  }, async () => Response.json({ tag_name: `panel-${revision}` }))

  expect((await service.status()).latestRevision).toBe(latestRevision)
  revision = 'c'.repeat(40)
  expect((await service.status()).latestRevision).toBe(latestRevision)
  expect((await service.status(true)).latestRevision).toBe(revision)
})

test('queues one forced Coolify Compose deployment without exposing credentials', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const service = new SelfUpdateService({
    currentRevision,
    repository: 'BADtochka/gravit-panel',
    coolifyApiUrl: 'https://coolify.example.com/api/v1',
    coolifyApiToken: 'secret-token',
    coolifyApplicationUuid: 'application-uuid',
  }, (async (input, init) => {
    requests.push({ url: String(input), init })
    return Response.json({
      deployments: [{
        resource_uuid: 'application-uuid',
        deployment_uuid: 'deployment-uuid',
        message: 'Application deployment queued.',
      }],
    })
  }))

  const result = await service.deploy()

  expect(result).toEqual({
    accepted: true,
    deploymentUuid: 'deployment-uuid',
    message: 'Application deployment queued.',
  })
  expect(requests[0]?.url).toBe('https://coolify.example.com/api/v1/deploy')
  expect(requests[0]?.init).toMatchObject({
    method: 'POST',
    body: JSON.stringify({ uuid: 'application-uuid', force: true }),
  })
  expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe('Bearer secret-token')
  await expect(service.deploy()).rejects.toBeInstanceOf(SelfUpdateConflictError)
  expect(JSON.stringify(result)).not.toContain('secret-token')
})

test('rejects deployment when Coolify is not configured', async () => {
  const service = new SelfUpdateService({ repository: 'BADtochka/gravit-panel' })
  await expect(service.deploy()).rejects.toBeInstanceOf(SelfUpdateUnavailableError)
})
