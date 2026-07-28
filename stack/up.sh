#!/usr/bin/env bash
# Bring up the local stack: a real CMS and a real S3 target, both in containers.
#
# The point of this stack is not convenience. Six phases shipped against mocks,
# so auth, cursor pagination, listing caps, ETags and rate limits have never been
# exercised by anything -- and a mock only fails in ways somebody remembered to
# write. Real software on localhost fails in its own ways, and the proxy in front
# of it (see stack/proxy) supplies the ones that need a network to be interesting.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./env.sh
source "$here/env.sh"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m warn\033[0m %s\n' "$*" >&2; }

running() { podman container inspect "$1" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; }
exists() { podman container exists "$1"; }

start_container() {
  local name="$1"; shift
  if running "$name"; then
    log "$name already running"
    return 0
  fi
  if exists "$name"; then
    log "starting existing $name"
    podman start "$name" >/dev/null
    return 0
  fi
  log "creating $name"
  podman run -d --name "$name" "$@" >/dev/null
}

podman volume exists "$ISSG_DIRECTUS_VOLUME" || podman volume create "$ISSG_DIRECTUS_VOLUME" >/dev/null
podman volume exists "$ISSG_S3_VOLUME" || podman volume create "$ISSG_S3_VOLUME" >/dev/null

# --- Directus ----------------------------------------------------------------
# ADMIN_EMAIL/ADMIN_PASSWORD are consumed by `cli.js bootstrap`, which the image
# entrypoint runs before the server starts. That is what makes this account
# creation scriptable: there is no first-run form to fill in.
start_container "$ISSG_DIRECTUS_NAME" \
  -p "127.0.0.1:${ISSG_DIRECTUS_PORT}:8055" \
  -v "${ISSG_DIRECTUS_VOLUME}:/directus/database" \
  -e "KEY=${ISSG_DIRECTUS_KEY}" \
  -e "SECRET=${ISSG_DIRECTUS_SECRET}" \
  -e "ADMIN_EMAIL=${ISSG_DIRECTUS_EMAIL}" \
  -e "ADMIN_PASSWORD=${ISSG_DIRECTUS_PASSWORD}" \
  -e "WEBSOCKETS_ENABLED=false" \
  "$ISSG_DIRECTUS_IMAGE"

# --- MinIO -------------------------------------------------------------------
start_container "$ISSG_S3_NAME" \
  -p "127.0.0.1:${ISSG_S3_PORT}:9000" \
  -p "127.0.0.1:${ISSG_S3_CONSOLE_PORT}:9001" \
  -v "${ISSG_S3_VOLUME}:/data" \
  -e "MINIO_ROOT_USER=${ISSG_S3_ACCESS_KEY}" \
  -e "MINIO_ROOT_PASSWORD=${ISSG_S3_SECRET_KEY}" \
  "$ISSG_S3_IMAGE" server /data --console-address ":9001"

# --- Wait for readiness ------------------------------------------------------
# Both get a bounded wait that reports which one failed. A stack script that
# exits 0 while a service is still booting turns every downstream failure into a
# race nobody can reproduce.
wait_for() {
  local label="$1" url="$2" deadline=$((SECONDS + 120))
  log "waiting for $label at $url"
  until curl -fsS -o /dev/null --max-time 3 "$url" 2>/dev/null; do
    if ((SECONDS > deadline)); then
      warn "$label did not become ready within 120s"
      warn "logs: podman logs --tail 40 $label"
      return 1
    fi
    sleep 1
  done
  log "$label ready"
}

wait_for "$ISSG_DIRECTUS_NAME" "${ISSG_DIRECTUS_URL}/server/ping"
wait_for "$ISSG_S3_NAME" "${ISSG_S3_ENDPOINT}/minio/health/live"

cat <<EOF

  Directus  ${ISSG_DIRECTUS_URL}          (${ISSG_DIRECTUS_EMAIL} / ${ISSG_DIRECTUS_PASSWORD})
  MinIO S3  ${ISSG_S3_ENDPOINT}          (${ISSG_S3_ACCESS_KEY} / ${ISSG_S3_SECRET_KEY})
  MinIO UI  http://127.0.0.1:${ISSG_S3_CONSOLE_PORT}

  Next: stack/seed.ts provisions the Directus schema and the MinIO bucket.
EOF
