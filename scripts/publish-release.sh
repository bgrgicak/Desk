#!/usr/bin/env bash
# scripts/publish-release.sh
#
# Interactive release script for Roomy.
#
# Flow:
#   1. Pre-flight checks (Node 23, clean tree, on trunk, gh + npm logged in).
#   2. Pick a new version (next alpha, next minor+alpha.0, or custom).
#   3. Bump every PUBLIC workspace + @roomy-ai/desktop's package.json to that version.
#   4. Install + build + npm pack smoke test.
#   5. Final confirm — last chance to bail.
#   6. git commit "chore(release): vX".
#   7. npm publish --workspaces --access public  (uses local npm login; publishConfig.tag=alpha).
#   8. git tag vX, push branch + tag. The tag push triggers
#      .github/workflows/release-sandbox-image.yml on CI, which builds + pushes
#      the sandbox Docker image to Docker Hub.
#   9. Build desktop locally (electron-builder for the current host platform)
#      and publish installers to the GitHub Release for tag vX via
#      `electron-builder --publish always` (uses `gh auth token`).
#  10. (Optional) gh run watch the sandbox-image workflow.
#
# Why npm + desktop run locally and Docker runs in CI:
#   - npm publish is fast (a few MB per package) and the local login flow is
#     simpler than juggling NPM_TOKEN secrets.
#   - The sandbox Docker image is ~650 MiB multi-arch with Playwright/Firefox
#     pre-installed. Existing GitHub Action builds it on GH runners.
#   - Desktop installers must match the host: macOS DMG can only be built on
#     macOS, Linux AppImage/deb only on Linux. Building locally means whatever
#     host you run this from is what gets shipped — if you want both mac and
#     linux installers in the same release, re-run the upload step from the
#     other host (electron-builder will add to the existing GH Release).
#
# Re-run safety: if npm publish fails partway, the local version bump commit
# is still there but the git tag has NOT been created or pushed, so the
# Docker workflow won't fire for a half-published release. You can fix the
# underlying issue, bump to a fresh version, and re-run.

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
)

# Private but version-tracked alongside the public set so the GitHub
# Release created by electron-builder lines up with the npm version.
DESKTOP_PKG_DIR="packages/desktop"

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

hr

# ---------- step 1: pick a version ----------

CLI_PKG="packages/cli/package.json"
current="$(pkg_get "$CLI_PKG" version)"
say "Current version (from $CLI_PKG): ${c_bold}$current${c_reset}"

# Suggest next alpha (bump trailing .N), and next minor + alpha.0.
next_alpha="$(node -e "
  const v='$current';
  const m=v.match(/^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)\$/);
  if(!m){ process.exit(0); }
  const [_, M, m_, p, n] = m;
  process.stdout.write(\`\${M}.\${m_}.\${p}-alpha.\${Number(n)+1}\`);
")"
next_minor="$(node -e "
  const v='$current';
  const m=v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if(!m){ process.exit(0); }
  const [_, M, m_] = m;
  process.stdout.write(\`\${M}.\${Number(m_)+1}.0-alpha.0\`);
")"

echo
echo "Pick a version:"
[ -n "$next_alpha" ] && echo "  1) next alpha   → $next_alpha"
[ -n "$next_minor" ] && echo "  2) bump minor   → $next_minor"
echo "  3) custom"
echo

choice="$(ask "Choice" "1")"
case "$choice" in
  1) NEW_VERSION="$next_alpha" ;;
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
if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "$TAG"; then
  die "Tag $TAG already exists on origin."
fi

ok "Releasing as ${c_bold}$NEW_VERSION${c_reset} (tag $TAG)"
hr

# ---------- step 2: bump versions ----------

say "Bumping versions in ${#PUBLIC_WORKSPACES[@]} public workspaces + desktop..."
for ws in "${PUBLIC_WORKSPACES[@]}" "$DESKTOP_PKG_DIR"; do
  pkg="$ws/package.json"
  [ -f "$pkg" ] || die "Missing $pkg"
  pkg_set_version "$pkg" "$NEW_VERSION"
  printf "  %s → %s\n" "$(pkg_get "$pkg" name)" "$NEW_VERSION"
done
ok "Versions bumped."
hr

# ---------- step 3: build + smoke test ----------

say "Installing dependencies (npm ci)..."
npm ci

say "Building all packages..."
npm run build:packages

say "Smoke test: npm pack --workspaces --dry-run..."
# Mirrors the publish.yml smoke check: pack every workspace, fail if nothing
# was produced. We pipe through tee so the output is visible if it errors.
PACK_LOG="$(mktemp)"
trap 'rm -f "$PACK_LOG"' EXIT
npm pack --workspaces --dry-run 2>&1 | tee "$PACK_LOG"
grep -q "Tarball Contents" "$PACK_LOG" || die "npm pack produced no tarballs."

ok "Build + pack smoke test passed."
hr

# ---------- step 4: final confirmation ----------

echo "About to:"
echo "  1. git commit  →  chore(release): $TAG"
echo "  2. npm publish →  $NEW_VERSION (dist-tag: alpha)"
echo "     packages:"
for ws in "${PUBLIC_WORKSPACES[@]}"; do
  echo "       - $(pkg_get "$ws/package.json" name)"
done
echo "  3. git tag $TAG and push trunk + $TAG to origin"
echo "     → triggers .github/workflows/release-sandbox-image.yml on CI"
echo "       (builds + pushes the sandbox image to Docker Hub)"
echo "  4. Build the desktop app for $(uname -s) locally and upload installers"
echo "     to the GitHub Release for $TAG via electron-builder."
echo
confirm "Proceed?" || die "Aborted. Local version bumps remain; revert with: git checkout -- packages/"

hr

# ---------- step 5: commit ----------

say "Committing version bump..."
git add packages/*/package.json packages/server/*/package.json package-lock.json
git commit -m "chore(release): $TAG"
ok "Committed."

# The desktop install was just a `npm ci` at the root — make sure the
# nested `packages/desktop` workspace has its own modules installed (the
# postinstall electron-rebuild step and electron-builder both expect them).
say "Installing desktop dependencies..."
( cd "$DESKTOP_PKG_DIR" && npm ci )

# ---------- step 6: publish to npm ----------

say "Publishing to npm..."
# --access public for the scoped @roomy-ai/* packages.
# publishConfig.tag=alpha in each package.json controls the dist-tag, so
# `npm install @roomy-ai/cli` resolves to "alpha" until we cut a stable.
if ! npm publish --workspaces --access public; then
  warn "npm publish failed. The version bump commit is still in your local history."
  warn "Inspect the failure, then either retry or 'git reset --hard HEAD~1' to discard."
  die "Publish aborted."
fi
ok "npm publish complete."

# ---------- step 7: tag + push ----------

say "Tagging $TAG..."
git tag -a "$TAG" -m "Release $TAG"

say "Pushing trunk and $TAG to origin..."
git push origin "$branch"
git push origin "$TAG"
ok "Pushed. The Docker release workflow has been triggered by the tag push."

# ---------- step 8: build desktop locally + publish to GH Release ----------

hr
say "Building desktop app + uploading installers to GH Release $TAG..."

# electron-builder reads GH_TOKEN from the env to upload to the GitHub
# Release. Sourced from `gh auth token` — same identity the rest of the
# script uses for git push, no extra config needed.
GH_TOKEN="$(gh auth token)"
export GH_TOKEN

# Stage the bundled server tree that electron-builder copies into
# Resources/server/. Builds the TS main process first (npm run dist
# also does this, but we want a clean error early if the desktop
# build is broken).
say "Building desktop main process..."
( cd "$DESKTOP_PKG_DIR" && npm run build )

say "Staging server bundle into $DESKTOP_PKG_DIR/build-server/..."
( cd "$DESKTOP_PKG_DIR" && npm run stage-server )

say "Running electron-builder for the current host platform..."
# --publish always: upload artifacts to the GH Release for this version.
# electron-builder creates the release if it doesn't exist yet, then
# attaches the platform-appropriate installers. Re-running from another
# host (e.g. macOS later) adds to the same release without recreating it.
if ! ( cd "$DESKTOP_PKG_DIR" && npx electron-builder --publish always ); then
  warn "electron-builder failed. npm + Docker release are already out;"
  warn "fix the desktop build and re-run this step manually:"
  warn "    cd $DESKTOP_PKG_DIR && GH_TOKEN=\$(gh auth token) npx electron-builder --publish always"
  exit 1
fi
ok "Desktop installers uploaded to the GH Release."

# ---------- step 9: monitor Docker workflow ----------

hr
echo "What just happened:"
echo "  • Published to npm (dist-tag alpha):"
for ws in "${PUBLIC_WORKSPACES[@]}"; do
  name="$(pkg_get "$ws/package.json" name)"
  echo "    https://www.npmjs.com/package/$name/v/$NEW_VERSION"
done
echo "  • Pushed git tag $TAG (https://github.com/bgrgicak/Desk/releases/tag/$TAG)"
echo "  • Docker workflow: https://github.com/bgrgicak/Desk/actions/workflows/release-sandbox-image.yml"
echo "  • Desktop installers uploaded to: https://github.com/bgrgicak/Desk/releases/tag/$TAG"
echo

if confirm "Stream the Docker release workflow run here?"; then
  # gh needs a moment for the dispatched run to register.
  sleep 4
  run_id="$(gh run list --workflow=release-sandbox-image.yml --limit=1 --json databaseId --jq '.[0].databaseId' || true)"
  if [ -n "$run_id" ]; then
    gh run watch "$run_id" --exit-status || warn "Docker workflow failed — check the link above."
  else
    warn "Couldn't find the dispatched run yet. Check the link above."
  fi
fi

ok "Release $TAG complete."
