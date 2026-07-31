import {
  registerJobNotification,
  useJobNotifications,
} from '../src/stores/job-notifications'
import type { JobRecord } from '@gravit-panel/shared'
import { describe, expect, test } from 'bun:test'

describe('global job notifications', () => {
  test('keeps tracking a job after its source page unmounts', () => {
    const job = {
      id: crypto.randomUUID(),
      installationId: crypto.randomUUID(),
      type: 'demo.noop',
      status: 'running',
      progress: 40,
      input: {},
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
    } as JobRecord
    const { trackedJob, trackedTitle } = useJobNotifications()

    const unregisterPage = registerJobNotification(job, 'Profile operation', () => {})
    unregisterPage()

    expect(trackedJob.value?.id).toBe(job.id)
    expect(trackedJob.value?.progress).toBe(40)
    expect(trackedTitle.value).toBe('Profile operation')
  })
})
