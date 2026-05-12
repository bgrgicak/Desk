#!/usr/bin/env bash
# Build (or rebuild) the desk/sandbox:v1 docker image when its inputs
# have changed, leaving it alone otherwise. Called by dev.sh.
#
# We tag the built image with a `desk.fingerprint` label whose value
# is the hash returned by sandbox-fingerprint.sh. On the next run we
# read that label back via `docker inspect` and skip the rebuild
# if it still matches the current sources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

IMAGE="${DESK_SANDBOX_IMAGE:-desk/sandbox:v1}"
FINGERPRINT="$("${SCRIPT_DIR}/sandbox-fingerprint.sh" "${REPO_ROOT}")"

# What's baked into the existing image, if any. Empty string if the
# image is missing OR the label isn't present.
existing_label=""
if command -v docker >/dev/null 2>&1; then
  existing_label="$(docker inspect "${IMAGE}" \
    --format '{{ index .Config.Labels "desk.fingerprint" }}' 2>/dev/null || true)"
fi

if [ "${existing_label}" = "${FINGERPRINT}" ] && [ -n "${existing_label}" ]; then
  # Already up-to-date — stay silent so dev.sh's start sequence is quiet.
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "==> sandbox image: docker not found; skipping rebuild (image=${IMAGE})." >&2
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "==> sandbox image: docker daemon is not reachable; skipping rebuild (image=${IMAGE})." >&2
  exit 0
fi

# `docker info` can succeed in nested dev containers even when the daemon
# cannot start build/run containers because the cgroup v2 mount is read-only.
# Without this guard, `npm run dev` spends time building sandbox-cli and then
# fails with Docker's opaque:
#   unable to apply cgroup configuration: mkdir /sys/fs/cgroup/docker: read-only file system
# The app can still boot with an existing/published image or with sandbox tests
# skipped; surface the environment problem early and keep dev startup moving.
if docker info --format '{{.CgroupDriver}} {{.CgroupVersion}}' 2>/dev/null | grep -qx 'cgroupfs 2'; then
  if awk '
    {
      sep=0
      for (i=1; i<=NF; i++) if ($i == "-") { sep=i; break }
      if (sep && $5 == "/sys/fs/cgroup" && $6 ~ /(^|,)ro(,|$)/ && $(sep+1) == "cgroup2" && $(sep+2) == "cgroup") found=1
    }
    END { exit found ? 0 : 1 }
  ' /proc/self/mountinfo; then
    echo "==> sandbox image: docker is available, but cgroup v2 is mounted read-only; skipping rebuild." >&2
    echo "    Relaunch this dev container with a writable cgroup mount or use a host Docker socket to run sandbox E2E." >&2
    exit 0
  fi
fi

echo "==> sandbox image: rebuilding ${IMAGE} (fingerprint ${FINGERPRINT:0:12}…)"

# Fresh sandbox-cli bundle — the docker build COPYs from the repo, so
# we need the bundle to be current on disk first.
(cd "${REPO_ROOT}" && npm run build --workspace=@agent-desk/sandbox-cli)

(cd "${REPO_ROOT}" && docker build \
  --label "desk.fingerprint=${FINGERPRINT}" \
  -f packages/server/runtime/Dockerfile.sandbox \
  -t "${IMAGE}" .)
