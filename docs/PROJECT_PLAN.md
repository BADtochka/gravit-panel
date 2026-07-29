# Gravit Panel Project Plan

## Goal

Build a setup wizard and admin web panel for GravitLauncher that reduces manual navigation across LaunchServer configs, modules, Docker scripts, client build commands, and side projects.

The panel must treat source code and current GitHub releases as the source of truth. The public GravitLauncher documentation is useful as orientation, but implementation decisions must be verified against:

- `GravitLauncher/Launcher`
- `GravitLauncher/LauncherModules`
- `GravitLauncher/LauncherDockered`
- `GravitLauncher/LauncherPrestarter`
- related side projects such as `LauncherRuntime`, `TextureProvider`, and auth/provider modules

Every source-derived catalog or command recipe must record the upstream repository and exact commit or release tag used for verification. Runtime discovery should use a pinned release manifest or a cached upstream response; unsupported entries must not be presented as installable.

## Confirmed Integration Facts

- LaunchServer exposes console commands such as `build`, `modules`, `profile`, `config`, `serverStatus`, `securitycheck`, and `token`.
- `RemoteControl_module` can execute LaunchServer commands over HTTP and return JSON containing `success`, `exception`, and captured log lines.
- `LauncherDockered` already provides Docker Compose, basic install scripts, helper module installers, and `control-file` access through `socat`.
- `MirrorHelper_module` registers commands such as `installClient`, `installMods`, `applyworkspace`, `downloadinstaller`, `patchauthlib`, and `deduplibraries`.
- `MirrorHelper_module` already supports Modrinth by slug and CurseForge by numeric id during client/mod installation.
- Authlib requirements in README can lag behind source. The current source references newer authlib files such as `LauncherAuthlib4.jar`, `LauncherAuthlib5.jar`, `LauncherAuthlib6.jar`, `LauncherAuthlib7.jar`, and `LauncherAuthlib9.jar`.

## Stack

### Frontend

- Vue 3
- Vite
- TypeScript
- Tailwind CSS
- shadcn-vue
- Vue Router
- Pinia
- TanStack Query

The UI should be an operational admin panel, not a landing page: sidebar navigation, wizard steps, forms, tables, status badges, dialogs, and log viewers.

### Backend

- Bun
- Elysia
- TypeScript
- Bun workspaces
- Bun SQLite for local state
- Server-Sent Events for job logs

The backend should be split into modules. Routes stay thin; services and job runners own behavior.

### Repository Layout

```text
gravit-panel/
  apps/
    web/
    api/
  packages/
    shared/
  docs/
```

## Backend Module Layout

```text
apps/api/src/
  main.ts
  app.ts
  core/
    config.ts
    errors.ts
    logger.ts
  modules/
    docker/
      docker.routes.ts
      docker.service.ts
      docker.schemas.ts
    gravit/
      commands.ts
      config.service.ts
      gravit.routes.ts
      launchserver.service.ts
      remote-control.service.ts
    setup/
      setup.jobs.ts
      setup.routes.ts
      setup.schemas.ts
    modules/
      module-catalog.service.ts
      module-install.service.ts
      modules.routes.ts
    clients/
      client-build.service.ts
      clients.routes.ts
    mods/
      mod-manager.service.ts
      modrinth.service.ts
      mods.routes.ts
    jobs/
      jobs.events.ts
      jobs.routes.ts
      jobs.runner.ts
      jobs.store.ts
    snapshots/
      snapshots.routes.ts
      snapshots.service.ts
  db/
    client.ts
    schema.ts
```

## Security Rules

- No arbitrary shell execution from the web UI by default.
- All dangerous operations must be typed jobs with explicit allowlists.
- RemoteControl tokens must be generated with command allowlists, not broad `allowAll`, except in development mode.
- Bind panel locally by default.
- Require admin authentication before real machine operations.
- Keep audit logs for every command, file write, snapshot, and job.
- Snapshot configs before each write.
- Show destructive confirmations for actions like `applyworkspace`, volume deletion, and bulk mod removal.

## MVP Scope

1. Project scaffold.
2. Backend job runner skeleton.
3. Setup wizard shell.
4. Docker preflight checks.
5. `LauncherDockered` install/import.
6. Domain and URL config form.
7. LaunchServer command transport through `control-file`.
8. RemoteControl install/configure step.
9. Basic LaunchServer health panel.
10. Module catalog for built-in server and launcher modules.
11. Launcher build action through `build`.
12. Client build action through `installClient`.
13. Modrinth search and bulk mod install.
14. Side-project compatibility helpers for LauncherPrestarter and authlib patching when required.

## First Implementation Slices

### Slice 1: Workspace Scaffold

Status: completed.

- Create Bun workspace.
- Add `apps/api` with modular Elysia app.
- Add `apps/web` with Vue, Vite, Tailwind, and shadcn-vue base component setup.
- Add `packages/shared`.
- Add smoke endpoints and basic dashboard shell.

### Slice 2: Jobs

Status: completed.

- Add SQLite-backed jobs table.
- Add in-memory running job registry.
- Add SSE endpoint for job events.
- Add example no-op job.

Jobs persist a dedicated `cancelled` terminal state and expose an allowlisted
cancel endpoint for queued/running work. Cancellation requests abort the runner
signal and cannot later be overwritten by a successful task return. Operational
pages discover the active job for the selected installation, reconnect to its
persisted SSE history after navigation, and share the same cancel control as
the Jobs view.

### Slice 3: Docker Preflight

Status: completed.

- Check Docker CLI availability.
- Check Compose availability.
- Check port availability.
- Show actionable status in setup wizard.

The default host port is verified against
`GravitLauncher/LauncherDockered@723203b56f8d58f2447edd20ac8a5b84a31ef816`.
The API also accepts a user-selected port so the same preflight can validate a
non-default nginx binding before installation.

### Slice 4: LauncherDockered Import/Install

Status: completed.

- Clone or import `LauncherDockered`.
- Generate `.env`.
- Run `docker compose up -d`.
- Capture logs as job events.

Fresh installations are cloned to a staging directory and checked out at
`GravitLauncher/LauncherDockered@723203b56f8d58f2447edd20ac8a5b84a31ef816`
before being moved into place. Imports must have the official upstream Git
origin, and their exact current commit is stored in the job result. Existing
`.env` files are snapshotted before an atomic rewrite.
The web flow shows a final shadcn confirmation dialog with the resolved target,
mode, address, and Compose project. The install API requires a literal
`confirmInstallation = true` before it can enqueue machine changes.

### Slice 5: LaunchServer Command Transport

Status: completed.

- Wait for `control-file`.
- Execute allowlisted LaunchServer commands through `control-file`.
- Expose `serverStatus` and `securitycheck`.

The transport follows
`GravitLauncher/Launcher@fef9bae63da1afc0518d32e3333db20f409ab196`
`SocketCommandServer`: one newline-terminated command is written to the Unix
socket and command log events are read until the server closes the connection.
The panel executes the pinned LauncherDockered `socat` recipe inside the
`gravitlauncher` container because a bind-mounted Unix socket is not reachable
across the container network namespace; only `serverStatus` and `securitycheck`
have API endpoints. Successful install/import jobs wait for the in-container
socket before registering their canonical path and source revision in SQLite.

### Slice 6: RemoteControl

Status: completed.

- Install/load `RemoteControl`.
- Generate a token with allowlisted commands.
- Persist token securely.
- Switch command execution from `control-file` to HTTP where available.

The module behavior and HTTP response contract are pinned to
`GravitLauncher/LauncherModules@0fcdfade1960c353a9f0bbb2f92055f05e22867d`.
Setup writes `config/RemoteControl/Config.json` before module load with
`allowAll = false`, exact `serverStatus` and `securitycheck` permissions, and a
mode `0600` file. Root-owned volume writes run through fixed commands inside
the `gravitlauncher` container with relative paths constrained to `/app/data`.
Existing tokens are replaced only after explicit UI
confirmation. The panel credential is encrypted in SQLite with AES-256-GCM. Its
32-byte key can be generated from the UI and is persisted separately with mode
`0600`; an operator-provided `CREDENTIAL_ENCRYPTION_KEY` remains supported and
takes precedence. Neither jobs nor API responses contain the key or token. HTTP
is preferred after verification, with redacted automatic fallback to
`control-file`.

### Slice 7: Modules

Status: completed.

- Discover built-in modules from a source-verified catalog.
- Install server modules and launcher modules.
- Load modules through LaunchServer commands.
- Show loaded/pending state.

The installable catalog is pinned to the exact module JAR manifest bundled in
`GravitLauncher/Launcher@v5.7.9` (`81132768a711a0eab0e8b3b8b6c480b90f48795c`).
The verified `LaunchServerBuild.zip` SHA-256 is
`cfc60bfdf023c1e73031828406e9170b519f17a053c8056a0f0cbce887233f07`, and its
LauncherModules submodule revision is
`GravitLauncher/LauncherModules@ebe98aa204c3282430cef4dd5bbb75ac1c7d3e0a`.
Runtime state is discovered with `modules available` and `modules list`; only
catalog entries reported by the selected LaunchServer image can be installed.
Typed jobs use `modules load <name>` for server modules and
`modules launcher-load <name>` for launcher modules, then verify the loaded
state. The resulting `modules.json` update makes the selection persistent.

### Slice 8: Side Projects and Compatibility Helpers

Status: completed.

- Detect whether the selected client/runtime requires a patched authlib.
- Run the source-verified `patchauthlib` flow only when required.
- Install or build LauncherPrestarter from a pinned release/source revision.
- Record installed versions and compatibility decisions in the job audit log.

Compatibility selection follows
`GravitLauncher/LauncherModules@0fcdfade1960c353a9f0bbb2f92055f05e22867d`
`MirrorHelper_module/InstallClient`: client builds require a patched authlib and
select `LauncherAuthlib1.jar` through `LauncherAuthlib7.jar` or
`LauncherAuthlib9.jar` by Minecraft version. The panel verifies that exact
artifact exists in the pinned MirrorHelper workspace before allowing a build.
LauncherPrestarter is pinned to release `v2.1.0` at
`94bcc6949c1e4b7aec37bd1d00515203e2772bcb`; `Prestarter.exe` must match
SHA-256 `e206a35615b91ae21a13154b7cb4dda9c742a2a45211880e79100bb09636de7f`.
Existing binaries are snapshotted before replacement.
The pinned Prestarter module registers its Windows launcher binary during
`LaunchServerLauncherBinaryInit`; dynamically loading the module is therefore
not enough. LaunchServer setup restarts only the `gravitlauncher` Compose service,
removes the stale bind-mounted `control-file`, waits for a newly created socket,
and verifies the module after restart. The generated `.env` also opens
`java.base/java.time` only to the named Gson module required by the pinned
FileAuthSystem implementation; existing profiles receive the same setting with
an `.env` snapshot before their first managed restart. Launcher builds also
repair profiles created before this rule by restarting once when the verified
`Prestarter.exe` exists but the Windows artifact is missing.
Launcher builds install the GUI module and resources from
`GravitLauncher/LauncherRuntime@v5.0.7`
(`755e5509b1f573817a977b4180a2f84517619025`), the release declared compatible
with GravitLauncher `5.7.9`. The API image builds `JavaRuntime.jar` from that
exact revision with the tracked `deploy/launcher-runtime/oauth-controls.patch`,
records its SHA-256 beside the artifact, and verifies the bundled bytes again
before installation. Existing upstream or older patched JARs are snapshotted
and replaced; a loaded module is activated through a managed LaunchServer
restart. `runtime.zip` must match SHA-256
`905b3345fb642c39ae368b4ef82c2c1740bf54e28d0ea436322b15071a891c27`.
Archive paths are validated before extraction, and
`modules launcher-load JavaRuntime.jar` is verified before `build`.

### Slice 9: Launcher Build

Status: completed.

- Run `build`.
- Stream logs.
- Check generated artifacts.
- Expose download/copy metadata.

The allowlisted build command and artifact flow are pinned to
`GravitLauncher/Launcher@fef9bae63da1afc0518d32e3333db20f409ab196`.
Generated JAR/Windows artifacts are discovered from the configured local
updates provider, hashed with SHA-256, exposed through installation-scoped
download routes, and recorded in the job result together with the exact
LauncherRuntime release.

The Launcher page supports source-defined LauncherRuntime PNG customization for
`runtime/images/logo.png`, `runtime/images/background.png`, and
`runtime/favicon.png`. Uploaded files are size- and signature-validated,
existing files are snapshotted, the applied digests are recorded in a local
manifest, and artifacts are rebuilt in the same typed job. This customizes the
Java launcher UI, not the separate LauncherPrestarter download window.

LauncherRuntime external-browser OAuth resources receive a managed compatibility
patch during every launcher build. It replaces the device-code-specific prompt
with browser authorization instructions, removes the empty styled code label,
and renames the misleading password-persistence label to `Remember login`.
The source-pinned Java patch hides that second checkbox for web/OAuth methods
and persists their session automatically, leaving `Auto login` as the only
OAuth checkbox and as the sole control for restore-on-startup behavior.
The built-in Discord provider keeps the completed callback result pending until
LauncherRuntime sends its normal confirmation request, avoiding a premature
WebSocket auth state and the subsequent `You are already logged in` failure.
Discord OAuth and Minecraft access tokens occupy their correct protocol fields;
persisted OAuth sessions support both restore and refresh-token rotation.
Launcher-facing OAuth tokens are independent random LaunchServer session tokens;
Discord provider credentials remain server-side and never enter launcher TRACE
output.

### Slice 10: Client Build

Status: completed.

- Configure `MirrorHelper`.
- Apply workspace with explicit destructive confirmation.
- Build clients with `installClient name version loader mods`.
- Validate generated profile and update files.

The panel accepts only the official `5.7.x` workspace response matching
SHA-256 `51772ff2d1f3326862ca2cfa8f6e91d3d86a0406cd65a4eb0abaa114b43b7728`.
Applying it requires explicit confirmation, snapshots both the previous
manifest and workspace, and restores the previous workspace if the command
fails. Root-owned volume mutations use the same path-constrained in-container
file service. Client names, versions, loaders, and Modrinth slugs are schema-validated
before constructing the typed command.

Before `installClient`, the panel persists
`mirrorhelper setDisableDownloadAssets false`. This uses the dedicated
MirrorHelper configuration command from
`GravitLauncher/LauncherModules@0fcdfade1960c353a9f0bbb2f92055f05e22867d`
and makes MirrorHelper populate the shared Mojang assets update before the
profile is published. LauncherRuntime requires
`updates/<assetDir>/indexes/<assetIndex>.json`; a profile build is rejected if
that index is absent. The initial client build may therefore take longer while
LaunchServer downloads missing asset objects. Profiles retain the
source-defined `USE_DEFAULT_ASSETS` behavior.

Forge and NeoForge installer resolution follows the pinned
`MirrorHelper_module/installers/DownloadInstallerCommand` URL and version
selection rules. The panel performs those network requests itself because the
module's five-second URL timeout is too short for intermittent Maven TLS
connections. Installer artifacts are accepted only after verification against
the official Maven `.sha256` sidecar, and the selected loader version and digest
are recorded in job logs before `installClient`.

### Slice 11: Mod Manager

Status: completed.

- Search Modrinth.
- Filter by Minecraft version and loader.
- Install selected mods.
- Detect installed mods by file hashes.
- Bulk update/remove/disable.

Modrinth integration uses API v2.7.0 pinned to
`modrinth/code@366f528853dc32701e9670fd8d9c51fa3d136441`. Search and install
eligibility are filtered by project type, Minecraft version, and loader.
Installed JARs are resolved through SHA-1; updates are downloaded only from the
Modrinth CDN and verified with the API-provided SHA-512. Disable/enable uses
renames, and removal or replacement moves the old file into recoverable
profile-local trash.

Modpack import follows the official Modrinth `.mrpack` format version 1:
the panel resolves the latest compatible modpack version, validates archive and
manifest paths, limits expanded archive sizes, verifies every downloaded file
against its declared SHA-512, and applies `overrides`, `client-overrides`, and
`server-overrides` to their respective managed destinations. Manifest
`required`, `optional`, and `unsupported` environments prefill the destination
UI but remain operator-reviewable before the import job starts.

Client optionals are native GravitLauncher `updateOptional` entries verified
against `GravitLauncher/Launcher@81132768a711a0eab0e8b3b8b6c480b90f48795c`.
The panel manages their launcher name, description, category, visibility, file
action, and `mark` default state without introducing a second runtime config.

### Slice 12: File Auth Recipe

Status: completed.

- Discover auth provider ids and core types without returning provider secrets.
- Install/load the source-verified `FileAuthSystem` server module.
- Snapshot `LaunchServer.json` before applying the recipe.
- Execute only the typed `fileauthsystem install <authid>` command.
- Verify the persisted provider type after the command completes.

The recipe follows
`GravitLauncher/LauncherModules@ebe98aa204c3282430cef4dd5bbb75ac1c7d3e0a`,
the exact LauncherModules revision bundled by GravitLauncher `v5.7.9`.
`FileAuthSystem` replaces a selected `reject` core in place. When the selected
provider already uses another core, the upstream installer preserves it and
creates a non-default `fileauthsystem` provider. Repeated application is
idempotent and skips the config write when the provider is already configured.

### Slice 13: Existing Server Attach

Status: completed.

- Attach an already running official LauncherDockered checkout.
- Verify its upstream Git origin, exact revision, Compose shape, and `.env`
  metadata.
- Check Compose service state and wait for the existing control socket.
- Register LaunchServer without rewriting `.env`, running `compose up`, or
  restarting containers.

This first existing-server import mode deliberately supports
LauncherDockered-managed servers only. A standalone LaunchServer directory
needs a separate command and volume transport abstraction and is not presented
as supported by the current UI.

### Slice 14: Single-LaunchServer Layout and Profile State

Status: completed.

- Show the first-run LaunchServer setup wizard without the admin sidebar while
  no server is registered.
- Switch to the admin layout immediately after the first successful
  install/import/attach job.
- Keep exactly one LaunchServer and one shared server configuration per panel.
- Expose that server through a stateless root-Compose `launchserver` proxy so
  Coolify can attach the game domain without a second runtime or data volume.
- Use the desktop and mobile sidebar switcher only for client profiles
  discovered from that LaunchServer.
- Expose an explicit New profile action that opens a clean client draft without
  creating another LauncherDockered workspace.
- Keep the technical profile ID immutable after creation while exposing editable
  launcher-visible title, description, and sort order.
- Invalidate `.updates-cache` after profile or update mutations and restart
  LaunchServer so its normal initialization rebuilds the shared updates index
  and reloads profiles. Do not use the runtime
  `config profileProvider sync` command: it is not reliable across the managed
  LaunchServer builds.
- Before rebuilding an existing profile whose asset index is already present,
  perform the same cache invalidation and reload so MirrorHelper reuses the
  on-disk assets instead of downloading them again from an empty in-memory map.
- Preserve the existing profile UUID and presentation metadata across
  MirrorHelper rebuilds before that controlled reload.
- Remove profiles through an explicitly confirmed background job that moves the
  profile JSON and client update directory to recoverable panel trash before
  reloading LaunchServer.
- Use the singleton LaunchServer across Status, Modules, Auth, Users, Launcher,
  Clients, and Mods.
- Remove install controls for already loaded modules and configured file auth.
- Offer explicit reapply/reinstall/rebuild actions where repetition is
  supported.

Client preparation completion is not inferred from job history alone. The API
checks the pinned MirrorHelper manifest and Prestarter SHA-256 values, generated
launcher artifacts, and both the profile JSON and updates directory for a named
Minecraft client. Switching client profiles updates Clients and Mods while
jobs and server-wide settings remain scoped to the singleton LaunchServer.

### Slice 15: Auth Cores, Auth Modules Tab, and Users

Status: completed.

- Split auth-related catalog modules (`FileAuthSystem`, `MojangSupport`,
  `AdditionalHash`, `DiscordAuthSystem`) into a dedicated Modules Auth tab. The
  `DiscordAuthSystem` entry is a built-in standalone Java module stored under
  `modules/DiscordAuthSystem_module` with source link to `BADtochka/gravit-panel`.
  Discord OAuth is available as a built-in auth recipe: the Auth page opens a
  modal for Discord app credentials, required guilds, and nickname formatting,
  and writes both `LaunchServer.json` and `config/DiscordAuthSystem/Config.json`.
  FileAuthSystem module settings (`autoSave`) are configured from the Auth page.
  Every catalog entry carries a per-module source link (repository, revision,
  path).
- Expand the Auth page to apply verified built-in cores: memory, sql, http,
  merge, fileauthsystem, mojang, and microsoft. SQL writes include JDBC driver
  presets and password verifiers (`bcrypt`, `digest`, `doubleDigest`, `phpass`).
- Snapshot `LaunchServer.json` before provider writes; restart LaunchServer for
  non-file cores; keep the FileAuthSystem install command path.
- Add a Users page that CRUDs FileAuthSystem accounts through allowlisted
  control commands and Database.json reads, and shows adaptive guidance for
  unmanaged cores.

### Slice 16: Profile Server Binding and Bootstrap

Status: completed.

- Manage multiple `ClientProfile.ServerProfile` records from the selected
  client profile, including explicit legacy adoption, default-server
  reconciliation, recoverable profile snapshots, and controlled LaunchServer
  reloads.
- Keep server-only mods and configuration in an independent per-profile
  workspace. Modrinth installs reject client-only projects, resolve required
  dependencies, and verify CDN SHA-512 digests. Explicit publication creates an
  immutable, checksummed server-pack archive.
- Prepare source-verified Linux bootstrap bundles for Vanilla, Fabric, Forge,
  and NeoForge. Loader versions are extracted from the generated client
  profile; non-Vanilla preparation fails closed when the exact version is
  unavailable. Quilt and the legacy Java 8 bridge remain unsupported.
- Bundle the pinned Launcher `v5.7.9` ServerWrapper artifacts, compatible
  LauncherAuthlib, the selected server pack, and architecture-specific
  Adoptium Java 21 runtimes. The generated systemd installer supports x86_64
  and aarch64, works in the invoking `SUDO_USER` directory, accepts EULA only
  after explicit panel confirmation, and backs up patched JARs before updates.
- Issue the curl command through a 15-minute one-use claim. Store only claim,
  artifact, and report-token hashes; generate the native profile-scoped
  `token server` JWT only while serving the script; never persist it in panel
  jobs or SQLite.
- Surface the upstream security limitation prominently: the native checkServer
  JWT has no expiry or per-server revocation and the LaunchServer token command
  writes it to LaunchServer logs. Key rotation is required after compromise.

## Secondary Scope

- Built-in standalone Discord OAuth auth and other community auth modules beyond
  the built-in cores.
- Texture provider recipes, starting with URL template providers.
- Standalone (non-LauncherDockered) server import.
- Snapshot diff viewer.
- Backup and rollback.
- LauncherPrestarter Svelte/Tauri source customization and its Windows-native
  build pipeline. This remains separate from the completed LauncherRuntime
  asset customization.

## Open Questions

- Should the panel run only locally or support remote installation over SSH later?
- Should the panel manage nginx directly or only generate configs?
- Should the first public version support existing Gravit installs, or only fresh Dockered installs?
- Should Discord OAuth or community HTTP modules be added next?

## Source Links

- GravitLauncher: https://github.com/GravitLauncher
- Launcher: https://github.com/GravitLauncher/Launcher
- LauncherModules: https://github.com/GravitLauncher/LauncherModules
- LauncherDockered: https://github.com/GravitLauncher/LauncherDockered
- LauncherPrestarter: https://github.com/GravitLauncher/LauncherPrestarter
- Built-in DiscordAuthSystem module: modules/DiscordAuthSystem_module
- GravitLauncher quickstart: https://gravitlauncher.com/quickstart/
- Elysia: https://elysiajs.com/at-glance
- Bun Elysia guide: https://bun.com/docs/guides/ecosystem/elysia
- Tailwind Vite guide: https://tailwindcss.com/docs
- shadcn-vue Vite guide: https://www.shadcn-vue.com/docs/installation/vite
- Modrinth API: https://docs.modrinth.com/api/
- Modrinth pack format: https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack
- ServerWrapper: https://gravitlauncher.com/serverwrapper/
