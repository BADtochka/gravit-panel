import { expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schema } from '../../db/schema'
import { ServerBindingsStore } from './server-bindings.store'
import { ServerBootstrapService } from './server-bootstrap.service'
import { ServerBootstrapStore } from './server-bootstrap.store'
import { ServerPackStore } from './server-pack.store'

const installation: GravitInstallation = {
  id: '16db6f04-c249-41cf-a341-8f064cc04575',
  name: 'default',
  path: '/tmp/gravit-panel-test',
  address: 'mine.example.com',
  projectName: 'default',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: 'test',
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
}

test('server bootstrap claim is one-time and renders a secret only after claim', async () => {
  const db = new Database(':memory:')
  db.exec(schema)
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
  const bindings = new ServerBindingsStore(db)
  const binding = bindings.save({
    installationId: installation.id,
    profileName: 'main',
    name: 'Main server',
    serverAddress: 'play.example.com',
    serverPort: 25565,
    isDefault: true,
    authId: 'std',
    packVersionId: null,
    xms: '1G',
    xmx: '4G',
    jvmArgs: [],
    gameArgs: ['nogui'],
  })
  const drafts = new ServerBootstrapStore(db)
  const service = new ServerBootstrapService(
    drafts,
    bindings,
    new ServerPackStore(db),
    {
      getProfile: async () => ({
        name: 'main',
        uuid: '6830f39d-23bd-4653-aecd-81f08af4ec2e',
        title: 'Main',
        description: '',
        sortIndex: 0,
        minecraftVersion: '1.21.1',
        loader: 'VANILLA',
        loaderVersion: null,
        servers: [],
      }),
    },
    {
      createServerToken: async () => 'header.payload.signature',
    },
    'https://panel.example.com/panel',
  )
  const draft = service.createDraft(installation, binding.id!)
  drafts.ready(draft.id, {
    bundlePath: '/tmp/bundle.tar.gz',
    bundleSha256: 'a'.repeat(64),
    jreX64Path: '/tmp/jre-x64.tar.gz',
    jreX64Sha256: 'b'.repeat(64),
    jreAarch64Path: '/tmp/jre-aarch64.tar.gz',
    jreAarch64Sha256: 'c'.repeat(64),
    config: {
      eulaAcceptedAt: '2026-07-28T00:00:00.000Z',
      profileUuid: '6830f39d-23bd-4653-aecd-81f08af4ec2e',
      minecraftVersion: '1.21.1',
      loader: 'VANILLA',
      loaderVersion: null,
      authlibArtifact: 'LauncherAuthlib6.jar',
      coreFile: 'server.jar',
      coreInstall: 'vanilla',
      hasServerPack: false,
      launchServerAddress: 'wss://mine.example.com/api',
      binding,
    },
  })

  const issued = await service.issue(installation, draft.id)
  expect(issued.command).toContain('https://panel.example.com/panel/api/server-bootstrap/')
  expect(JSON.stringify(drafts.internal(draft.id))).not.toContain('header.payload.signature')
  const claim = issued.command.match(/server-bootstrap\/([A-Za-z0-9_-]+)/)?.[1]
  expect(claim).toBeTruthy()
  expect(service.claimInstallationId(claim!)).toBe(installation.id)

  const script = await service.claim(installation, claim!)
  expect(script).toContain('SERVERWRAPPER_CHECK_SERVER_TOKEN')
  expect(script).toContain('header.payload.signature')
  expect(script).toContain('SERVICE_UID="$(id -u "$SERVICE_USER")"')
  expect(script).toContain('User=$SERVICE_UID')
  expect(script).toContain('Group=$SERVICE_GID')
  expect(script).toContain('WorkingDirectory=$SERVICE_ROOT')
  expect(script).not.toContain('WorkingDirectory="$WORKDIR"')
  expect(script).toContain('systemd-analyze verify "$UNIT_TMP"')
  expect(script).toContain('systemctl enable --now gravit-')
  const scriptDirectory = await mkdtemp(join(tmpdir(), 'gravit-bootstrap-script-'))
  try {
    const scriptPath = join(scriptDirectory, 'install.sh')
    await writeFile(scriptPath, script!)
    expect(await Bun.spawn(['bash', '-n', scriptPath]).exited).toBe(0)
  } finally {
    await rm(scriptDirectory, { recursive: true, force: true })
  }
  expect(await service.claim(installation, claim!)).toBeNull()
  expect(JSON.stringify(drafts.internal(draft.id))).not.toContain('header.payload.signature')
})
