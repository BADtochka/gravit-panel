import { Elysia, t } from 'elysia'
import { jobsBrowserEventsService, jobsRunner, jobsStore } from './jobs.runtime'

export const jobsRoutes = new Elysia({ prefix: '/jobs' })
  .get(
    '/',
    ({ query }) => ({
      items: jobsStore.list(query.limit),
      runningIds: jobsRunner.runningIds(),
    }),
    {
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 50 })),
      }),
    },
  )
  .post('/demo', ({ set }) => {
    set.status = 202
    return jobsRunner.createDemoJob()
  })
  .get(
    '/active',
    ({ query }) => ({
      job: jobsStore
        .listByStatuses(['queued', 'running'])
        .find((job) => job.input.installationId === query.installationId) ?? null,
    }),
    {
      query: t.Object({
        installationId: t.String({ format: 'uuid' }),
      }),
    },
  )
  .post('/:id/cancel', ({ params, set }) => {
    const existing = jobsStore.get(params.id)
    if (!existing) {
      set.status = 404
      return { message: 'Job not found' }
    }
    if (existing.status !== 'queued' && existing.status !== 'running') {
      set.status = 409
      return { message: 'Only queued or running jobs can be cancelled.', job: existing }
    }
    set.status = 202
    return jobsRunner.cancel(params.id)
  })
  .get('/:id', ({ params, set }) => {
    const job = jobsStore.get(params.id)
    if (job) return job

    set.status = 404
    return { message: 'Job not found' }
  })
  .ws('/:id/events/ws', {
    idleTimeout: 45,
    maxPayloadLength: 1024,
    params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }),
    open: (socket) => jobsBrowserEventsService.open(socket, socket.data.params.id),
    message: (socket, message) => jobsBrowserEventsService.message(socket, message),
    close: (socket) => jobsBrowserEventsService.close(socket),
  })
