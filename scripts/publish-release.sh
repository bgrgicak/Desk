#!/usr/bin/env bash
# scripts/publish-release.sh
#
# Interactive release script for Roomy.
#
# Flow:
#   1. Pre-flight checks (Node 23, clean tree, on trunk, gh + npm + docker logged in).
#   2. Pick a new version (next alpha, next minor+alpha.0, or custom).
#   3. Bump every PUBLIC workspace's package.json to that version.
#   4. Install + build + npm pack smoke test.
#   5. Final confirm — last chance to bail.
#   6. git commit "chore(release): vX".
#   7. npm publish --workspaces --access public  (uses local npm login; publishConfig.tag=latest).
#   8. Build + push the multi-platform sandbox Docker image to Docker Hub at
#      <repo>:<version> + <repo>:latest (uses `docker login`).
#   9. git tag vX, push branch + tag. The tag push triggers
#      .github/workflows/desktop-release.yml, which builds the macOS DMG
#      on a macos-latest runner and uploads it to the GH Release.
#  10. (Optional) gh run watch the desktop-release workflow.
#
# Why npm + Docker run locally and Desktop runs in CI:
#   - npm publish + docker push both work fine from a dev machine with a
#     normal interactive login — no secret-juggling.
#   - The macOS DMG can ONLY be built on macOS (Apple toolchain). The dev
#     box is Linux, so desktop fans out to a macos-latest runner via the
#     tag push.
#
# Re-run safety: if npm publish or docker push fails partway, the version
# bump commit is still there but the git tag has NOT been created or
# pushed, so the desktop workflow won't fire for a half-published release.
# You can fix the underlying issue, bump to a fresh version, and re-run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Workspaces that get published to npm. Keep in sync with the `npm publish
# --workspaces` set — that command skips `"private": true` packages, but we
# bump versions explicitly here, so the list must be hand-maintained.
PUBLIC_WORKSPACES=(
  "packages/app"
  "packages/cli"
  "packages/ui"
  "packages/server/api"
  "packages/server/db"
  "packages/server/runtime"
  "packages/server/scheduler"
  "packages/server/shared"
  "packages/server/storage"
  "packages/apps"
  "packages/app-scaffold"
  "packages/desktop"
  "packages/server/setup"
  "packages/server/sandbox-cli"
  "packages/apps/chat-cards.app"
  "packages/apps/chat-forms.app"
)

# ---------- helpers ----------

c_reset=$'\033[0m'
c_bold=$'\033[1m'
c_dim=$'\033[2m'
c_green=$'\033[32m'
c_yellow=$'\033[33m'
c_red=$'\033[31m'
c_cyan=$'\033[36m'

say()  { printf "%s==>%s %s\n" "$c_cyan" "$c_reset" "$*"; }
ok()   { printf "%s✓%s  %s\n" "$c_green" "$c_reset" "$*"; }
warn() { printf "%s!%s  %s\n" "$c_yellow" "$c_reset" "$*"; }
die()  { printf "%s✗%s  %s\n" "$c_red" "$c_reset" "$*" >&2; exit 1; }
hr()   { printf "%s%s%s\n" "$c_dim" "──────────────────────────────────────────────" "$c_reset"; }

ask() {
  # ask "Prompt" [default]
  local prompt="$1" default="${2-}" reply
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " reply || true
    printf "%s" "${reply:-$default}"
  else
    read -r -p "$prompt: " reply || true
    printf "%s" "$reply"
  fi
}

confirm() {
  # confirm "Question"  -> 0 yes, 1 no
  local prompt="$1" reply
  read -r -p "$prompt [y/N] " reply || true
  case "${reply:-}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# Read a value from a package.json via node (handles spacing/keys cleanly).
pkg_get() {
  local file="$1" key="$2"
  node -e "const p=JSON.parse(require('fs').readFileSync('$file','utf8')); const v=p['$key']; process.stdout.write(v===undefined||v===null?'':String(v))"
}

# Write package.json with a new version. Preserves key order and trailing newline.
pkg_set_version() {
  local file="$1" version="$2"
  node -e "
    const fs=require('fs');
    const p=JSON.parse(fs.readFileSync('$file','utf8'));
    p.version='$version';
    fs.writeFileSync('$file', JSON.stringify(p, null, 2)+'\n');
  "
}

# Pin every `@roomy-ai/*` entry in this package.json's dependency blocks to
# the exact released version. Without this, deps like
# `"@roomy-ai/app": ">=0.1.0-0"` resolve via npm's normal range algorithm,
# which prefers the version pointed at by the `latest` dist-tag over the
# higher prerelease — meaning a freshly installed @roomy-ai/cli@<new>
# would pull `@roomy-ai/app@latest` (an OLD alpha) for every transitive
# dep. Pinning to the exact version sidesteps the whole dist-tag dance.
pkg_pin_roomy_deps() {
  local file="$1" version="$2"
  node -e "
    const fs=require('fs');
    const p=JSON.parse(fs.readFileSync('$file','utf8'));
    const blocks=['dependencies','devDependencies','peerDependencies','optionalDependencies'];
    let changed=false;
    for (const b of blocks) {
      const deps = p[b];
      if (!deps) continue;
      for (const k of Object.keys(deps)) {
        if (k.startsWith('@roomy-ai/') && deps[k] !== '$version') {
          deps[k] = '$version';
          changed = true;
        }
      }
    }
    if (changed) fs.writeFileSync('$file', JSON.stringify(p, null, 2)+'\n');
  "
}

# ---------- step 0: pre-flight ----------

say "Roomy release script"
hr

# Node version. preinstall in package.json enforces this too, but we want a
# clean error before doing any work.
node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$node_major" != "23" ]; then
  die "Node 23 required (found $(node --version)). Run \`nvm use\` (the repo has .nvmrc=23)."
fi
ok "Node $(node --version)"

# git state
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "trunk" ]; then
  warn "You're on branch '$branch', not trunk."
  confirm "Continue anyway?" || die "Aborted."
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short
  die "Working tree is dirty. Commit or stash before releasing."
fi

if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  warn "There are untracked files."
  git status --short
  confirm "Continue anyway?" || die "Aborted."
fi
ok "Git tree clean, branch=$branch"

# gh CLI — required, because electron-builder needs a GitHub token to
# upload installers to the Release, and we also use it to watch the
# Docker workflow.
command -v gh >/dev/null 2>&1 || die "gh CLI not installed (https://cli.github.com/). Required for desktop release upload."
gh auth status >/dev/null 2>&1 || die "gh CLI not authenticated. Run 'gh auth login' first."
ok "gh CLI authenticated"

# npm login
say "Checking npm authentication..."
if ! npm whoami >/dev/null 2>&1; then
  warn "Not logged in to npm."
  echo "Running \`npm login\` — follow the browser prompt..."
  npm login
  npm whoami >/dev/null 2>&1 || die "npm login failed."
fi
npm_user="$(npm whoami)"
ok "npm logged in as: $npm_user"

# Confirm we can actually publish under the @roomy-ai scope. npm doesn't
# give us a clean "do I have publish rights" probe; the closest thing is
# `npm access list packages` against the scope.
if ! npm access list packages @roomy-ai >/dev/null 2>&1; then
  warn "Couldn't read @roomy-ai scope as $npm_user. You may not have publish rights."
  confirm "Continue anyway?" || die "Aborted. Get added to the @roomy-ai org first."
fi

# Docker — installed, daemon up, logged in to Docker Hub.
command -v docker >/dev/null 2>&1 || die "docker is not installed."
docker info >/dev/null 2>&1 || die "Docker daemon not reachable. Start docker first."
docker buildx version >/dev/null 2>&1 || die "docker buildx is required for multi-platform sandbox image publishing."
say "Checking Docker Hub authentication..."
# docker info shows Username when credentials are stored in config.json.
# On macOS Docker Desktop, creds go into the OS keychain, so docker info
# never shows a Username — fall back to the credential helper.
_docker_user_from_helper() {
  command -v docker-credential-osxkeychain >/dev/null 2>&1 || return 0
  printf 'https://index.docker.io/v1/\n' \
    | docker-credential-osxkeychain get 2>/dev/null \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).Username||'')}catch(e){}})" 2>/dev/null \
    || true
}
docker_user="$(docker info 2>/dev/null | awk -F': ' '/^[[:space:]]*Username:/ {print $2; exit}')"
[ -n "$docker_user" ] || docker_user="$(_docker_user_from_helper)"
if [ -z "$docker_user" ]; then
  warn "Not logged in to Docker Hub."
  echo "Running \`docker login\` — enter your Docker Hub credentials..."
  docker login || die "docker login failed."
  docker_user="$(_docker_user_from_helper)"
  # If the helper still can't retrieve it the login still succeeded (exit 0 above).
  [ -n "$docker_user" ] || docker_user="authenticated"
fi
ok "Docker logged in as: $docker_user"

# Full Docker Hub repository (namespace/repo, without tag). Default is
# `bgrgicak/roomy-ai` to match the default image repository in
# @roomy-ai/cli's cmdStartPublished. Override via ROOMY_DOCKER_REPO if
# you publish elsewhere — but then update that CLI default too or
# `npx @roomy-ai/cli` users will pull the wrong image.
DOCKER_REPO="${ROOMY_DOCKER_REPO:-$(ask "Docker Hub repository (namespace/repo)" "bgrgicak/roomy-ai")}"
[ -n "$DOCKER_REPO" ] || die "No Docker repo given."
if [ "$DOCKER_REPO" != "bgrgicak/roomy-ai" ]; then
  warn "Repo $DOCKER_REPO doesn't match the default image repository in"
  warn "packages/cli/src/roomy.mjs and packages/desktop/src/server-env.ts."
  warn 'Update those defaults too, or published users will pull the wrong image.'
  confirm "Continue?" || die "Aborted."
fi
ok "Will push image as: ${c_bold}${DOCKER_REPO}${c_reset}"
DOCKER_PLATFORMS="${ROOMY_DOCKER_PLATFORMS:-linux/amd64,linux/arm64}"
ok "Sandbox image platforms: ${DOCKER_PLATFORMS}"

hr

# ---------- step 1: pick a version ----------

CLI_PKG="packages/cli/package.json"
current="$(pkg_get "$CLI_PKG" version)"
say "Current version (from $CLI_PKG): ${c_bold}$current${c_reset}"

# Suggest next patch, next minor, and next major.
next_patch="$(node -e "
  const v='$current';
  const m=v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if(!m){ process.exit(0); }
  const [_, M, m_, p] = m;
  process.stdout.write(\`\${M}.\${m_}.\${Number(p)+1}\`);
")"
next_minor="$(node -e "
  const v='$current';
  const m=v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if(!m){ process.exit(0); }
  const [_, M, m_] = m;
  process.stdout.write(\`\${M}.\${Number(m_)+1}.0\`);
")"

echo
echo "Pick a version:"
[ -n "$next_patch" ] && echo "  1) next patch   → $next_patch"
[ -n "$next_minor" ] && echo "  2) bump minor   → $next_minor"
echo "  3) custom"
echo

choice="$(ask "Choice" "1")"
case "$choice" in
  1) NEW_VERSION="$next_patch" ;;
  2) NEW_VERSION="$next_minor" ;;
  3) NEW_VERSION="$(ask "Enter version (no leading v)")" ;;
  *) die "Invalid choice." ;;
esac

[ -n "$NEW_VERSION" ] || die "No version selected."

# Sanity-check semver shape so we don't end up tagging "v "
if ! printf "%s" "$NEW_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  die "Version '$NEW_VERSION' doesn't look like semver."
fi

TAG="v$NEW_VERSION"

# Refuse to overwrite an existing tag.
if git rev-parse "refs/tags/$TAG" >/dev/null 2>&1; then
  die "Tag $TAG already exists locally."
fi
if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -qF "$TAG"; then
  die "Tag $TAG already exists on origin."
fi

ok "Releasing as ${c_bold}$NEW_VERSION${c_reset} (tag $TAG)"
hr

# ---------- step 2: bump versions ----------

say "Bumping versions + pinning inter-package deps in ${#PUBLIC_WORKSPACES[@]} public workspaces..."
for ws in "${PUBLIC_WORKSPACES[@]}"; do
  pkg="$ws/package.json"
  [ -f "$pkg" ] || die "Missing $pkg"
  pkg_set_version "$pkg" "$NEW_VERSION"
  pkg_pin_roomy_deps "$pkg" "$NEW_VERSION"
  printf "  %s → %s\n" "$(pkg_get "$pkg" name)" "$NEW_VERSION"
done
ok "Versions bumped + @roomy-ai/* deps pinned to $NEW_VERSION."

hr

# ---------- step 3: build + smoke test ----------

# `npm install` instead of `npm ci` here — we just rewrote dep ranges in
# every workspace's package.json, so the existing lockfile is out of sync.
# `npm install` reconciles the lockfile to the new ranges; `npm ci` would
# refuse to start.
say "Installing dependencies + refreshing lockfile..."
npm install

say "Cleaning previous build artifacts..."
find . -name dist -type d -not -path '*/node_modules/*' -exec rm -rf '{}' + 2>/dev/null || true

say "Building all packages..."
npm run build:packages

say "Smoke test: npm pack --dry-run on public workspaces..."
# Pack each public workspace one by one. Mirrors the explicit -w list
# we use for publish, so the dry-run reflects what real `npm publish`
# would attempt — no surprise EPRIVATE failures from private workspaces.
PACK_LOG="$(mktemp)"
trap 'rm -f "$PACK_LOG"' EXIT
pack_args=()
for ws in "${PUBLIC_WORKSPACES[@]}"; do
  pack_args+=("-w" "$ws")
done
npm pack "${pack_args[@]}" --dry-run 2>&1 | tee "$PACK_LOG"
grep -q "Tarball Contents" "$PACK_LOG" || die "npm pack produced no tarballs."

ok "Build + pack smoke test passed."
hr

# ---------- step 4: final confirmation ----------

echo "About to:"
echo "  1. git commit  →  chore(release): $TAG"
echo "  2. npm publish →  $NEW_VERSION (dist-tag: latest)"
echo "     packages:"
for ws in "${PUBLIC_WORKSPACES[@]}"; do
  echo "       - $(pkg_get "$ws/package.json" name)"
done
echo "  3. docker build + push:"
echo "       ${DOCKER_REPO}:${NEW_VERSION}"
echo "       ${DOCKER_REPO}:latest"
echo "       platforms: ${DOCKER_PLATFORMS}"
echo "  4. git tag $TAG and push trunk + $TAG to origin"
echo "     → triggers .github/workflows/desktop-release.yml on a macos-latest"
echo "       runner, which builds + uploads the macOS DMG to the GH Release."
echo
confirm "Proceed?" || die "Aborted. Local version bumps remain; revert with: git checkout -- packages/"

hr

# ---------- step 5: commit ----------

say "Committing version bump..."
_bump_add_args=()
for ws in "${PUBLIC_WORKSPACES[@]}"; do
  _bump_add_args+=("$ws/package.json")
done
git add "${_bump_add_args[@]}" package-lock.json
git commit -m "chore(release): $TAG"
ok "Committed."

# ---------- step 6: publish to npm ----------

say "Publishing to npm..."
# Explicitly publish each public workspace via -w. Earlier versions of
# npm silently skipped private workspaces under `--workspaces`; npm 11
# errors with EPRIVATE if any private workspace is in the set, even if
# the others would publish fine. Building the -w list from
# PUBLIC_WORKSPACES avoids that entirely.
#
# --access public for the scoped @roomy-ai/* packages.
# publishConfig.tag=latest in each package.json controls the dist-tag,
# so `npm install @roomy-ai/cli` resolves to the latest stable release.
publish_args=()
for ws in "${PUBLIC_WORKSPACES[@]}"; do
  publish_args+=("-w" "$ws")
done
if ! npm publish "${publish_args[@]}" --access public; then
  warn "npm publish failed. The version bump commit is still in your local history."
  warn "Inspect the failure, then either retry or 'git reset --hard HEAD~1' to discard."
  die "Publish aborted."
fi
ok "npm publish complete."

# ---------- step 7: docker build + push ----------

IMAGE_VERSION_TAG="${DOCKER_REPO}:${NEW_VERSION}"
IMAGE_LATEST_TAG="${DOCKER_REPO}:latest"

say "Building and pushing sandbox Docker image for ${DOCKER_PLATFORMS} (this can take a few minutes)..."
# Build each platform separately, then assemble the public multi-platform
# tags. A single `docker buildx build --platform a,b --push` runs the
# platform builds concurrently; on Apple Silicon/Colima the emulated amd64
# Playwright install has been observed to segfault under that load. Serial
# per-platform pushes keep the released tags multi-arch without overlapping
# the expensive browser dependency installation layers.
IFS=',' read -r -a _docker_platforms <<< "$DOCKER_PLATFORMS"
_manifest_sources=()
for platform in "${_docker_platforms[@]}"; do
  platform="${platform#"${platform%%[![:space:]]*}"}"
  platform="${platform%"${platform##*[![:space:]]}"}"
  [ -n "$platform" ] || continue
  platform_suffix="${platform#linux/}"
  platform_suffix="${platform_suffix//\//-}"
  platform_tag="${DOCKER_REPO}:${NEW_VERSION}-${platform_suffix}"
  say "Building and pushing sandbox Docker image for ${platform} as ${platform_tag}..."
  if ! docker buildx build \
      --platform "$platform" \
      --push \
      -f packages/server/runtime/Dockerfile.sandbox \
      -t "$platform_tag" \
      .; then
    warn "docker build failed. npm packages are already out. Fix the build and re-run:"
    warn "    docker buildx build --platform $platform --push \\"
    warn "      -f packages/server/runtime/Dockerfile.sandbox \\"
    warn "      -t $platform_tag ."
    die "Docker build aborted."
  fi
  _manifest_sources+=("$platform_tag")
done

if [ "${#_manifest_sources[@]}" -eq 0 ]; then
  die "No Docker platforms were configured."
fi

say "Publishing multi-platform manifests for ${IMAGE_VERSION_TAG} and ${IMAGE_LATEST_TAG}..."
if ! docker buildx imagetools create \
    -t "$IMAGE_VERSION_TAG" \
    -t "$IMAGE_LATEST_TAG" \
    "${_manifest_sources[@]}"; then
  warn "docker manifest creation failed. Per-platform images were pushed:"
  for source in "${_manifest_sources[@]}"; do
    warn "    $source"
  done
  warn "Re-run:"
  warn "    docker buildx imagetools create -t $IMAGE_VERSION_TAG -t $IMAGE_LATEST_TAG ${_manifest_sources[*]}"
  die "Docker manifest creation aborted."
fi
ok "Sandbox image pushed."

# ---------- step 8: tag + push ----------

say "Tagging $TAG..."
git tag -a "$TAG" -m "Release $TAG"

say "Pushing trunk and $TAG to origin..."
git push origin "$branch"
git push origin "$TAG"
ok "Pushed. The desktop release workflow has been triggered by the tag push."

# ---------- step 9: monitor desktop workflow ----------

hr
echo "What just happened:"
echo "  • Published to npm (dist-tag latest):"
for ws in "${PUBLIC_WORKSPACES[@]}"; do
  name="$(pkg_get "$ws/package.json" name)"
  echo "    https://www.npmjs.com/package/$name/v/$NEW_VERSION"
done
echo "  • Pushed Docker image:"
echo "      https://hub.docker.com/r/${DOCKER_REPO}/tags"
echo "      ${IMAGE_VERSION_TAG}"
echo "      ${IMAGE_LATEST_TAG}"
echo "  • Pushed git tag $TAG (https://github.com/bgrgicak/Roomy/releases/tag/$TAG)"
echo "  • Desktop workflow (macOS DMG):"
echo "      https://github.com/bgrgicak/Roomy/actions/workflows/desktop-release.yml"
echo

if confirm "Stream the desktop release workflow run here?"; then
  # gh needs a moment for the dispatched run to register.
  sleep 4
  run_id="$(gh run list --workflow=desktop-release.yml --limit=1 --json databaseId --jq '.[0].databaseId' || true)"
  if [ -n "$run_id" ]; then
    gh run watch "$run_id" --exit-status || warn "Desktop workflow failed — check the link above."
  else
    warn "Couldn't find the dispatched run yet. Check the link above."
  fi
fi

ok "Release $TAG complete."
