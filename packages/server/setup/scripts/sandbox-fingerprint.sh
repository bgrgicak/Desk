#!/usr/bin/env bash
# Print a stable hash over the build-relevant inputs that determine the
# sandbox docker image: sandbox-cli, the Dockerfile, UI package sources,
# and app-scaffold package sources.
#
# Used by ensure-sandbox-image.sh to decide whether dev.sh needs to
# rebuild the local roomy/sandbox:v1 image.
set -euo pipefail

# Repo root may be passed in (so tests can point us at a fixture) or
# inferred from the script's own location.
REPO_ROOT="${1:-}"
if [ -z "$REPO_ROOT" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
fi

# Hash a list of files to a single sha256. Each line is "<sha256>  <path>"
# in sorted order so the result is stable across machines.
_hash_files() {
  # On macOS sha256sum lives behind coreutils; fall back to `shasum -a 256`.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@" | sort | sha256sum | awk '{print $1}'
  else
    shasum -a 256 "$@" | sort | shasum -a 256 | awk '{print $1}'
  fi
}

# Collect the files in scope. Use a NUL-delimited list so paths with
# spaces survive, then convert to a regular array.
files=()
while IFS= read -r -d '' f; do
  files+=("$f")
done < <(
  {
    if [ -d "${REPO_ROOT}/packages/server/sandbox-cli" ]; then
      find "${REPO_ROOT}/packages/server/sandbox-cli" \
        -type d \( -name node_modules -o -name dist -o -name coverage \) -prune -o \
        -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.json' -o -name '*.mjs' \) -print0
    fi
    if [ -f "${REPO_ROOT}/packages/server/runtime/Dockerfile.sandbox" ]; then
      printf '%s\0' "${REPO_ROOT}/packages/server/runtime/Dockerfile.sandbox"
    fi
    if [ -d "${REPO_ROOT}/packages/ui" ]; then
      find "${REPO_ROOT}/packages/ui" \
        -type d \( -name node_modules -o -name dist -o -name coverage \) -prune -o \
        -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.json' -o -name '*.mjs' -o -name '*.css' \) -print0
    fi
    if [ -d "${REPO_ROOT}/packages/app-scaffold" ]; then
      find "${REPO_ROOT}/packages/app-scaffold" \
        -type d \( -name node_modules -o -name dist -o -name coverage \) -prune -o \
        -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.json' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' \) -print0
    fi
  }
)

if [ "${#files[@]}" -eq 0 ]; then
  echo "ERROR: sandbox-fingerprint found no input files under ${REPO_ROOT}" >&2
  exit 1
fi

_hash_files "${files[@]}"
