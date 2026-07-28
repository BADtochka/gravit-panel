# Gravit Panel

Web setup wizard and admin panel for [GravitLauncher](https://github.com/GravitLauncher/Launcher).

Stack:

- Vue 3, Vite, TypeScript
- Tailwind CSS, shadcn-vue
- Bun, Elysia
- Bun workspaces

Project plan: [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)

## Architecture

The panel itself is only two containers:

- **api** — Bun + Elysia backend. Manages installations, modules, launcher and
  client builds, mods, and auth providers. Holds the host Docker socket to
  control nested Compose projects.
- **web** — nginx serving the Vue SPA and proxying `/api/` to the API.

Game servers are **not** part of the panel stack. The panel creates and manages
[LauncherDockered](https://github.com/GravitLauncher/LauncherDockered)
installations on the Docker host. Every installation runs the official
`ghcr.io/gravitlauncher/launcher` image plus its own nginx facade, which
publishes port **17549** on the host and serves launcher updates, profile
downloads, and the launcher WebSocket/API endpoints.

```text
https://panel.example.com  → reverse proxy → gravit-panel web (127.0.0.1:8080)
https://mine.example.com   → reverse proxy → installation nginx (host:17549)
```

The Compose files also include an **optional standalone `launchserver`
service** built from the stock official image (`ghcr.io/gravitlauncher/launcher`,
no custom build). It is a convenience for simple setups: the panel does not
manage it, it keeps its data in `PANEL_DATA_DIR/launchserver`, and its netty
port (`127.0.0.1:9274`, WebSocket API plus update files when
`fileServerEnabled`) stays on the host loopback until you proxy a game domain
to it. Managed game servers are always LauncherDockered installations.

## Development

```bash
bun install
bun run dev
```

API runs on `http://127.0.0.1:3000` by default.
Web runs on `http://127.0.0.1:5173` by default.

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

`compose.yaml` exposes the web service only as `127.0.0.1:8080`. Publish it
through your HTTPS reverse proxy. `PANEL_DATA_DIR` must be a host bind mount at
the **same absolute path inside the API container**, not a named Docker volume:
the panel creates nested LauncherDockered Compose projects whose bind mounts
must be resolved by the host Docker daemon. Back up this directory before
upgrades; it contains the SQLite database, the credential encryption key, and
all managed installations.

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

Launcher clients reach their game server through the installation's own nginx
facade, which every LauncherDockered project publishes on host port `17549`
(HTTP only). Point your game domain at it through your HTTPS proxy:

```nginx
# nginx example
server {
    listen 443 ssl;
    server_name mine.example.com;
    # ssl_certificate ...;
    location / {
        proxy_pass http://127.0.0.1:17549;
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

When you create an installation in the panel, set its **address** to the game
domain (for example `mine.example.com`, without scheme or path). The panel
synchronizes the persisted launcher download URLs and WebSocket address to that
value on every install and restart.

### Coolify

Create an application with the **Docker Compose** build pack and select
`compose.coolify.yaml` as its compose file. The stack contains only the `api`
and `web` services; assign the panel domain to `web` on port `80`. Coolify
terminates TLS at its proxy, provides the encryption key through
`SERVICE_REALBASE64_32_GRAVITPANEL`, and builds `PANEL_PUBLIC_URL` from the
generated FQDN. Set the three `PANEL_DISCORD_*` variables in Coolify and
register `https://<panel-domain>/api/panel-auth/callback` in Discord (with the
`/panel` infix when `PANEL_PUBLIC_PATH=/panel` is set).

Create `/data/gravit-panel` on the target Docker host before the first
deployment. Coolify forbids `${...}` interpolation in volume paths, so the
Coolify Compose file intentionally uses this fixed path; it must not be inside
Coolify's temporary source checkout.

Game servers are created afterwards from the panel UI as LauncherDockered
installations; they are not Coolify services. To publish the game domain
through Coolify's Traefik, route it to the installation facade on the host by
adding a dynamic configuration on the Docker host, for example
`/data/coolify/proxy/dynamic/gravit-launcher.yaml`:

```yaml
http:
  routers:
    gravit-launcher:
      rule: "Host(`mine.example.com`)"
      entryPoints: [https]
      tls:
        certResolver: letsencrypt
      service: gravit-launcher
  services:
    gravit-launcher:
      loadBalancer:
        servers:
          - url: "http://172.17.0.1:17549"
```

Check the existing files in `/data/coolify/proxy/dynamic/` for the exact
`entryPoints`/`certResolver` names used by your Coolify version, and use the
`docker0` gateway address if it differs from `172.17.0.1`
(`ip -4 addr show docker0`). Traefik reloads dynamic configurations without a
restart and proxies WebSocket upgrades on the same router automatically.

## Operations

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
  AdditionalHash, and the built-in DiscordAuthSystem module.
- Adaptive Users page with FileAuthSystem account CRUD and guidance for
  externally managed providers.
- Read-only attachment of an already running official LauncherDockered checkout.
- Profile-aware navigation: first-run setup is fullscreen, while registered
  projects use one persisted sidebar selection across every operational page.

Machine-changing operations are fixed typed jobs. Workspace replacement and mod
removal require explicit UI confirmations; existing files are snapshotted or
moved to recoverable trash before replacement. LauncherDockered installation
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
