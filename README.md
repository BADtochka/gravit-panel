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
- Built-in auth core recipes (memory, SQL, HTTP, merge, Mojang/Microsoft) plus a
  Modules Auth tab for FileAuthSystem, MojangSupport, and AdditionalHash.
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
