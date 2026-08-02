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
  }, async () => Response.json({ workflow_runs: [{ head_sha: latestRevision }] }))

  expect(await service.status()).toMatchObject({
    configured: false,
    deployEnabled: false,
    currentRevision,
    latestRevision,
    updateAvailable: true,
    message: null,
  })
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
