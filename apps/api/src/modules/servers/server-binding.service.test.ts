import { expect, test } from 'bun:test'
import type {
  ClientProfileDescriptor,
  GravitInstallation,
  ProfileServer,
} from '@gravit-panel/shared'
import { Database } from 'bun:sqlite'
import { schema } from '../../db/schema'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { ServerBindingService } from './server-binding.service'
import { ServerBindingsStore } from './server-bindings.store'

const context: JobTaskContext = {
  signal: new AbortController().signal,
  log: () => {},
  progress: () => {},
}

test('server binding adopts a legacy server and reconciles the default atomically', async () => {
  const db = new Database(':memory:')
  db.exec(schema)
  const installation: GravitInstallation = {
    id: '16db6f04-c249-41cf-a341-8f064cc04575',
    name: 'default',
    path: '/tmp/default',
    address: 'mine.example.com',
    projectName: 'default',
    sourceRepository: 'test',
    sourceRevision: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  db.query(`
    INSERT INTO gravit_installations (
      id, name, path, address, project_name, source_repository,
      source_revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    installation.id,
    installation.name,
    installation.path,
    installation.address,
    installation.projectName,
    installation.sourceRepository,
    installation.sourceRevision,
    installation.createdAt,
    installation.updatedAt,
  )
  let servers: ProfileServer[] = [{
    name: 'Legacy',
    serverAddress: 'old.example.com',
    serverPort: 25565,
    isDefault: true,
    protocol: -1,
    socketPing: true,
  }]
  const descriptor = (): ClientProfileDescriptor => ({
    name: 'main',
    uuid: '6830f39d-23bd-4653-aecd-81f08af4ec2e',
    title: 'Main',
    description: '',
    sortIndex: 0,
    minecraftVersion: '1.21.1',
    loader: 'VANILLA',
    loaderVersion: null,
    servers,
  })
  const service = new ServerBindingService(new ServerBindingsStore(db), {
    getProfile: async () => descriptor(),
    replaceProfileServers: async (_installation, _profile, next) => {
      servers = next
      return { profile: descriptor(), backupPath: '/tmp/backup.json' }
    },
  })
  const before = await service.list(installation, 'main')
  expect(before.items[0]?.managed).toBeFalse()
  const result = await service.apply(installation, {
    installationId: installation.id,
    profileName: 'main',
    name: 'Legacy',
    serverAddress: 'play.example.com',
    serverPort: 25570,
    isDefault: true,
    authId: 'std',
    packVersionId: null,
    xms: '1G',
    xmx: '4G',
    jvmArgs: [],
    gameArgs: ['nogui'],
  }, context)
  expect(result.binding.managed).toBeTrue()
  expect(servers).toEqual([{
    name: 'Legacy',
    serverAddress: 'play.example.com',
    serverPort: 25570,
    isDefault: true,
    protocol: -1,
    socketPing: true,
  }])
})
