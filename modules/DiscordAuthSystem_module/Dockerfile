FROM gradle:8.5-jdk21 AS builder

WORKDIR /workspace

# Install unzip to extract the LaunchServer archive.
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*

# Pinned LaunchServer build used by the panel. These values must match
# apps/api/src/modules/modules/module-catalog.ts.
ARG LAUNCHSERVER_URL=https://github.com/GravitLauncher/Launcher/releases/download/v5.7.9/LaunchServerBuild.zip
ARG LAUNCHSERVER_SHA256=cfc60bfdf023c1e73031828406e9170b519f17a053c8056a0f0cbce887233f07

# Download the same LaunchServer build that the panel installs, verify its
# SHA-256, and collect all provided JARs as compile-only dependencies.
RUN curl -fsSL -o LaunchServerBuild.zip "${LAUNCHSERVER_URL}" \
    && echo "${LAUNCHSERVER_SHA256}  LaunchServerBuild.zip" | sha256sum -c - \
    && unzip -q LaunchServerBuild.zip -d launchserver \
    && mkdir -p /libs \
    && find launchserver -name "*.jar" -exec cp {} /libs/ \;

# Copy the module source and build it against the LaunchServer JARs.
COPY . /workspace/module/
WORKDIR /workspace/module
RUN mkdir -p libs && cp /libs/*.jar libs/ \
    && gradle --no-daemon build

# Export only the resulting module JAR. The file is renamed so downstream steps
# (panel install, Docker volume copy) get a stable filename.
FROM scratch AS export
COPY --from=builder /workspace/module/build/libs/DiscordAuthSystem_module-1.0.11.jar /DiscordAuthSystem_module.jar
CMD ["/DiscordAuthSystem_module.jar"]
