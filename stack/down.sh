#!/usr/bin/env bash
# Stop the local stack. Pass --clean to also drop the volumes.
#
# Stopping and wiping are separate on purpose: the default leaves the Directus
# content and the MinIO bucket intact, because re-seeding a corpus is the slow
# part and losing it to a reflexive teardown is annoying. --clean is the one that
# destroys data and it says so before doing it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./env.sh
source "$here/env.sh"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }

clean=false
[[ "${1:-}" == "--clean" ]] && clean=true

for name in "$ISSG_DIRECTUS_NAME" "$ISSG_S3_NAME"; do
  if podman container exists "$name"; then
    log "removing $name"
    podman rm -f "$name" >/dev/null
  fi
done

if $clean; then
  for vol in "$ISSG_DIRECTUS_VOLUME" "$ISSG_S3_VOLUME"; do
    if podman volume exists "$vol"; then
      log "destroying volume $vol (all content and objects in it)"
      podman volume rm "$vol" >/dev/null
    fi
  done
else
  log "volumes kept -- pass --clean to drop content and objects too"
fi
