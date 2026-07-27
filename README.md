# Gravit Panel

Web setup wizard and admin panel for GravitLauncher.

Stack:

- Vue 3, Vite, TypeScript
- Tailwind CSS, shadcn-vue
- Bun, Elysia
- Bun workspaces

Project plan: [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)

## Development

```bash
bun install
bun run dev
```

API runs on `http://127.0.0.1:3000` by default.
Web runs on `http://127.0.0.1:5173` by default.

Both services bind to the loopback interface by default. Set `HOST`, `WEB_HOST`,
and `CORS_ORIGINS` explicitly if remote access is required.

## Production deployment

The panel controls Docker Compose projects on the host. Its API container is
therefore intentionally given `/var/run/docker.sock`; whoever can access the
panel can affect Docker workloads on that host. The panel does not currently
provide its own user login. Keep the normal Compose port on loopback and put an
authenticated reverse proxy, SSO gateway, VPN, or IP allowlist in front of it.

### Docker Compose

Copy the environment example, select a permanent absolute host directory, then
start the stack:

```bash
cp .env.example .env
mkdir -p /srv/gravit-panel/data/launchserver
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

GitHub Actions publishes `ghcr.io/badtochka/gravit-panel-api`,
`ghcr.io/badtochka/gravit-panel-web`, and
`ghcr.io/badtochka/gravit-panel-launchserver-web` after every push to `main`.
Compose uses their `latest` tags by default; set the corresponding
`PANEL_*_IMAGE` variables to matching `sha-<commit>` tags for a pinned rollout.
If the GHCR packages remain private, configure registry credentials on the
deployment host or in Coolify.

`compose.yaml` exposes the web service only as `127.0.0.1:8080` by default.
Use an HTTPS reverse proxy to publish it. `PANEL_DATA_DIR` must be a host bind
mount at the **same absolute path inside the API container**, not a named Docker
volume: the panel creates nested LauncherDockered Compose projects whose bind
mounts must be resolved by the host Docker daemon. Back up this directory before
upgrades; it contains the SQLite database, encryption key, and managed
installations.

Set `CREDENTIAL_ENCRYPTION_KEY` to a separately backed-up 32-byte base64 key
if you do not want to use the generated persistent key. `CORS_ORIGINS` can stay
empty while the browser reaches the API through the same panel origin.

### Panel Discord access

Set `PANEL_AUTH_MODE=discord` to protect the panel with Discord OAuth. Configure
an OAuth2 application in the Discord Developer Portal with the `identify` scope
and add this exact redirect URI:

```text
https://panel.example.com/api/panel-auth/callback
```

Then set `PANEL_DISCORD_CLIENT_ID`, `PANEL_DISCORD_CLIENT_SECRET`, and
`PANEL_DISCORD_ALLOWED_USER_IDS` (a comma-separated allowlist of Discord user
IDs). The allowlist is required: a successful Discord login alone does not
grant administrative access.

The same stack starts an official `launchserver` service and its
`launchserver-web` nginx facade at `127.0.0.1:17549`. It serves updates and
forwards `/api` and `/webapi/` to LaunchServer. Set `LAUNCHSERVER_ADDRESS` to
the game domain before creating profiles or configuring Discord OAuth, then
publish this second local port through the game domain's HTTPS proxy.

### Coolify

Create an application with the **Docker Compose** build pack and select
`compose.coolify.yaml` as its compose file. Add these environment variables in
Coolify:

| Variable | Value |
| --- | --- |
| `CORS_ORIGINS` | Optional; normally empty for the same-origin web/API setup |

Assign the panel domain to the `web` service on port `80`, and the game domain
to `launchserver-web` on port `80`. The Coolify Compose configuration also
creates a wildcard FQDN for `launchserver-web` and passes it to LaunchServer as
its `ADDRESS`; it generates and persists the panel's base64 encryption key.
Both values use Coolify magic environment variables, so do not define
`LAUNCHSERVER_ADDRESS` or `CREDENTIAL_ENCRYPTION_KEY` in Coolify. Coolify pulls
the published panel images, runs the declared health checks, and terminates TLS
at its proxy. The `api` and `launchserver` services are not published directly.
The LaunchServer nginx configuration is included in the published
`gravit-panel-launchserver-web` image, so an image-only deployment does not
need a checked-out `deploy/` directory.
The panel service also receives a generated Coolify FQDN. In the Discord
Developer Portal, add the exact redirect URI shown by
`SERVICE_FQDN_PANELWEB` as `https://<generated-fqdn>/api/panel-auth/callback`.
Set `PANEL_DISCORD_CLIENT_ID`, `PANEL_DISCORD_CLIENT_SECRET`, and
`PANEL_DISCORD_ALLOWED_USER_IDS` in Coolify; the last value is a comma-separated
administrator allowlist. Do not enable either Build Variable checkbox for the
client secret: it is needed only at runtime.
Create `/data/gravit-panel/launchserver` on the target Docker host before the
first deployment. Coolify forbids `${...}` interpolation in volume paths, so
the Coolify Compose file intentionally uses this fixed path; it must not be
inside Coolify's temporary source checkout.
Keep the Discord allowlist limited to panel administrators: this panel has
privileged Docker access.

The Coolify domain publishes the panel only. A configured Discord OAuth
callback for a LaunchServer still needs the game domain's proxy to forward
`/webapi/` to that LaunchServer installation, separately from this stack.

LauncherDockered installation requires an explicit in-app confirmation showing
the target path, address, Compose project, and operation mode. The API also
requires the corresponding literal confirmation field, so the dialog cannot be
bypassed by an accidental form submission.

Fresh installations are written under `./data/installations` by default. Set
`INSTALLATIONS_ROOT` to use another controlled directory.

RemoteControl credentials require a persistent 32-byte encryption key. Generate
it from the RemoteControl section in the Status page. The server stores it as
`./data/credential-encryption.key` with mode `0600`; the key is never returned
to the browser.

An externally managed key remains supported and takes precedence:

```bash
CREDENTIAL_ENCRYPTION_KEY="<base64-encoded 32-byte key>" bun run dev
```

Keep the generated key file or environment key between restarts. Changing or
losing it makes existing RemoteControl credentials unreadable; status commands
will safely fall back to the local `control-file`.

## MVP operations

- Source-verified LaunchServer and launcher module catalog.
- Checksum-pinned MirrorHelper workspace and LauncherPrestarter installation.
- Launcher and Minecraft client builds with live job logs.
- Launcher artifact hashing and installation-scoped downloads.
- Modrinth search, compatible mod installation, hash detection, verified
  updates, disable/enable, and recoverable removal.
- Source-verified FileAuthSystem configuration with sanitized provider discovery
  and LaunchServer.json snapshots.
- Built-in auth core recipes (memory, SQL, HTTP, merge, Mojang/Microsoft,
  Discord OAuth) plus a Modules Auth tab for FileAuthSystem, MojangSupport,
  AdditionalHash, and the built-in DiscordAuthSystem module. Discord OAuth
  configuration is edited in a dedicated modal; FileAuthSystem module settings
  live on the Auth page. Every catalog entry links to its pinned source
  repository.
- Adaptive Users page with FileAuthSystem account CRUD and guidance for
  externally managed providers.
- Read-only attachment of an already running official LauncherDockered checkout.
- Profile-aware navigation: first-run setup is fullscreen, while registered
  projects use one persisted sidebar selection across every operational page.

Machine-changing operations are fixed typed jobs. Workspace replacement and mod
removal require explicit UI confirmations; existing files are snapshotted or
moved to recoverable trash before replacement.

Completed setup actions are derived from runtime files and pinned SHA-256
values. The UI hides non-repeatable completed actions and labels safe repeat
operations as reapply, reinstall, rebuild, or token rotation.

LaunchServer owns its Docker volume as `root`. The API performs volume
mutations through fixed `docker compose exec` commands constrained to
`/app/data`; it does not relax host permissions or expose arbitrary shell
execution.
