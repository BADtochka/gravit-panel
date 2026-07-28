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

FROM gradle:8.10.2-jdk21-alpine AS launcher-runtime-build
RUN apk add --no-cache git
WORKDIR /src
RUN git clone https://github.com/GravitLauncher/LauncherRuntime.git . \
    && git checkout --detach 755e5509b1f573817a977b4180a2f84517619025
COPY deploy/launcher-runtime/oauth-controls.patch /tmp/oauth-controls.patch
RUN git apply --check /tmp/oauth-controls.patch \
    && git apply /tmp/oauth-controls.patch \
    && gradle --no-daemon clean jar \
    && mkdir -p /out \
    && cp build/libs/JavaRuntime.jar /out/JavaRuntime.jar \
    && cd /out \
    && sha256sum JavaRuntime.jar > JavaRuntime.jar.sha256

# The API manages LauncherDockered installations, so it deliberately contains
# the Docker CLI and Compose plugin. It must be given the host Docker socket at
# runtime; see compose.yaml before exposing this service to the Internet.
FROM build AS api-runtime
RUN apk add --no-cache docker-cli docker-cli-compose git tar
COPY --from=launcher-runtime-build /out /opt/gravit-panel/launcher-runtime
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
