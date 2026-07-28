# syntax=docker/dockerfile:1

FROM oven/bun:1.2.19-alpine AS dependencies
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run --filter @gravit-panel/web build

# The API manages LauncherDockered installations, so it deliberately contains
# the Docker CLI and Compose plugin. It must be given the host Docker socket at
# runtime; see compose.yaml before exposing this service to the Internet.
FROM build AS api-runtime
RUN apk add --no-cache docker-cli docker-cli-compose git
ENV NODE_ENV=production
WORKDIR /app
EXPOSE 3000
CMD ["bun", "run", "--filter", "@gravit-panel/api", "start"]

FROM nginx:1.27-alpine AS web-runtime
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx/40-panel-runtime-config.sh /docker-entrypoint.d/40-panel-runtime-config.sh
RUN chmod 0555 /docker-entrypoint.d/40-panel-runtime-config.sh
EXPOSE 80

FROM nginx:1.27-alpine AS launchserver-web-runtime
COPY deploy/launchserver/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

FROM ghcr.io/gravitlauncher/launcher:v5.7.9 AS launchserver-runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*
COPY deploy/launchserver/20-sync-public-urls.sh /app/bin/gravit-panel-launchserver
RUN chmod 0555 /app/bin/gravit-panel-launchserver
ENTRYPOINT ["/app/bin/gravit-panel-launchserver"]
