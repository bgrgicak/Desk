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

GitHub connections are exposed as both `GITHUB_TOKEN` and `GH_TOKEN` for CLI compatibility. The UI guides users to create a classic personal access token with the `repo` scope, plus `workflow` if agents should edit GitHub Actions workflow files. Classic tokens are broad, but they are currently the simplest compatible path for `gh`, GitHub API calls, private repo git operations, pull requests, issues, and HTTPS `git` from sandboxes. Deleting the connection removes Desk's local vault entry; users can revoke or rotate the token in GitHub settings. The runtime also creates a temporary `GIT_ASKPASS` helper during OpenCode runs so HTTPS `git` operations can authenticate non-interactively without requiring the `gh` CLI to be installed.

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
file at `${DESK_HOME}/vaults/{userId}.kdbx`, encrypted with a master
password the user sets.

### Threat model

The thing this defeats: **disk snapshot / leaked backup / lost
laptop.** The master password is never on disk; the KDBX file alone
is useless without it. A vanilla provider-keys-style on-disk key
file would have leaked everything in those scenarios.

The thing it doesn't defeat: a host-root attacker who can dump the
running desk-server process's memory while the vault is unlocked.
Out of scope for v1; would need an HSM or hardware enclave.

### Lifecycle

| Operation | Code path | Notes |
|-----------|-----------|-------|
| First-time setup | `POST /vault/setup` → `vault/store.ts → setup()` | Creates KDBX, holds master in memory |
| Unlock | `POST /vault/unlock` → `vault/store.ts → unlock()` | Verifies by attempting to decrypt; 401 on bad password |
| Lock | `POST /vault/lock` and `handleLogout` | Master Buffer is `fill(0)`'d, reference dropped |
| Server restart | Process exit | All in-memory masters die with the process |
| Read by user | (no endpoint) | The SPA cannot read plaintext, by design |
| Read by agent | `GET /sandbox/secrets/:title` (X-Desk-Sandbox-Token) | Agent's `userId` resolves the vault |
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
- `DESK_VAULT_PASSWORD` env-var unlock (would let headless deploys
  auto-unlock at boot).
- App-write capability path (waits on per-app identity from #47).
- Audit log for vault reads (mirror of `provider_key_access_log`).
- Per-workspace ACLs (currently every workspace under the user can
  read every secret in that user's vault).
