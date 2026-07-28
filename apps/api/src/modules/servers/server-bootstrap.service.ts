import type {
  GravitInstallation,
  MinecraftLoader,
  ProfileServerBinding,
  ServerBootstrapIssueResult,
} from '@gravit-panel/shared'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ClientBuildService } from '../clients/client-build.service'
import { resolveClientCompatibility } from '../clients/compatibility.service'
import type { ControlFileService } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import type { ServerBindingsStore } from './server-bindings.store'
import type { ServerBootstrapStore } from './server-bootstrap.store'
import type { ServerPackStore } from './server-pack.store'

const wrapperArtifacts = {
  serverWrapper: {
    url: 'https://github.com/GravitLauncher/Launcher/releases/download/v5.7.9/ServerWrapper.jar',
    sha256: '7dc5bc4fe1ef84c37468a48f320a2065dc1aad9ae941a4d29770c09aef500ef6',
  },
  inline: {
    url: 'https://github.com/GravitLauncher/Launcher/releases/download/v5.7.9/ServerWrapperInline.jar',
    sha256: '3b3522e4d46f3804bed6d4078e41ea90557da14db8562b97a10c4fd0be301d7b',
  },
} as const

const temurinJre21 = {
  version: '21.0.12+8',
  x64: {
    url:
      'https://github.com/adoptium/temurin21-binaries/releases/download/' +
      'jdk-21.0.12%2B8/OpenJDK21U-jre_x64_linux_hotspot_21.0.12_8.tar.gz',
    sha256: '8a379a67c91a3ae61ffb33d46e0a40c7ba35e70713c4db31cfca30492f792eff',
  },
  aarch64: {
    url:
      'https://github.com/adoptium/temurin21-binaries/releases/download/' +
      'jdk-21.0.12%2B8/OpenJDK21U-jre_aarch64_linux_hotspot_21.0.12_8.tar.gz',
    sha256: '5f9c96b656827b9d14ebeda7739e25be554fa6d25669b03847c1df6e869c0679',
  },
} as const

const fabricInstaller = {
  version: '1.1.1',
  url:
    'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.1/' +
    'fabric-installer-1.1.1.jar',
  sha256: '2487a69dd6f9d9c2605265a7142d77c26ab62edc620e6bcf810d581d2ee31b79',
} as const

interface BootstrapConfig {
  eulaAcceptedAt: string
  profileUuid: string
  minecraftVersion: string
  loader: Exclude<MinecraftLoader, 'QUILT'>
  loaderVersion: string | null
  authlibArtifact: string
  coreFile: string
  coreInstall: 'vanilla' | 'fabric' | 'forge' | 'neoforge'
  hasServerPack: boolean
  launchServerAddress: string
  binding: ProfileServerBinding
}

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const sha1 = (bytes: Uint8Array) =>
  createHash('sha1').update(bytes).digest('hex')
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`

const fetchBytes = async (url: string, maximumBytes = 512 * 1024 * 1024) => {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(5 * 60_000),
    headers: { 'User-Agent': 'GravitPanel/0.1 server-bootstrap' },
  })
  if (!response.ok) throw new Error(`Artifact request failed with HTTP ${response.status}: ${url}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maximumBytes) throw new Error(`Artifact exceeds size limit: ${url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.length || bytes.length > maximumBytes) {
    throw new Error(`Artifact has an invalid size: ${url}`)
  }
  return bytes
}

const fetchSha256Verified = async (url: string, expected: string) => {
  const bytes = await fetchBytes(url)
  const actual = sha256(bytes)
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Artifact checksum mismatch for ${url}`)
  }
  return bytes
}

export class ServerBootstrapService {
  constructor(
    private readonly drafts: ServerBootstrapStore,
    private readonly bindings: ServerBindingsStore,
    private readonly packs: ServerPackStore,
    private readonly clients: Pick<ClientBuildService, 'getProfile'>,
    private readonly control: Pick<ControlFileService, 'createServerToken'>,
    private readonly publicUrl: string | undefined,
  ) {}

  list(bindingId: string) {
    return { items: this.drafts.list(bindingId) }
  }

  createDraft(installation: GravitInstallation, bindingId: string) {
    const binding = this.requireBinding(installation, bindingId)
    if (!binding.eulaAcceptedAt) {
      throw new Error('Minecraft EULA must be accepted before preparing the first installation')
    }
    return this.drafts.create({
      bindingId,
      installationId: installation.id,
      profileName: binding.profileName,
      serverName: binding.name,
      config: { eulaAcceptedAt: binding.eulaAcceptedAt },
    })
  }

  acceptEula(installation: GravitInstallation, bindingId: string) {
    this.requireBinding(installation, bindingId)
    return this.bindings.acceptEula(bindingId)
  }

  async prepare(
    installation: GravitInstallation,
    draftId: string,
    context: JobTaskContext,
  ) {
    const draft = this.drafts.internal(draftId)
    if (!draft || draft.installation_id !== installation.id || draft.status !== 'preparing') {
      throw new Error('Bootstrap draft is not available for preparation')
    }
    try {
      const binding = this.requireBinding(installation, draft.binding_id)
      const profile = await this.clients.getProfile(installation, binding.profileName)
      if (!profile.uuid || !profile.minecraftVersion || !profile.loader) {
        throw new Error('Profile compatibility metadata is incomplete')
      }
      if (profile.loader === 'QUILT') throw new Error('Quilt bootstrap is not supported')
      if (profile.loader !== 'VANILLA' && !profile.loaderVersion) {
        throw new Error('Exact loader version cannot be derived from the profile')
      }
      if (!binding.authId || !binding.xms || !binding.xmx) {
        throw new Error('Server binding bootstrap settings are incomplete')
      }
      const pack = binding.packVersionId ? this.packs.get(binding.packVersionId) : null
      if (
        binding.packVersionId &&
        (
          !pack ||
          pack.installationId !== installation.id ||
          pack.profileName !== binding.profileName ||
          (pack.bindingId !== null && pack.bindingId !== binding.id)
        )
      ) {
        throw new Error('Selected server pack version does not exist')
      }
      if (
        pack &&
        (
          pack.profileName !== profile.name ||
          pack.minecraftVersion !== profile.minecraftVersion ||
          pack.loader !== profile.loader ||
          pack.loaderVersion !== profile.loaderVersion
        )
      ) throw new Error('Selected server pack version does not match the current profile')

      const compatibility = resolveClientCompatibility(profile.minecraftVersion)
      const launchServerAddress = this.launchServerAddress(installation.address)
      const draftConfig = JSON.parse(draft.config_json) as { eulaAcceptedAt?: unknown }
      const config: BootstrapConfig = {
        eulaAcceptedAt:
          typeof draftConfig.eulaAcceptedAt === 'string'
            ? draftConfig.eulaAcceptedAt
            : new Date().toISOString(),
        profileUuid: profile.uuid,
        minecraftVersion: profile.minecraftVersion,
        loader: profile.loader,
        loaderVersion: profile.loaderVersion,
        authlibArtifact: compatibility.authlibArtifact,
        coreFile: profile.loader === 'VANILLA' ? 'server.jar' : 'core-installer.jar',
        coreInstall: profile.loader.toLowerCase() as BootstrapConfig['coreInstall'],
        hasServerPack: Boolean(pack),
        launchServerAddress,
        binding,
      }

      context.progress(10, 'Resolving verified ServerWrapper and core artifacts')
      const root = join(installation.path, 'server-bootstrap', draftId)
      const cacheRoot = join(installation.path, 'server-bootstrap', 'cache')
      const staging = await mkdtemp(join(tmpdir(), 'gravit-server-bootstrap-'))
      await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(cacheRoot, { recursive: true }),
      ])
      try {
        const [wrapper, inline, core] = await Promise.all([
          fetchSha256Verified(
            wrapperArtifacts.serverWrapper.url,
            wrapperArtifacts.serverWrapper.sha256,
          ),
          fetchSha256Verified(wrapperArtifacts.inline.url, wrapperArtifacts.inline.sha256),
          this.resolveCore(config),
        ])
        await Promise.all([
          writeFile(join(staging, 'ServerWrapper.jar'), wrapper),
          writeFile(join(staging, 'ServerWrapperInline.jar'), inline),
          writeFile(join(staging, config.coreFile), core.bytes),
        ])
        const authlibPath = join(
          installation.path,
          'launcher',
          'config',
          'MirrorHelper',
          'workspace',
          'authlib',
          compatibility.authlibArtifact,
        )
        if (!(await stat(authlibPath)).isFile()) {
          throw new Error(`${compatibility.authlibArtifact} is absent from MirrorHelper workspace`)
        }
        await copyFile(authlibPath, join(staging, 'LauncherAuthlib.jar'))
        if (pack) {
          const archivePath = this.packs.archivePath(pack.id)
          const manifest = this.packs.manifest(pack.id)
          if (!archivePath) throw new Error('Published server pack archive is missing')
          if (!manifest?.files) throw new Error('Published server pack manifest is missing')
          await copyFile(archivePath, join(staging, 'server-pack.tar.gz'))
          await writeFile(
            join(staging, 'server-pack-files'),
            `${manifest.files.map((item) => item.path).join('\n')}\n`,
          )
        }
        await writeFile(
          join(staging, 'bootstrap-manifest.json'),
          `${JSON.stringify({
            launcherVersion: '5.7.9',
            javaRuntime: `Temurin ${temurinJre21.version}`,
            minecraftVersion: config.minecraftVersion,
            loader: config.loader,
            loaderVersion: config.loaderVersion,
            fabricInstaller:
              config.loader === 'FABRIC' ? fabricInstaller.version : null,
            coreSha256: sha256(core.bytes),
            authlibArtifact: config.authlibArtifact,
            serverPackId: pack?.id ?? null,
          }, null, 2)}\n`,
        )
        context.progress(45, 'Packing bootstrap payload')
        const bundlePath = join(root, 'bundle.tar.gz')
        await this.createTar(staging, bundlePath)
        const bundleSha256 = sha256(new Uint8Array(await readFile(bundlePath)))

        context.progress(60, 'Downloading pinned portable Java 21 runtimes')
        const [jreX64, jreAarch64] = await Promise.all([
          this.resolveJre('x64', cacheRoot),
          this.resolveJre('aarch64', cacheRoot),
        ])
        const ready = this.drafts.ready(draftId, {
          bundlePath,
          bundleSha256,
          jreX64Path: jreX64.path,
          jreX64Sha256: jreX64.sha256,
          jreAarch64Path: jreAarch64.path,
          jreAarch64Sha256: jreAarch64.sha256,
          config: config as unknown as Record<string, unknown>,
        })
        this.bindings.setState(draft.binding_id, 'ready')
        context.progress(95, 'Bootstrap bundles are ready for one-time issuance')
        return { draft: ready }
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    } catch (error) {
      this.drafts.fail(draftId, error instanceof Error ? error.message : String(error))
      this.bindings.setState(draft.binding_id, 'failed')
      throw error
    }
  }

  async issue(
    installation: GravitInstallation,
    draftId: string,
  ): Promise<ServerBootstrapIssueResult> {
    const publicUrl = this.requirePublicUrl()
    const row = this.drafts.internal(draftId)
    if (!row || row.installation_id !== installation.id) {
      throw new Error('Bootstrap draft not found')
    }
    const config = JSON.parse(row.config_json) as BootstrapConfig
    await this.assertDraftCurrent(installation, row, config)
    const issued = this.drafts.issue(draftId)
    return {
      draft: issued.draft,
      command: `${publicUrl.startsWith('https:')
        ? "curl --proto '=https' --tlsv1.2 -fsSL"
        : 'curl -fsSL'} ${shellQuote(`${publicUrl}/api/server-bootstrap/${issued.claim}`)} | sudo bash`,
      expiresAt: issued.expiresAt,
    }
  }

  loader(claim: string) {
    const publicUrl = this.requirePublicUrl()
    const startUrl = `${publicUrl}/api/server-bootstrap/${claim}/start`
    const curl = publicUrl.startsWith('https:')
      ? "curl --proto '=https' --tlsv1.2"
      : 'curl'
    return `#!/usr/bin/env bash
set -Eeuo pipefail
TMP="$(mktemp /tmp/gravit-bootstrap-stage2.XXXXXXXX)"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT
${curl} -fsSL -X POST ${shellQuote(startUrl)} -o "$TMP"
bash "$TMP"
`
  }

  async start(installation: GravitInstallation, claim: string) {
    const row = this.drafts.beginClaim(claim)
    if (!row || row.installation_id !== installation.id) return null
    try {
      const config = JSON.parse(row.config_json) as BootstrapConfig
      await this.assertDraftCurrent(installation, row, config)
      const token = await this.control.createServerToken(
        installation,
        config.profileUuid,
        config.binding.authId!,
      )
      return this.renderScript(row.id, config, token, claim)
    } catch (error) {
      throw error
    }
  }

  claimInstallationId(claim: string) {
    return this.drafts.claimInstallationId(claim)
  }

  artifact(claim: string, kind: 'bundle' | 'jre-x64' | 'jre-aarch64') {
    const row = this.drafts.artifactByClaim(claim)
    if (!row) return null
    const path =
      kind === 'bundle'
        ? row.bundle_path
        : kind === 'jre-x64'
          ? row.jre_x64_path
          : row.jre_aarch64_path
    const digest =
      kind === 'bundle'
        ? row.bundle_sha256
        : kind === 'jre-x64'
          ? row.jre_x64_sha256
          : row.jre_aarch64_sha256
    return path && digest ? { path, digest } : null
  }

  report(
    claim: string,
    status: 'installed' | 'failed',
    error?: string,
    updaterToken?: string,
  ) {
    const row = this.drafts.internalByClaim(claim)
    const config = row ? JSON.parse(row.config_json) as BootstrapConfig : null
    const draft = this.drafts.reportClaim(claim, status, error)
    if (draft) {
      this.bindings.setState(draft.bindingId, status)
      if (status === 'installed' && updaterToken) {
        this.bindings.saveUpdaterToken(
          draft.bindingId,
          createHash('sha256').update(updaterToken).digest('hex'),
        )
      }
      if (status === 'installed' && config?.binding.packVersionId) {
        this.bindings.reportPack(
          draft.bindingId,
          config.binding.packVersionId,
        )
      }
    }
    return draft
  }

  revoke(installation: GravitInstallation, draftId: string) {
    const row = this.drafts.internal(draftId)
    if (!row || row.installation_id !== installation.id) {
      throw new Error('Bootstrap draft not found')
    }
    return this.drafts.revoke(draftId)
  }

  updaterBinding(token: string) {
    if (!token) return null
    const binding = this.bindings.getByUpdaterTokenHash(
      createHash('sha256').update(token).digest('hex'),
    )
    return binding?.id ? this.bindings.touchUpdater(binding.id) : null
  }

  updaterScript(token: string) {
    const binding = this.updaterBinding(token)
    if (!binding?.id || !binding.packVersionId) return null
    if (binding.appliedPackVersionId === binding.packVersionId) return null
    const version = this.packs.get(binding.packVersionId)
    const manifest = this.packs.manifest(binding.packVersionId)
    if (!version || version.bindingId !== binding.id || !manifest?.files) {
      throw new Error('Desired server pack is unavailable')
    }
    const files = manifest.files.map((item) => item.path)
    const encodedFiles = Buffer.from(`${files.join('\n')}\n`).toString('base64')
    const publicUrl = this.requirePublicUrl()
    const curl = publicUrl.startsWith('https:')
      ? "curl --proto '=https' --tlsv1.2"
      : 'curl'
    const serviceName = `gravit-${binding.id.slice(0, 8)}`
    const archiveUrl = `${publicUrl}/api/server-agent/archive/${version.id}`
    const reportUrl = `${publicUrl}/api/server-agent/report`
    return `#!/usr/bin/env bash
set -Eeuo pipefail
WORKDIR="$(readlink -f /var/lib/gravit-panel/servers/${binding.id})"
STATE="$WORKDIR/.gravit-panel"
NEW_LIST="$STATE/server-pack-files.new"
OLD_LIST="$STATE/server-pack-files"
ROLLBACK_LIST="$STATE/server-pack-files.rollback"
ARCHIVE="$STATE/download/server-pack-${version.id}.tar.gz"
BACKUP="$STATE/backups/pack-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
mkdir -p "$STATE/download" "$STATE/backups"
printf '%s' ${shellQuote(encodedFiles)} | base64 -d > "$NEW_LIST"
cp "$NEW_LIST" "$ROLLBACK_LIST"
${curl} -fL --retry 3 \
  -H "authorization: Bearer $UPDATER_TOKEN" -o "$ARCHIVE" ${shellQuote(archiveUrl)}
echo ${shellQuote(version.sha256)}"  $ARCHIVE" | sha256sum -c -
touch "$OLD_LIST"
EXISTING="$(mktemp)"
while IFS= read -r path; do
  [[ -z "$path" || ! -f "$WORKDIR/$path" ]] || printf '%s\\n' "$path" >> "$EXISTING"
done < "$OLD_LIST"
if [[ -s "$EXISTING" ]]; then
  tar -czf "$BACKUP" -C "$WORKDIR" --files-from="$EXISTING"
else
  tar -czf "$BACKUP" --files-from=/dev/null
fi
rm -f "$EXISTING"
systemctl stop ${serviceName}.service
apply_failed=false
while IFS= read -r path; do
  [[ -z "$path" ]] || rm -f "$WORKDIR/$path"
done < "$OLD_LIST"
tar -xzf "$ARCHIVE" --no-same-owner -C "$WORKDIR" || apply_failed=true
if [[ "$apply_failed" == false ]]; then
  mv "$NEW_LIST" "$OLD_LIST"
  chown -R "$(stat -c %u "$WORKDIR")":"$(stat -c %g "$WORKDIR")" "$WORKDIR"
  systemctl start ${serviceName}.service || apply_failed=true
fi
if [[ "$apply_failed" == true ]]; then
  while IFS= read -r path; do
    [[ -z "$path" ]] || rm -f "$WORKDIR/$path"
  done < "$ROLLBACK_LIST"
  tar -xzf "$BACKUP" -C "$WORKDIR" || true
  rm -f "$NEW_LIST"
  systemctl start ${serviceName}.service >/dev/null 2>&1 || true
  curl -fsS -X POST -H "authorization: Bearer $UPDATER_TOKEN" \
    -H 'content-type: application/json' \
    --data ${shellQuote(JSON.stringify({
      packVersionId: version.id,
      status: 'failed',
      error: 'Server pack apply failed',
    }))} ${shellQuote(reportUrl)} >/dev/null 2>&1 || true
  exit 1
fi
rm -f "$ROLLBACK_LIST"
curl -fsS -X POST -H "authorization: Bearer $UPDATER_TOKEN" \
  -H 'content-type: application/json' \
  --data ${shellQuote(JSON.stringify({
    packVersionId: version.id,
    status: 'installed',
  }))} ${shellQuote(reportUrl)} >/dev/null
`
  }

  updaterArchive(token: string, versionId: string) {
    const binding = this.updaterBinding(token)
    const version = this.packs.get(versionId)
    if (
      !binding?.id ||
      !version ||
      binding.packVersionId !== version.id ||
      version.bindingId !== binding.id
    ) return null
    const path = this.packs.archivePath(versionId)
    return path ? { path, digest: version.sha256 } : null
  }

  reportUpdater(
    token: string,
    packVersionId: string,
    status: 'installed' | 'failed',
    error?: string,
  ) {
    const binding = this.updaterBinding(token)
    if (!binding?.id || binding.packVersionId !== packVersionId) return null
    return this.bindings.reportPack(
      binding.id,
      status === 'installed' ? packVersionId : null,
      status === 'failed' ? error ?? 'Server pack apply failed' : undefined,
    )
  }

  private requireBinding(installation: GravitInstallation, bindingId: string) {
    const binding = this.bindings.get(bindingId)
    if (!binding || binding.installationId !== installation.id || !binding.id) {
      throw new Error('Managed server binding not found')
    }
    return binding
  }

  private async assertDraftCurrent(
    installation: GravitInstallation,
    row: {
      binding_id: string
      profile_name: string
    },
    config: BootstrapConfig,
  ) {
    const profile = await this.clients.getProfile(installation, row.profile_name)
    const binding = this.requireBinding(installation, row.binding_id)
    const changed =
      profile.uuid !== config.profileUuid ||
      profile.minecraftVersion !== config.minecraftVersion ||
      profile.loader !== config.loader ||
      profile.loaderVersion !== config.loaderVersion ||
      binding.name !== config.binding.name ||
      binding.serverAddress !== config.binding.serverAddress ||
      binding.serverPort !== config.binding.serverPort ||
      binding.authId !== config.binding.authId ||
      binding.packVersionId !== config.binding.packVersionId ||
      binding.xms !== config.binding.xms ||
      binding.xmx !== config.binding.xmx ||
      JSON.stringify(binding.jvmArgs) !== JSON.stringify(config.binding.jvmArgs) ||
      JSON.stringify(binding.gameArgs) !== JSON.stringify(config.binding.gameArgs)
    if (!changed) return
    this.drafts.invalidateBinding(
      row.binding_id,
      'Profile or server binding changed; prepare a new bootstrap bundle',
    )
    throw new Error('Profile or server binding changed; prepare a new bootstrap bundle')
  }

  private requirePublicUrl() {
    if (!this.publicUrl) throw new Error('PANEL_PUBLIC_URL is required for server bootstrap')
    const url = new URL(this.publicUrl)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('PANEL_PUBLIC_URL must use HTTPS')
    }
    return this.publicUrl.replace(/\/+$/, '')
  }

  private launchServerAddress(address: string) {
    if (/^wss?:\/\//i.test(address)) {
      return `${address.replace(/\/+$/, '')}/api`
    }
    const local = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(address)
    return `${local ? 'ws' : 'wss'}://${address}/api`
  }

  private async resolveCore(config: BootstrapConfig) {
    if (config.loader === 'VANILLA') return this.resolveVanilla(config.minecraftVersion)
    if (config.loader === 'FABRIC') return this.resolveFabricInstaller()
    const loaderVersion = config.loaderVersion!
    const artifactVersion =
      config.loader === 'FORGE'
        ? `${config.minecraftVersion}-${loaderVersion}`
        : loaderVersion
    const base =
      config.loader === 'FORGE'
        ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${artifactVersion}/forge-${artifactVersion}-installer.jar`
        : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${artifactVersion}/neoforge-${artifactVersion}-installer.jar`
    const checksumText = new TextDecoder().decode(await fetchBytes(`${base}.sha256`, 4096))
    const expected = checksumText.trim().split(/\s+/, 1)[0]?.toLowerCase()
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`${config.loader} installer returned an invalid checksum`)
    }
    return { bytes: await fetchSha256Verified(base, expected) }
  }

  private async resolveVanilla(version: string) {
    const manifest = JSON.parse(
      new TextDecoder().decode(
        await fetchBytes('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 4 * 1024 * 1024),
      ),
    ) as { versions?: Array<{ id: string; url: string }> }
    const metadataUrl = manifest.versions?.find((item) => item.id === version)?.url
    if (!metadataUrl) throw new Error(`Mojang metadata does not contain Minecraft ${version}`)
    const metadata = JSON.parse(
      new TextDecoder().decode(await fetchBytes(metadataUrl, 4 * 1024 * 1024)),
    ) as { downloads?: { server?: { url?: string; sha1?: string } } }
    const server = metadata.downloads?.server
    if (!server?.url || !server.sha1) throw new Error(`Minecraft ${version} server is unavailable`)
    const bytes = await fetchBytes(server.url)
    if (sha1(bytes) !== server.sha1.toLowerCase()) {
      throw new Error('Mojang server checksum mismatch')
    }
    return { bytes }
  }

  private async resolveFabricInstaller() {
    return {
      bytes: await fetchSha256Verified(fabricInstaller.url, fabricInstaller.sha256),
    }
  }

  private async resolveJre(architecture: 'x64' | 'aarch64', root: string) {
    const pkg = temurinJre21[architecture]
    const path = join(root, `jre-${architecture}.tar.gz`)
    const existing = await readFile(path).catch(() => null)
    if (!existing || sha256(new Uint8Array(existing)) !== pkg.sha256) {
      await writeFile(path, await fetchSha256Verified(pkg.url, pkg.sha256))
    }
    return { path, sha256: pkg.sha256 }
  }

  private async createTar(source: string, target: string) {
    const process = Bun.spawn([
      'tar',
      '--sort=name',
      '--mtime=UTC 1970-01-01',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      target,
      '-C',
      source,
      '.',
    ], { stdout: 'pipe', stderr: 'pipe' })
    if (await process.exited !== 0) {
      throw new Error(`Failed to build bootstrap bundle: ${await new Response(process.stderr).text()}`)
    }
  }

  private renderScript(
    draftId: string,
    config: BootstrapConfig,
    serverToken: string,
    claim: string,
  ) {
    const publicUrl = this.requirePublicUrl()
    const curl = publicUrl.startsWith('https:')
      ? "curl --proto '=https' --tlsv1.2"
      : 'curl'
    const internal = this.drafts.internal(draftId)!
    const artifactBase = `${publicUrl}/api/server-bootstrap/${claim}/artifacts`
    const reportUrl = `${publicUrl}/api/server-bootstrap/${claim}/report`
    const args = config.binding.gameArgs.map(shellQuote).join(' ')
    const jvmOptions = [
      `-Xms${config.binding.xms}`,
      `-Xmx${config.binding.xmx}`,
      ...config.binding.jvmArgs,
      '-Dlauncher.authlib.inlineClass=pro.gravit.launcher.server.ServerWrapperInlineInitializer',
      '-Dlauncher.useSlf4j=true',
    ].join(' ')
    const serviceName = `gravit-${config.binding.id!.slice(0, 8)}`
    const updaterServiceName = `${serviceName}-pack-update`
    const updaterUrl = `${publicUrl}/api/server-agent/update`
    const packCommand = config.hasServerPack
      ? `tar -xzf "$PAYLOAD/server-pack.tar.gz" --no-same-owner -C "$WORKDIR"
install -m 0600 "$PAYLOAD/server-pack-files" "$WORKDIR/.gravit-panel/server-pack-files"`
      : ':'
    const coreCommand =
      config.coreInstall === 'vanilla'
        ? 'install -m 0644 "$PAYLOAD/server.jar" "$WORKDIR/server.jar"'
        : config.coreInstall === 'fabric'
          ? `"$JAVA" -jar "$PAYLOAD/core-installer.jar" server -dir "$WORKDIR" -mcversion ${shellQuote(config.minecraftVersion)} -loader ${shellQuote(config.loaderVersion!)} -downloadMinecraft`
          : `"$JAVA" -jar "$PAYLOAD/core-installer.jar" --installServer "$WORKDIR"`
    const launchCommand =
      config.coreInstall === 'vanilla'
        ? `exec "$JAVA" -jar server.jar ${args || 'nogui'}`
        : config.coreInstall === 'fabric'
          ? `exec "$JAVA" -jar fabric-server-launch.jar ${args || 'nogui'}`
          : `export PATH="$WORKDIR/.gravit-panel/jre/bin:$PATH"\nexec ./run.sh ${args || 'nogui'}`
    return `#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPORT_URL=${shellQuote(reportUrl)}
PAYLOAD=
BACKUP=
UNIT_TMP_DIR=
WORKDIR=
UPDATE=false
report_failure() {
  local code="$?"
  set +e
  [[ -z "$PAYLOAD" ]] || rm -rf "$PAYLOAD"
  [[ -z "$UNIT_TMP_DIR" ]] || rm -rf "$UNIT_TMP_DIR"
  if [[ -n "$WORKDIR" && -n "$BACKUP" && -f "$BACKUP" ]]; then
    tar -xzf "$BACKUP" -C "$WORKDIR" || true
    systemctl start ${serviceName}.service >/dev/null 2>&1 || true
  fi
  curl -fsS -X POST -H 'content-type: application/json' \\
    --data "{\\"status\\":\\"failed\\",\\"error\\":\\"installer exited with code $code\\"}" \\
    "$REPORT_URL" >/dev/null 2>&1 || true
}
trap report_failure EXIT

if [[ "$EUID" -ne 0 || -z "\${SUDO_USER:-}" || "$SUDO_USER" == root ]]; then
  echo "Run this command from a non-root account through sudo." >&2
  exit 1
fi
for command in curl tar sha256sum systemctl systemd-analyze install ln sed base64 head tr; do
  command -v "$command" >/dev/null || { echo "Missing dependency: $command" >&2; exit 1; }
done

WORKDIR="$(pwd -P)"
SERVICE_USER="$SUDO_USER"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
SERVICE_UID="$(id -u "$SERVICE_USER")"
SERVICE_GID="$(id -g "$SERVICE_USER")"
SERVICE_ROOT=/var/lib/gravit-panel/servers/${config.binding.id!}
if [[ "$SERVICE_UID" -eq 0 || ! -d "$WORKDIR" ]]; then
  echo "Unable to resolve the non-root service account or working directory." >&2
  exit 1
fi
MARKER="$WORKDIR/.gravit-panel-server"
if [[ -f "$MARKER" ]]; then
  grep -qx ${shellQuote(config.binding.id!)} "$MARKER" || {
    echo "This directory belongs to another bootstrap deployment." >&2
    exit 1
  }
  UPDATE=true
elif [[ -n "$(find "$WORKDIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Initial installation requires an empty current directory." >&2
  exit 1
fi
printf '%s\\n' ${shellQuote(config.binding.id!)} > "$MARKER"

mkdir -p "$WORKDIR/.gravit-panel/download" "$WORKDIR/.gravit-panel/jre"
if [[ "$UPDATE" == true ]]; then
  systemctl stop ${serviceName}.service >/dev/null 2>&1 || true
  mkdir -p "$WORKDIR/.gravit-panel/backups"
  BACKUP="$WORKDIR/.gravit-panel/backups/$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  (
    cd "$WORKDIR"
    find . -type f \\( -name '*.jar' -o -name 'run.sh' -o -name 'user_jvm_args.txt' \\
      -o -name 'gravit-server.env' -o -name 'start-gravit-server.sh' -o -name 'eula.txt' \\) \\
      -not -path './.gravit-panel/download/*' -print0 |
      tar --null -czf "$BACKUP" --files-from=-
  )
fi
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) JRE_KIND=jre-x64; JRE_SHA=${shellQuote(internal.jre_x64_sha256!)} ;;
  aarch64|arm64) JRE_KIND=jre-aarch64; JRE_SHA=${shellQuote(internal.jre_aarch64_sha256!)} ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
BUNDLE="$WORKDIR/.gravit-panel/download/bundle.tar.gz"
JRE_ARCHIVE="$WORKDIR/.gravit-panel/download/jre.tar.gz"
${curl} -fL --retry 3 -o "$BUNDLE" ${shellQuote(`${artifactBase}/bundle`)}
echo ${shellQuote(internal.bundle_sha256!)}"  $BUNDLE" | sha256sum -c -
${curl} -fL --retry 3 -o "$JRE_ARCHIVE" "${
      artifactBase
    }/$JRE_KIND"
echo "$JRE_SHA  $JRE_ARCHIVE" | sha256sum -c -

rm -rf "$WORKDIR/.gravit-panel/jre"
mkdir -p "$WORKDIR/.gravit-panel/jre"
PAYLOAD="$(mktemp -d /tmp/gravit-bootstrap.XXXXXXXX)"
tar -xzf "$BUNDLE" --no-same-owner -C "$PAYLOAD"
tar -xzf "$JRE_ARCHIVE" --no-same-owner --strip-components=1 -C "$WORKDIR/.gravit-panel/jre"
JAVA="$WORKDIR/.gravit-panel/jre/bin/java"

${coreCommand}
${packCommand}
"$JAVA" -jar "$PAYLOAD/ServerWrapper.jar" installAuthlib "$PAYLOAD/LauncherAuthlib.jar"
"$JAVA" -jar "$PAYLOAD/ServerWrapper.jar" installAuthlib "$PAYLOAD/ServerWrapperInline.jar"
install -m 0644 "$PAYLOAD/ServerWrapper.jar" "$WORKDIR/ServerWrapper.jar"
install -m 0644 "$PAYLOAD/ServerWrapperInline.jar" "$WORKDIR/ServerWrapperInline.jar"
printf 'eula=true\\n' > "$WORKDIR/eula.txt"

cat > "$WORKDIR/gravit-server.env" <<'GRAVIT_ENV'
SERVERWRAPPER_ADDRESS=${shellQuote(config.launchServerAddress)}
SERVERWRAPPER_SERVER_NAME=${shellQuote(config.binding.name)}
SERVERWRAPPER_AUTH_ID=${shellQuote(config.binding.authId!)}
SERVERWRAPPER_CHECK_SERVER_TOKEN=${shellQuote(serverToken)}
_JAVA_OPTIONS=${shellQuote(jvmOptions)}
GRAVIT_ENV
chmod 0600 "$WORKDIR/gravit-server.env"

cat > "$WORKDIR/start-gravit-server.sh" <<'GRAVIT_START'
#!/usr/bin/env bash
set -Eeuo pipefail
WORKDIR="$(cd "$(dirname "$0")" && pwd -P)"
set -a
source "$WORKDIR/gravit-server.env"
set +a
JAVA="$WORKDIR/.gravit-panel/jre/bin/java"
cd "$WORKDIR"
${launchCommand}
GRAVIT_START
chmod 0750 "$WORKDIR/start-gravit-server.sh"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$WORKDIR"
install -d -m 0755 /var/lib/gravit-panel/servers
if [[ -e "$SERVICE_ROOT" && ! -L "$SERVICE_ROOT" ]]; then
  echo "Reserved service path is not a symbolic link: $SERVICE_ROOT" >&2
  exit 1
fi
ln -sfn "$WORKDIR" "$SERVICE_ROOT"

UNIT_TMP_DIR="$(mktemp -d /run/gravit-systemd.XXXXXXXX)"
UNIT_TMP="$UNIT_TMP_DIR/${serviceName}.service"
cat > "$UNIT_TMP" <<SYSTEMD_UNIT
[Unit]
Description=Gravit Minecraft server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_UID
Group=$SERVICE_GID
WorkingDirectory=$SERVICE_ROOT
ExecStart=$SERVICE_ROOT/start-gravit-server.sh
Restart=on-failure
RestartSec=10
TimeoutStopSec=120
KillSignal=SIGINT

[Install]
WantedBy=multi-user.target
SYSTEMD_UNIT
UPDATER_ROOT=/usr/local/lib/gravit-panel/${config.binding.id!}
UPDATER_ENV=/etc/gravit-panel/servers/${config.binding.id!}.env
UPDATER_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '\\n')"
install -d -m 0755 "$UPDATER_ROOT" /etc/gravit-panel/servers
cat > "$UPDATER_ENV" <<UPDATER_ENV_FILE
UPDATER_TOKEN=$UPDATER_TOKEN
UPDATER_URL=${updaterUrl}
UPDATER_ENV_FILE
chmod 0600 "$UPDATER_ENV"
cat > "$UPDATER_ROOT/update.sh" <<'UPDATER_SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
set -a
source /etc/gravit-panel/servers/${config.binding.id!}.env
set +a
TMP="$(mktemp /tmp/gravit-pack-update.XXXXXXXX)"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT
STATUS="$(${curl} -sS -o "$TMP" -w '%{http_code}' \
  -H "authorization: Bearer $UPDATER_TOKEN" "$UPDATER_URL")"
case "$STATUS" in
  204) exit 0 ;;
  200) bash "$TMP" ;;
  *) cat "$TMP" >&2; echo "Pack updater failed with HTTP $STATUS" >&2; exit 1 ;;
esac
UPDATER_SCRIPT
chmod 0755 "$UPDATER_ROOT/update.sh"
UPDATER_UNIT_TMP="$UNIT_TMP_DIR/${updaterServiceName}.service"
UPDATER_TIMER_TMP="$UNIT_TMP_DIR/${updaterServiceName}.timer"
cat > "$UPDATER_UNIT_TMP" <<UPDATER_SERVICE
[Unit]
Description=Update Gravit server pack
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$UPDATER_ROOT/update.sh
UPDATER_SERVICE
cat > "$UPDATER_TIMER_TMP" <<UPDATER_TIMER
[Unit]
Description=Poll Gravit Panel for server pack updates

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
RandomizedDelaySec=15
Persistent=true
Unit=${updaterServiceName}.service

[Install]
WantedBy=timers.target
UPDATER_TIMER
if ! systemd-analyze verify "$UNIT_TMP" "$UPDATER_UNIT_TMP" "$UPDATER_TIMER_TMP"; then
  echo "Generated systemd units are invalid:" >&2
  sed -n '1,200p' "$UNIT_TMP" "$UPDATER_UNIT_TMP" "$UPDATER_TIMER_TMP" >&2
  exit 1
fi
install -m 0644 "$UNIT_TMP" /etc/systemd/system/${serviceName}.service
install -m 0644 "$UPDATER_UNIT_TMP" /etc/systemd/system/${updaterServiceName}.service
install -m 0644 "$UPDATER_TIMER_TMP" /etc/systemd/system/${updaterServiceName}.timer
rm -rf "$UNIT_TMP_DIR"
UNIT_TMP_DIR=
systemctl daemon-reload
systemctl enable --now ${serviceName}.service
systemctl enable --now ${updaterServiceName}.timer
systemctl is-active --quiet ${serviceName}.service
rm -rf "$PAYLOAD"
PAYLOAD=
curl -f --retry 3 -sS -X POST -H 'content-type: application/json' \\
  --data "{\\"status\\":\\"installed\\",\\"updaterToken\\":\\"$UPDATER_TOKEN\\"}" \
  "$REPORT_URL" >/dev/null
trap - EXIT
echo "Server installed and started as ${serviceName}.service"
`
  }
}
