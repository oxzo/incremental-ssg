# Shared configuration for the local stack.
#
# The credentials below are fixtures, not secrets. They exist so that a
# throwaway container is reachable from the host, they are committed on purpose
# so the stack is reproducible without a setup ritual, and nothing off this box
# can reach the ports they guard. Do not reuse this file's shape for anything
# that talks to a real service -- a real one takes its credentials from the
# environment and this file is the reason that distinction has to stay visible.

# --- Directus: the CMS end ---------------------------------------------------
export ISSG_DIRECTUS_PORT="${ISSG_DIRECTUS_PORT:-8055}"
export ISSG_DIRECTUS_URL="${ISSG_DIRECTUS_URL:-http://127.0.0.1:${ISSG_DIRECTUS_PORT}}"
# example.com rather than something like admin@local.test: Directus validates the
# address at bootstrap and rejects a .test TLD, which fails the container *after*
# every migration has run, so the symptom is a healthy-looking log and no login.
export ISSG_DIRECTUS_EMAIL="${ISSG_DIRECTUS_EMAIL:-admin@example.com}"
export ISSG_DIRECTUS_PASSWORD="${ISSG_DIRECTUS_PASSWORD:-local-fixture-not-a-secret}"
export ISSG_DIRECTUS_IMAGE="docker.io/directus/directus:latest"
export ISSG_DIRECTUS_NAME="issg-directus"
export ISSG_DIRECTUS_VOLUME="issg-directus-data"

# Directus refuses to boot without these two. Fixed rather than random so that a
# restart does not invalidate every session token from the previous run.
export ISSG_DIRECTUS_KEY="0000d0d0-0000-4000-a000-000000000001"
export ISSG_DIRECTUS_SECRET="0000d0d0-0000-4000-a000-000000000002"

# --- MinIO: the deploy end ---------------------------------------------------
export ISSG_S3_PORT="${ISSG_S3_PORT:-9000}"
export ISSG_S3_CONSOLE_PORT="${ISSG_S3_CONSOLE_PORT:-9001}"
export ISSG_S3_ENDPOINT="${ISSG_S3_ENDPOINT:-http://127.0.0.1:${ISSG_S3_PORT}}"
export ISSG_S3_ACCESS_KEY="${ISSG_S3_ACCESS_KEY:-issglocal}"
export ISSG_S3_SECRET_KEY="${ISSG_S3_SECRET_KEY:-issglocal-fixture}"
export ISSG_S3_BUCKET="${ISSG_S3_BUCKET:-issg-site}"
export ISSG_S3_REGION="${ISSG_S3_REGION:-us-east-1}"
export ISSG_S3_IMAGE="docker.io/minio/minio:latest"
export ISSG_S3_NAME="issg-minio"
export ISSG_S3_VOLUME="issg-minio-data"

# Named volumes rather than bind mounts, deliberately: rootless podman maps the
# container's uid into a subuid range, so a host directory written by the
# container is not owned by the host user, and SELinux relabelling is a second
# way for the same mount to fail. A named volume has neither problem.
