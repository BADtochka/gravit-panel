import { database } from '../../db/client'
import { JobsEventHub } from './jobs.events'
import { JobsRunner } from './jobs.runner'
import { JobsStore } from './jobs.store'
import { JobsBrowserEventsService } from './jobs-browser-events.service'

export const jobsStore = new JobsStore(database)
export const jobsEventHub = new JobsEventHub()
export const jobsBrowserEventsService = new JobsBrowserEventsService(jobsStore, jobsEventHub)
export const jobsRunner = new JobsRunner(jobsStore, jobsEventHub)

export const activeJobForInstallation = (installationId: string) =>
  jobsStore
    .listByStatuses(['queued', 'running'])
    .find((job) => job.input.installationId === installationId)
