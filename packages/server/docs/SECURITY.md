# Security

## Connection credential storage

User-supplied connection credentials — AI-provider API keys plus sandbox tool tokens such as `GITHUB_TOKEN` — are stored in the per-user vault-backed provider/connection flow while preserving the `/me/providers` API shape.

### Vault key management

The user sets a vault password via `POST /vault/setup` and unlocks it via
`POST /vault/unlock`. The master password is never stored on disk; while
unlocked it is held only in server memory and zero-filled on lock/logout. The
KDBX file alone is not enough to recover connection credentials from a disk
snapshot or backup.

### Key lifecycle

| Operation | Code path | Notes |
|-----------|-----------|-------|
| Stored | `api/src/routes/account.ts → setProviders` / `vault.upsert` | Selective write into the user's KDBX vault |
| Deleted | `api/src/routes/account.ts → setProviders` / `vault.delete` | Selective delete from the user's KDBX vault |
| Read for sandbox | `scheduler/src/runs.ts` | Decrypted into memory, injected as sandbox exec env vars |
| Read for UI | `api/src/routes/account.ts → getProviders` | Always masked (`sk-ant-...nop`) before returning |

Keys are never returned in plaintext over the API. The masking function lives in `api/src/routes/account.ts → maskKey()`.

### Docker sandbox injection

Keys are passed to containers as environment variables via `runtime/src/docker.ts → providerKeyEnv()` at create time and `providerKeyExecEnv()` per run. This means container-scoped credentials are visible to code running in the sandbox; create-time values may also be visible via `docker inspect` on the host. Because sandboxed code must be able to use the keys, switching to a tmpfs file does not reduce exposure — any code running in the container can read either.

GitHub connections are exposed as both `GITHUB_TOKEN` and `GH_TOKEN` for CLI compatibility. The UI guides users to create a classic personal access token with the `repo` scope, plus `workflow` if agents should edit GitHub Actions workflow files. Classic tokens are broad, but they are currently the simplest compatible path for `gh`, GitHub API calls, private repo git operations, pull requests, issues, and HTTPS `git` from sandboxes. Deleting the connection removes Roomy's local vault entry; users can revoke or rotate the token in GitHub settings. The runtime also creates a temporary `GIT_ASKPASS` helper during pi runs so HTTPS `git` operations can authenticate non-interactively without requiring the `gh` CLI to be installed.

The real risk is `docker inspect` access on the host, which requires Docker socket access (root-equivalent). Mitigated sufficiently by host access controls.

---

## Provider key access audit log

**Status**: implemented.

Every read, write, and delete of provider/connection keys is recorded in the `provider_key_access_log` table.

### Schema

```sql
CREATE TABLE provider_key_access_log (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     TEXT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action      TEXT         NOT NULL CHECK (action IN ('read', 'write', 'delete')),
  providers   TEXT[]       NOT NULL DEFAULT '{}',
  reason      TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

`providers[]` holds the key names (e.g. `["OPENAI_API_KEY"]` or `["GITHUB_TOKEN"]`), never values.

### Call sites

| Event | Call site | `action` | `reason` |
|-------|-----------|----------|---------|
| User saves keys in settings UI | `api/src/routes/account.ts → setProviders` | `write` / `delete` | `"user_update"` |
| Keys fetched for sandbox run | `scheduler/src/runs.ts → fireMessage` | `read` | `"sandbox_run:<messageId>"` |

### Query helpers

`packages/server/db/src/queries/providerKeyAccessLog.ts` exports:
- `logKeyAccess(db, userId, action, providers, reason?)` — insert a log entry
- `getKeyAccessLog(db, userId, limit?)` — retrieve entries newest-first

---

## Per-user secrets vault

User-stored credentials (logins for sites the user wants their agents
to act on) live in a per-user [KDBX 4](https://keepass.info/help/kb/kdbx_4.html)
file at `${ROOMY_HOME}/.vaults/{userId}.kdbx`, encrypted with a master
password the user sets.

### Threat model

The thing this defeats: **disk snapshot / leaked backup / lost
laptop.** The master password is never on disk; the KDBX file alone
is useless without it. A vanilla provider-keys-style on-disk key
file would have leaked everything in those scenarios.

The thing it doesn't defeat: a host-root attacker who can dump the
running roomy-server process's memory while the vault is unlocked.
Out of scope for v1; would need an HSM or hardware enclave.

### Lifecycle

| Operation | Code path | Notes |
|-----------|-----------|-------|
| First-time setup | `POST /vault/setup` → `vault/store.ts → setup()` | Creates KDBX, holds master in memory |
| Unlock | `POST /vault/unlock` → `vault/store.ts → unlock()` | Verifies by attempting to decrypt; 401 on bad password |
| Lock | `POST /vault/lock` and `handleLogout` | Master Buffer is `fill(0)`'d, reference dropped |
| Server restart | Process exit | All in-memory masters die with the process |
| Read by user | (no endpoint) | The SPA cannot read plaintext, by design |
| Read by agent | `GET /sandbox/secrets/:title` (X-Roomy-Sandbox-Token) | Agent's `userId` resolves the vault |
| Write by user | `POST /secrets`, `PUT /secrets/:title` | Add or overwrite via KDBX entry fields |

The master password is held as a `Buffer` (not a JS String) so we
can zero-fill it on lock — JS Strings are immutable and would leave
copies in V8's heap until GC.

### Crypto

KDBX 4 with the AES-256-CBC outer cipher and Argon2id KDF (kdbxweb's
defaults). Argon2 runs in pure JS via `@noble/hashes/argon2` — no
native build dependency. Slower unlock by a few seconds vs. native,
acceptable for a once-per-restart operation.

### What the SPA can / can't do

The SPA has **no reveal endpoint**. List endpoints return titles +
metadata only (username, url, hasNotes); plaintext lives only in
the KDBX file and in the server's in-memory cache while unlocked.
A hijacked SPA session can overwrite secrets but can't exfiltrate
them — that's an intentional asymmetry, not a bug.

### Lock-on-logout

`POST /auth/logout` — when no live sessions remain for the user, the
vault is locked as a side-effect (`auth.ts → handleLogout`). Multi-
device users keep the vault unlocked while any session is alive.
Session-TTL expiry (the 7-day timeout) does **not** lock the vault;
only an explicit logout does.

### Out of scope for v1

- OS keyring integration (would let the master persist across server
  restarts on user-session hosts).
- `ROOMY_VAULT_PASSWORD` env-var unlock (would let headless deploys
  auto-unlock at boot).
- App-write capability path (waits on per-app identity from #47).
- Audit log for vault reads (mirror of `provider_key_access_log`).
- Per-workspace ACLs (currently every workspace under the user can
  read every secret in that user's vault).

---

## HTTP-layer controls

### Default security headers

Every response carries (`api/src/app.ts → setSecurityHeaders`):

| Header | Value | Why |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Blocks MIME-sniffing on JSON/text payloads |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Keeps full URLs (which carry vault/route IDs) out of cross-origin Referer headers |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=(), usb=(), payment=(), magnetometer=(), gyroscope=(), accelerometer=()` | Deny powerful APIs by default |
| `X-Frame-Options` | `DENY` (except `/apps/*`) | Blocks embedding outside the deliberate iframe surface |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` when `X-Forwarded-Proto: https` | Only set when a reverse proxy indicates TLS — HTTP-only dev/local deployments unaffected |

`Content-Security-Policy` is intentionally not set yet — the SPA's
inline assets and `/apps/*` iframe origin each need their own policy.
A focused follow-up will land it.

### Rate limiting (`api/src/auth/rateLimit.ts`)

In-memory sliding-window limiter applied to the high-risk endpoints.
Per-IP buckets fall back to a per-user bucket where relevant.

| Endpoint | Bucket | Limit |
|---|---|---|
| `POST /auth/login` | per-IP | 10 / minute |
| `POST /auth/signup` | per-IP | 5 / minute |
| `POST /vault/unlock` | per-IP **and** per-user | 10 / min (IP), 20 / 5 min (user) |
| `POST /me/password` | per-user | 10 / 5 min |

When over budget the server returns `429` with the standard `{code,
message}` shape plus a `Retry-After` header (seconds). Tests and one-off
scripts can disable the limiter entirely with `ROOMY_RATE_LIMIT_DISABLED=1`
(used by the e2e fixture; production never sets it).

### WebSocket Origin allowlist

The `/ws` upgrade handler validates the `Origin` header (CSWSH
mitigation, `api/src/app.ts → isWsOriginAllowed`).

- Any `http(s)://localhost` / `http(s)://127.0.0.1` / `http://[::1]`
  origin is accepted on any port — loopback can't legitimately serve
  a remote attacker page from the victim's machine.
- Additional production origins via `ROOMY_ALLOWED_ORIGINS`
  (comma-separated list).
- `ROOMY_ALLOWED_HOSTS` (same env var the Vite dev/preview server
  reads, default `roomy.test`) expands into `http://host` +
  `https://host` allowlist entries so the bundled nginx fixture works
  without configuring two parallel allowlists.
- Missing `Origin` header is allowed (CLI tools, integration tests,
  the Electron renderer when it doesn't emit one) — CSWSH applies
  only to script-initiated upgrades from a browser tab.

Origin check fires **before** token validation so the response can't
be used to probe whether a token is valid from a cross-site context.

### Vault password policy

`POST /vault/setup` (`api/src/routes/vault.ts → enforceVaultPasswordPolicy`):

- Min length 12 (NIST 800-63B favours length over composition).
- Rejects the documented `ROOMY_SEED_PASSWORD` string verbatim so a
  first-boot operator can't accidentally re-use it for the vault.

Deliberately **not** enforced on `/vault/unlock` — that would lock out
users who created a vault before this policy existed. The bar is "make
weak passwords hard to set," not retroactive invalidation.

### Signup gate

`POST /auth/signup` is disabled by default. Operators opt in with
`ROOMY_ENABLE_SIGNUP=1`; the unauthenticated `GET /auth/signup-status`
lets the SPA decide whether to render the live link vs the "coming
soon" placeholder. Single-user-per-host deployments leave it off.

When enabled: username (3–32 chars `[a-zA-Z0-9_-]`), valid email,
password ≥ 12 chars and ≠ the documented seed. Creates the user row,
bootstraps a hub workspace (matching `main.ts` boot behaviour), sets
up the per-user vault when `ROOMY_VAULT_PASSWORD` is set, returns a
session token. Same rate-limit shape as `/auth/login`.

### First-run seed-password flag

The seed user gets `must_change_password = 1` when the install boots on
the documented public `ROOMY_SEED_PASSWORD`. The flag clears on the next
successful `POST /me/password` (or any login-time hash upgrade). `GET
/me` surfaces it so the SPA can prompt for a change.

Operators who supply their own `ROOMY_SEED_PASSWORD` skip the flag —
they chose their own secret and don't need the prompt.

### Audit-log retention

`provider_key_access_log` rows older than `ROOMY_KEY_ACCESS_LOG_RETENTION_DAYS`
(default 90) are pruned on boot and then on a daily cadence by the
reaper in `api/src/main.ts`. Surfaced read-only at `GET
/me/key-access-log` (user-scoped, paginated, ISO timestamps).

### Misleading-log fix

`api/src/main.ts` previously logged "auto-unlocked via ROOMY_SECRET_KEY"
during vault auto-unlock. The variable actually read is
`ROOMY_VAULT_PASSWORD` (a distinct env var from the AES-256 key for
SQLite at-rest encryption). Fixed.

---

## Robustness / lifecycle

### Health vs readiness probes

| Endpoint | Returns | What's checked |
|---|---|---|
| `GET /health` | `{ok: true}` | Process is alive — no dependency probes |
| `GET /ready` | `{ok, checks: {db, vault}}` (200 or 503) | DB `SELECT 1` + vault `status()` round-trip |

Both unauthenticated so process supervisors (systemd, docker-compose
healthcheck, k8s readinessProbe) can probe without a token.

### Graceful shutdown

`SIGINT` / `SIGTERM` triggers a bounded shutdown
(`ROOMY_SHUTDOWN_GRACE_MS`, default 30000):

- Re-entrancy guard so double-signal doesn't run cleanup twice.
- Awaits `server.close()` (calls `closeIdleConnections()` first so
  keep-alive sockets release immediately).
- Watchdog timer force-exits if a hung request blocks the clean path
  past the grace window.
- `pool.end()` wrapped in try/catch — a DB-side shutdown error
  doesn't hijack the exit.

### Pre-migration DB snapshot

Before `runMigrations()`, the SQLite DB is snapshotted to
`${ROOMY_HOME}/backups/pre-migration-<ISO>.db` via `VACUUM INTO` (same
code path as `/internal/backup`). Skipped on a truly-empty file (first
boot). Retention bounded by `ROOMY_PRE_MIGRATION_BACKUP_KEEP` (default
10), oldest pruned first.

A backup failure is logged and the boot continues — losing the safety
net is preferable to refusing to start.

### Slow-query log

The SQLite pool wraps every query and warns when elapsed time exceeds
`ROOMY_SLOW_QUERY_MS` (default 50ms). Log line carries the prepared SQL
text (normalised + truncated to 240 chars) and row count; bind values
are never logged. Set to 0 to disable.

---

## Sandbox-side controls

### Egress policy (`ROOMY_SANDBOX_NETWORK`)

| Value | Behaviour |
|---|---|
| `bridge` (default) | Default Docker bridge network. Sandbox can reach AI provider APIs, GitHub, package registries — every URL the runtime needs. |
| `none` | `--network none`. No outbound connectivity. Drops the `host.docker.internal:host-gateway` extra-host entry. The in-sandbox `roomy` CLI gets a clear "ROOMY_API_URL is not set" error (rather than a TCP timeout) when invoked, because the runtime now omits `ROOMY_API_URL` in this mode. |

`none` is the right pick for paranoid deployments running agent
workloads that only need on-disk file editing + a pre-cached local
model. AI API calls (Anthropic, OpenAI), sandbox callbacks
to `host.docker.internal`, and any tool that downloads dependencies
all break — those are the intended trade-offs.

A real domain-level allowlist would need a sidecar HTTP proxy
(squid/mitmproxy in transparent mode) and is out of scope for v1; the
two-option knob covers the realistic deployment matrix today.

### Reproducible-build sanity check

The CI workflow builds `roomy/sandbox:v1` twice on every run (same
source, same `SOURCE_DATE_EPOCH`) and compares the resulting image
digests. **Drift is advisory today**: a `::warning::` annotation
shows up on the job summary instead of a hard failure. Promoting it
to blocking waits on the Dockerfile being made deterministic — apt
caches and `npm install` orderings currently leak ordering into the
layer digest. Tracked in ADR-0006.

Operators who depend on stable image digests (image-signing workflows,
content-addressable deployments) should rebuild from a trusted source
and compare against the previously-shipped digest until the
Dockerfile is hardened.
