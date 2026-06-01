#!/usr/bin/env bash
# Build (or rebuild) the roomy/sandbox:v1 docker image when its inputs
# have changed, leaving it alone otherwise. Called by dev.sh.
#
# We tag the built image with a `roomy.fingerprint` label whose value
# is the hash returned by sandbox-fingerprint.sh. On the next run we
# read that label back via `docker inspect` and skip the rebuild
# if it still matches the current sources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

IMAGE="${ROOMY_SANDBOX_IMAGE:-roomy/sandbox:v1}"
FINGERPRINT="$("${SCRIPT_DIR}/sandbox-fingerprint.sh" "${REPO_ROOT}")"

# What's baked into the existing image, if any. Empty string if the
# image is missing OR the label isn't present.
existing_label=""
if command -v docker >/dev/null 2>&1; then
  existing_label="$(docker inspect "${IMAGE}" \
    --format '{{ index .Config.Labels "roomy.fingerprint" }}' 2>/dev/null || true)"
fi

if [ "${existing_label}" = "${FINGERPRINT}" ] && [ -n "${existing_label}" ]; then
  # Already up-to-date — stay silent so dev.sh's start sequence is quiet.
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  if [ "${ROOMY_SANDBOX_STRICT:-}" = "1" ]; then
    echo "ERROR: sandbox image: docker not found; cannot build required image ${IMAGE}." >&2
    exit 1
  fi
  echo "==> sandbox image: docker not found; skipping rebuild (image=${IMAGE})." >&2
  exit 0
fi

echo "==> sandbox image: rebuilding ${IMAGE} (fingerprint ${FINGERPRINT:0:12}…)"

# Fresh sandbox-cli bundle — the docker build COPYs from the repo, so
# we need the bundle to be current on disk first.
(cd "${REPO_ROOT}" && npm run build --workspace=@roomy-ai/sandbox-cli)

(cd "${REPO_ROOT}" && docker build \
  --label "roomy.fingerprint=${FINGERPRINT}" \
  -f packages/server/runtime/Dockerfile.sandbox \
  -t "${IMAGE}" .)
