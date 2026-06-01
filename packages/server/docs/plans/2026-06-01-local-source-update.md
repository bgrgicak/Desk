# Local source update project plan

## Objective

Support a pre-production Roomy service that updates from a local Roomy checkout
on the same server, without publishing npm packages first and without running
the dev server. The service must run production-built artifacts from
`ROOMY_HOME/current`, and failed builds must leave the previous release running.

## Current build model

- `npm run build` delegates to `npm run build:packages`.
- `build:packages` runs `build:server`, then `@roomy-ai/app-scaffold`, then
  `@roomy-ai/app`.
- `build:server` builds server packages in dependency order: shared, db,
  storage, ui, built-in apps, runtime, scheduler, api, sandbox-cli.
- Runtime build is `tsc && node scripts/copy-assets.mjs`; it copies prompts,
  skills, app scaffold guidance, persistence guidance, and built-in apps into
  `packages/server/runtime/dist`.
- The sandbox image is built from
  `packages/server/runtime/Dockerfile.sandbox`. It bakes the sandbox CLI, app
  scaffold template, MCP bridge extension, and sandbox entrypoint.

## Target user workflow

For a pre-production service:

```sh
ROOMY_HOME=/var/lib/roomy-preprod roomy service update --source /opt/roomy-dev
```

This means:

1. Treat `/opt/roomy-dev` as source input only.
2. Copy source into a staged release directory.
3. Run `npm ci`.
4. Run `npm run build`.
5. Build a release-specific sandbox image.
6. Verify required production outputs exist.
7. Move `ROOMY_HOME/current` to the new release only after all checks pass.
8. Restart the service.

## Safety requirements

- `--source` and `--tag` are mutually exclusive.
- Source root validation requires the Roomy workspace shape and
  `package-lock.json`.
- Source deploy uses `npm ci`, not `npm install`, so lockfile drift fails the
  deploy.
- Source deploy passes `ROOMY_SANDBOX_STRICT=1` to sandbox image setup.
- Strict sandbox setup fails when Docker is missing instead of silently
  continuing.
- `current` is not moved until the staged release has built API/app outputs and
  a sandbox image build has succeeded.
- Failed source builds do not restart the service.
- Switching back to npm update clears the saved source-release config.

## Implementation phases

### Phase 1: CLI source release path

- Add update argument parsing for npm mode vs source mode.
- Add source root validation.
- Add release ID generation from timestamp, process ID, and git SHA.
- Copy source into `ROOMY_HOME/releases/.staging-*`.
- Exclude `.git`, `node_modules`, `dist`, local env files, `.nx`, and coverage.
- Create a minimal `.git/hooks` directory in the staged copy so the root
  `prepare` script can run under `npm ci`.
- Run `npm ci`, `npm run build`, and strict sandbox image setup in the staged
  copy.
- Verify `packages/server/api/dist/main.js` and
  `packages/app/dist/index.html`.
- Rename staging to `ROOMY_HOME/releases/<releaseId>`.
- Move `ROOMY_HOME/current`.
- Write `ROOMY_HOME/.source-release.json`.
- Restart the service unless `--skip-restart` is passed.

### Phase 2: service start from current

- On published CLI startup, check for `ROOMY_HOME/.source-release.json`.
- Resolve `ROOMY_HOME/current`.
- Start `node current/packages/server/api/dist/main.js`.
- Set `ROOMY_SERVE_APP=1`.
- Set `ROOMY_APP_DIST=current/packages/app/dist`.
- Set `ROOMY_SANDBOX_IMAGE` from the source-release config unless explicitly
  overridden.

### Phase 3: strict sandbox build

- Add `ROOMY_SANDBOX_STRICT=1` support to `ensure-sandbox-image.sh`.
- In strict mode, missing Docker is a hard failure.
- Keep existing dev behavior unchanged: without strict mode, missing Docker
  remains a warning/skip so `npm run dev` can still start in non-Docker
  environments.

### Phase 4: fingerprint correctness

- Expand `sandbox-fingerprint.sh` to include every Dockerfile-copied runtime
  input that can affect behavior:
  - `packages/server/runtime/Dockerfile.sandbox`
  - `packages/server/runtime/sandbox-entrypoint.sh`
  - `packages/server/runtime/pi-extensions/roomy-mcp-bridge/**`
  - `packages/server/sandbox-cli/**`
  - `packages/ui/**`
  - `packages/app-scaffold/**`

### Phase 5: CI source-deploy smoke

Add a Docker-backed CI job that runs the real source deploy path:

```yaml
source-update-smoke:
  runs-on: ubuntu-24.04
  timeout-minutes: 45
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: "23"
        cache: npm
    - run: npm ci
    - name: Source update smoke
      run: |
        export ROOMY_HOME="$RUNNER_TEMP/roomy-source-home"
        node packages/cli/src/roomy.mjs update --source "$PWD" --skip-restart
        test -L "$ROOMY_HOME/current"
        test -f "$ROOMY_HOME/current/packages/server/api/dist/main.js"
        test -f "$ROOMY_HOME/current/packages/app/dist/index.html"
        IMAGE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.ROOMY_HOME+"/.source-release.json")).sandboxImage)')"
        docker image inspect "$IMAGE" > /dev/null
```

This job should be separate from unit tests because it runs a full build and a
Docker image build.

## Test plan

Fast local tests, no Docker:

```sh
npm -w @roomy-ai/cli run test -- test/roomy.test.mjs
npm -w @roomy-ai/runtime run test -- test/sandboxFingerprint.test.ts
npm -w @roomy-ai/cli run typecheck
npm -w @roomy-ai/runtime run typecheck
```

Docker-required local sandbox smoke:

```sh
ROOMY_SANDBOX_STRICT=1 \
ROOMY_SANDBOX_IMAGE=roomy/source:local-smoke \
bash packages/server/setup/scripts/ensure-sandbox-image.sh
```

Docker-required full source-deploy smoke:

```sh
export ROOMY_HOME="$(mktemp -d)"
node packages/cli/src/roomy.mjs update --source "$PWD" --skip-restart
test -L "$ROOMY_HOME/current"
test -f "$ROOMY_HOME/current/packages/server/api/dist/main.js"
test -f "$ROOMY_HOME/current/packages/app/dist/index.html"
cat "$ROOMY_HOME/.source-release.json"
```

Optional built-server smoke:

```sh
IMAGE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.ROOMY_HOME+"/.source-release.json")).sandboxImage)')"

PORT=35141 \
ROOMY_HOME="$ROOMY_HOME" \
ROOMY_SERVE_APP=1 \
ROOMY_APP_DIST="$ROOMY_HOME/current/packages/app/dist" \
ROOMY_SANDBOX_IMAGE="$IMAGE" \
node "$ROOMY_HOME/current/packages/server/api/dist/main.js"
```

Then check:

```sh
curl -f http://127.0.0.1:35141/health
```

## Rollout plan

1. Land CLI source-release path and targeted tests.
2. Land strict sandbox mode and fingerprint coverage.
3. Add the source-update smoke job to CI.
4. On the production server, create a separate pre-production service with its
   own `ROOMY_HOME`, port, domain, and reverse-proxy route.
5. Run the first update manually:

   ```sh
   ROOMY_HOME=/var/lib/roomy-preprod roomy service update --source /opt/roomy-dev
   ```

6. Verify the pre-production domain serves the new build and agent sandboxes can
   start.
7. Document the server-specific command in the operator notes once the service
   layout is finalized.

## Open questions

- Should old releases be pruned automatically, or should cleanup stay manual
  for now?
- Should source deploy refuse dirty git trees, warn only, or allow them because
  server-side development often includes uncommitted work?
- Should release IDs include branch names for easier operator inspection?
- Should a future command support rollback, for example
  `roomy service update --rollback <releaseId>`?

## Verification so far

- `npm -w @roomy-ai/cli run test` passed under Node 23.11.1.
- `npm -w @roomy-ai/cli run typecheck` passed under Node 23.11.1.
- `npm -w @roomy-ai/runtime run test -- test/sandboxFingerprint.test.ts`
  passed under Node 23.11.1.
- `npm -w @roomy-ai/runtime run typecheck` passed under Node 23.11.1.
- `npx eslint packages/cli/src/roomy.mjs packages/cli/test/roomy.test.mjs
  packages/server/runtime/test/sandboxFingerprint.test.ts` passed under Node
  23.11.1.
- `npm run ci:local` was attempted under Node 23.11.1. It passed typecheck but
  failed in the sandbox-image phase because `docker` is not installed on this
  shell PATH (`exit 127`).
