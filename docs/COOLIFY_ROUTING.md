# Coolify Routing

The `web` service owns the public hostname. Its `/launcher/` path is proxied to
the `launchserver` service with the prefix stripped: for example,
`/launcher/webapi/auth/discord` becomes `/webapi/auth/discord` upstream.

## Required domains

Assign distinct domains in Coolify:

| Service | Example domain | Purpose |
| --- | --- | --- |
| `web` | `https://panel.example.com` | Public launcher page, player cabinet, and panel API proxy |
| `launchserver` | `https://launcher.example.com` | Native GravitLauncher endpoint; it also receives `/launcher/` traffic from `web` |

Do not assign the panel domain to `launchserver` when it is meant to display
the public page. A `GET /healthz` response of `ok` proves the domain currently
reaches `launchserver`, not `web`.

## Coolify setup

1. Remove the panel domain from the `launchserver` service domains.
2. Add the panel domain to the `web` service domains.
3. Add a distinct domain, for example `https://launcher.example.com`, to the
   `launchserver` service domains. The web nginx also routes `/launcher/*` to
   that service and removes `/launcher` before proxying.
4. Redeploy the Compose application. Coolify will populate
   `SERVICE_FQDN_PANELWEB` and `SERVICE_FQDN_LAUNCHSERVER_80` from those
   assignments.
5. Coolify supplies its stable `SERVICE_REALBASE64_32_GRAVITPANEL` magic
   variable to both the credential and portal HMAC settings. Do not override
   `PUBLIC_PORTAL_HMAC_SECRET` in the Coolify environment.
6. Add both redirects to the Discord application:
   `https://panel.example.com/launcher/webapi/auth/discord` and
   `https://panel.example.com/launcher/webapi/auth/discord/portal`.

After deployment, verify the routes:

```sh
curl -I https://panel.example.com/
curl -i https://panel.example.com/launcher/healthz
```

The first request must be `200` from the web nginx service. The second must
return `ok` from the LaunchServer facade.
