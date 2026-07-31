import {
  finishJobNotification,
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

  test('keeps the running job tracked until its terminal event before showing queued work', () => {
    const now = new Date().toISOString()
    const running = {
      id: crypto.randomUUID(),
      type: 'gravit.mods.install',
      status: 'running',
      progress: 85,
      input: {},
      result: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    } as JobRecord
    const queued = {
      ...running,
      id: crypto.randomUUID(),
      status: 'queued',
      progress: 0,
      startedAt: null,
    } as JobRecord
    const { trackedJob } = useJobNotifications()
    if (trackedJob.value) {
      finishJobNotification({
        ...trackedJob.value,
        status: 'succeeded',
        progress: 100,
        finishedAt: now,
      })
    }

    registerJobNotification(running, 'Running mod operation', () => {})
    registerJobNotification(queued, 'Queued mod operation', () => {})
    expect(trackedJob.value?.id).toBe(running.id)

    finishJobNotification({
      ...running,
      status: 'succeeded',
      progress: 100,
      finishedAt: now,
    })
    registerJobNotification(queued, 'Queued mod operation', () => {})
    expect(trackedJob.value?.id).toBe(queued.id)
  })
})
