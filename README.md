# Gravit Panel

Web setup wizard and admin panel for [GravitLauncher](https://github.com/GravitLauncher/Launcher).

Stack:

- Vue 3, Vite, TypeScript
- Tailwind CSS, shadcn-vue
- Bun, Elysia
- Bun workspaces
- Go host agent for remote systemd Minecraft servers

Project plan: [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)

## Architecture

The panel Compose stack has three services:

- **api** — Bun + Elysia backend. Manages LaunchServer, modules, launcher and
  client builds, mods, and auth providers. Holds the host Docker socket to
  control nested Compose projects.
- **web** — nginx serving the Vue SPA and proxying `/api/` to the API.
- **launchserver** — a stateless nginx facade that gives Compose and Coolify a
  stable service target for the one panel-managed LaunchServer.

Each panel creates and manages exactly one
[LauncherDockered](https://github.com/GravitLauncher/LauncherDockered) workspace
on the Docker host. Its runtime runs the official
`ghcr.io/gravitlauncher/launcher` image plus an nginx facade, which publishes
port **17549** on the host and serves launcher updates, profile downloads, and
the launcher WebSocket/API endpoints. Additional Minecraft clients are
LaunchServer profiles inside that shared workspace; they do not create more
runtime containers or independent configuration trees. The Compose
`launchserver` service only proxies to that managed facade; it owns no data and
has no separate `LaunchServer.json`.

```text
https://panel.example.com  → reverse proxy → gravit-panel web (127.0.0.1:8080)
https://mine.example.com   → launchserver service → managed nginx (host:17549)
```

The managed workspace uses `PANEL_DATA_DIR/installations/default`. The proxy
service does not mount the legacy `PANEL_DATA_DIR/launchserver` directory.

Managed Minecraft servers run on remote Linux hosts through the outbound
`gravit-agent` WebSocket connection. One host agent can manage multiple server
bindings. Commands use local RCON, logs come from journald, and no RCON or
management port is exposed to the panel. Production API images contain static
agent binaries for Linux amd64 and arm64.

Remote hosts require systemd, journald, nftables, and `ss` from iproute2. The
bootstrap command installs the agent, creates its systemd service, and adds a
fail-closed nftables rule for each local RCON port. Existing servers need one
new bootstrap run to enable runtime management alongside the legacy pack-update
timer; moving pack application into the agent is a later migration step.

## Development

```bash
bun install
bun run build:launcher-runtime:local
make -C agent build
export SERVER_AGENT_ARTIFACTS_DIR="$PWD/agent/dist"
bun run dev
```

API runs on `http://127.0.0.1:3000` by default.
Web runs on `http://127.0.0.1:5173` by default.
The one-time Docker build writes the patched `JavaRuntime.jar` to the ignored
local API data directory. Production API images already contain this artifact.

Both services bind to the loopback interface by default. Set `HOST`, `WEB_HOST`,
and `CORS_ORIGINS` explicitly if remote access is required.

Run tests and type checks with:

```bash
bun test
bun run check
```

## Production deployment

The panel controls Docker Compose projects on the host. Its API container is
therefore intentionally given `/var/run/docker.sock`; whoever can access the
panel can affect Docker workloads on that host. Keep the panel port on loopback,
enable Discord authentication, and put an HTTPS reverse proxy in front of it.

### Docker Compose

```bash
cp .env.example .env
mkdir -p /srv/gravit-panel/data
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

GitHub Actions publishes `ghcr.io/badtochka/gravit-panel-api` and
`ghcr.io/badtochka/gravit-panel-web` after every push to `main`. Compose uses
their `latest` tags by default; set `PANEL_API_IMAGE` / `PANEL_WEB_IMAGE` to
matching `sha-<commit>` tags for a pinned rollout. If the GHCR packages remain
private, configure registry credentials on the deployment host or in Coolify.
To redeploy Coolify only after both images are published, configure the
`COOLIFY_API_URL`, `COOLIFY_API_TOKEN`, and `COOLIFY_APPLICATION_UUID` GitHub
Actions secrets. Use a team-scoped token with only `read` and `deploy`
permissions. Configure the same values as Coolify environment variables to
enable the authenticated update banner and deploy button inside the panel.
Disable Coolify's repository push trigger to avoid an earlier duplicate
deployment. Compose uses `pull_policy: always` for API and web so mutable
`latest` tags are refreshed before containers restart.

`compose.yaml` exposes the web service as `127.0.0.1:8080` and the LaunchServer
facade as `127.0.0.1:9274`. Publish them through their respective HTTPS reverse
proxies. `PANEL_DATA_DIR` must be a host bind mount at
the **same absolute path inside the API container**, not a named Docker volume:
the panel creates nested LauncherDockered Compose projects whose bind mounts
must be resolved by the host Docker daemon. Back up this directory before
upgrades; it contains the SQLite database, the credential encryption key, and
the managed LaunchServer workspace.

### Panel public URL

`PANEL_PUBLIC_URL` is the single source of truth for the panel's address. Its
path component automatically drives the SPA sub-route and the OAuth callback:

| Deployment | Value |
| --- | --- |
| Root | `PANEL_PUBLIC_URL=https://panel.example.com` |
| Sub-path | `PANEL_PUBLIC_URL=https://example.com/panel` |

`PANEL_PUBLIC_PATH` no longer needs to be set; it is derived from the URL. Keep
it only as an override when the reverse proxy strips a different prefix than
the path portion of `PANEL_PUBLIC_URL`.

### Discord access

Set `PANEL_AUTH_MODE=discord` to protect the panel with Discord OAuth. Create
an OAuth2 application in the Discord Developer Portal with the `identify` scope
and register this exact redirect URI:

```text
<PANEL_PUBLIC_URL>/api/panel-auth/callback
```

For example `https://panel.example.com/api/panel-auth/callback`, or
`https://example.com/panel/api/panel-auth/callback` when hosted below a path.
Then set `PANEL_DISCORD_CLIENT_ID`, `PANEL_DISCORD_CLIENT_SECRET`, and
`PANEL_DISCORD_ALLOWED_USER_IDS` (a comma-separated allowlist of Discord user
IDs). The allowlist is required: a successful Discord login alone does not
grant administrative access.

When hosting below a sub-path, the reverse proxy must route
`PathPrefix(<path>)` to the panel and strip that prefix before forwarding;
`compose.coolify.yaml` ships the matching Traefik middlewares.

### Game domain routing

Launcher clients reach LaunchServer through the Compose `launchserver` facade.
For a regular Docker Compose deployment it is published on host port `9274`
(HTTP only). Point your game domain at it through your HTTPS proxy:

```nginx
# nginx example
server {
    listen 443 ssl;
    server_name mine.example.com;
    # ssl_certificate ...;
    location / {
        proxy_pass http://127.0.0.1:9274;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

WebSocket upgrade headers are required: the launcher protocol connects to
`wss://<game-domain>/api`. Terminate TLS at the proxy and forward
`X-Forwarded-Proto` so LaunchServer keeps generating `https://`/`wss://` URLs.

When you set up LaunchServer in the panel, set its **address** to the game
domain (for example `mine.example.com`, without scheme or path). The panel
synchronizes the persisted launcher download URLs and WebSocket address to that
value on every install and restart.

### Coolify

Create an application with the **Docker Compose** build pack and select
`compose.coolify.yaml` as its compose file. Assign the panel domain to `web` on
port `80` and the game/launcher domain to `launchserver` on port `80`. Coolify
terminates TLS at its proxy, provides the encryption key through
`SERVICE_REALBASE64_32_GRAVITPANEL`, and builds `PANEL_PUBLIC_URL` from the
generated FQDN. Set the three `PANEL_DISCORD_*` variables in Coolify and
register `https://<panel-domain>/api/panel-auth/callback` in Discord (with the
`/panel` infix when `PANEL_PUBLIC_PATH=/panel` is set).

Create `/data/gravit-panel` on the target Docker host before the first
deployment. Coolify forbids `${...}` interpolation in volume paths, so the
Coolify Compose file intentionally uses this fixed path; it must not be
inside Coolify's temporary source checkout.

`SERVICE_URL_LAUNCHSERVER_80` makes Coolify route that domain directly to the
Compose service. The service preserves WebSocket upgrade and forwarded HTTPS
headers, then proxies to the managed LauncherDockered facade on host port
`17549`. No manual Traefik dynamic configuration is required.

Coolify passes the generated `SERVICE_FQDN_LAUNCHSERVER_80` into the setup form.
Confirm that this is the intended game domain before creating LaunchServer.
The old `PANEL_DATA_DIR/launchserver` directory from standalone deployments is
not mounted and remains untouched for recovery.

## Operations

- Source-verified LaunchServer and launcher module catalog.
- Checksum-pinned MirrorHelper workspace and LauncherPrestarter installation.
- Launcher and Minecraft client builds with live job logs.
- Automatic Eclipse Temurin JRE/JDK downloads with checksum verification, local
  ZIP fallback, profile compatibility ranges, recoverable removal, and
  automatic launcher rebuilds.
- Launcher artifact hashing and server-scoped downloads.
- Modrinth search, compatible mod installation, hash detection, verified
  updates, local or catalog `.mrpack` import, disable/enable, and recoverable
  removal.
- Source-verified FileAuthSystem configuration with sanitized provider discovery
  and LaunchServer.json snapshots.
- Built-in auth core recipes (memory, SQL, HTTP, merge, Mojang/Microsoft,
  Discord OAuth) plus a Modules Auth tab for FileAuthSystem, MojangSupport,
  AdditionalHash, and the built-in DiscordAuthSystem module.
- Adaptive Users page with FileAuthSystem account CRUD and guidance for
  externally managed providers.
- Read-only attachment of an already running official LauncherDockered checkout.
- Profile-aware navigation: first-run LaunchServer setup is fullscreen, while
  the sidebar persists one client-profile selection across operational pages.

Machine-changing operations are fixed typed jobs. Workspace replacement and mod
removal require explicit UI confirmations; existing files are snapshotted or
moved to recoverable trash before replacement. LaunchServer setup
requires an explicit in-app confirmation showing the target path, address,
Compose project, and operation mode.

RemoteControl credentials require a persistent 32-byte encryption key. The
panel generates and persists one as `credential-encryption.key` (mode `0600`)
inside the data directory; an externally managed `CREDENTIAL_ENCRYPTION_KEY`
takes precedence. Keep the key between restarts — losing it makes existing
RemoteControl credentials unreadable, and status commands safely fall back to
the local `control-file`.

LaunchServer owns its Docker volume as `root`. The API performs volume
mutations through fixed `docker compose exec` commands constrained to
`/app/data`; it does not relax host permissions or expose arbitrary shell
execution.
