# Gravit Host Agent

Production-conscious MVP host agent for connecting systemd-managed Minecraft servers to a Gravit panel. One process supports multiple bindings; each binding maintains an independent outbound WebSocket, systemd unit, journal stream, command lock, and RCON target.

## Requirements

- Linux with `systemctl` and `journalctl` available on `PATH`
- Go 1.22 or newer for source builds
- Network access to the panel and configured RCON listeners
- A service account authorized to control and read the configured units

The agent never invokes a shell. It executes fixed `systemctl` and `journalctl` programs with argument arrays, and accepts only server units using a safe lowercase slug:

- `gravit-main.service`
- `gravit-glavniy.service`

Legacy UUID-based `gravit-*` service names remain valid.

## Configuration

The host configuration must use exactly one binding source:

- `bindingsDir` for production host deployments. Every sorted `*.json` file contains one binding.
- Inline `bindings` for tests and manual configurations, as shown in `config.example.json`.

`config.host.example.json` and `bindings.example.d/server-one.json` show the directory layout. Relative `bindingsDir` values are resolved relative to the host configuration file. The directory must not be a symlink and must have no group or world permissions. Every `*.json` fragment must be a regular, non-symlink file with exactly mode `0600`; malformed fragments, duplicate binding IDs, and empty fragment directories prevent startup.

```sh
sudo install -d -m 0750 /etc/gravit-agent
sudo install -d -m 0700 /etc/gravit-agent/bindings.d
sudo install -d -m 0700 /var/lib/gravit-agent
sudo install -m 0600 config.host.example.json /etc/gravit-agent/config.json
sudo install -m 0600 bindings.example.d/server-one.json /etc/gravit-agent/bindings.d/server-one.json
sudo editor /etc/gravit-agent/config.json
```

`panelUrl` may use `http`, `https`, `ws`, or `wss`. The agent converts HTTP schemes to WebSocket schemes and appends `/api/server-agent/connect`. `heartbeatIntervalSeconds` defaults to 15. Each RCON timeout defaults to 10 seconds. `stateDir` defaults to `/var/lib/gravit-agent`; it must be a real owner-only directory.

Run the agent:

```sh
./gravit-agent -config /etc/gravit-agent/config.json
```

## Protocol Behavior

For every configured binding, the agent:

1. Opens a separate outbound WebSocket and sends the binding token in the required `hello` message.
2. Sends an initial status, then periodic heartbeats and refreshed runtime status.
3. Acknowledges every valid command envelope before execution.
4. Enqueues commands in arrival order and executes them through one serial worker per binding. The queue is bounded at 64 waiting commands; only actual capacity exhaustion fails a newly accepted command.
5. Atomically persists command acceptance before side effects and retains the last 4096 terminal results per binding in `stateDir`. Redelivered IDs replay the prior result without executing again, including across process restarts; duplicates still in flight wait for the original result.
6. Reports completion or failure with output capped at 64 KiB.
7. Follows the binding's journal with `journalctl --follow --output=json`, persists each cursor only after its log message is sent, and resumes with `--after-cursor` across reconnects and restarts. Invalid cursors fall back to at most 200 entries from the last five minutes before following continues.
8. Reconnects WebSockets with jittered exponential backoff bounded at 30 seconds.

Command and journal-cursor snapshots use hashed binding filenames, mode `0600`, file `fsync`, atomic rename, and directory `fsync`. If the process restarts after acceptance but before recording a terminal result, the agent permanently records and returns a terminal failure stating that the outcome is unknown; it never retries the side effect. Console input is limited to 1000 bytes. Minecraft RCON framing and authentication are implemented directly with the Go standard library; command responses are collected until a short quiet period, and no command is passed through a shell.

SIGINT and SIGTERM cancel active operations, stop journal followers, close WebSockets, and wait for binding workers to exit.

## Build and Test

```sh
make test
make build
```

`make build` creates static Linux amd64 and arm64 binaries under `dist/`.

## systemd Permissions

Run under a dedicated account. Grant only the required PolicyKit or sudo/systemd permissions for the exact validated units, and journal read access (commonly membership in `systemd-journal`). Do not run as root unless the deployment environment requires it. RCON should listen on loopback or a protected private network.
