#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

OUTPUT_DIR="${1:-build/docker}"
IMAGE_TAG="gravit-panel/discord-auth-module-builder:latest"

echo "Building DiscordAuthSystem module in Docker..."
docker build -t "${IMAGE_TAG}" .

mkdir -p "${OUTPUT_DIR}"
CONTAINER_ID=$(docker create "${IMAGE_TAG}")
docker cp "${CONTAINER_ID}:/DiscordAuthSystem_module.jar" "${OUTPUT_DIR}/DiscordAuthSystem_module.jar"
docker rm -f "${CONTAINER_ID}" >/dev/null

echo "Module JAR written to: ${OUTPUT_DIR}/DiscordAuthSystem_module.jar"
