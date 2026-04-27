# Security

## Provider API key storage

User-supplied API keys (Anthropic, OpenAI, etc.) are stored in the `user_settings` table as an AES-256-GCM-encrypted BYTEA blob (`provider_keys_encrypted`). A fresh 12-byte IV is generated per encryption; the auth tag is appended to detect tampering.

### Encryption key management

The AES key is loaded by `packages/server/db/src/encryption.ts` → `ensureSecretKey()`. Current behaviour:

1. Checks `DESK_SECRET_KEY` env var (base64-encoded 32 bytes) — injected at deploy time from a secrets manager so the key never touches the server filesystem.
2. Falls back to a key file at `DESK_SECRET_KEY_PATH` (default `/home/desk/secret.key`, mode `0600`). Generated automatically on first boot.

**Risk**: if the key file fallback is used, it lives on the same filesystem as the encrypted database. A full-disk backup or host compromise yields both. Mitigated by setting `DESK_SECRET_KEY` in production.

**Generate a key**:
```bash
openssl rand -base64 32
```

### Key lifecycle

| Operation | Code path | Notes |
|-----------|-----------|-------|
| Stored | `queries/userSettings.setProviderKeys` | Full overwrite, encrypted |
| Updated / deleted | `queries/userSettings.mergeProviderKeys` | Selective patch |
| Read for sandbox | `scheduler/src/runs.ts` | Decrypted into memory, injected as Docker env vars |
| Read for UI | `api/src/routes/account.ts → getProviders` | Always masked (`sk-ant-...nop`) before returning |

Keys are never returned in plaintext over the API. The masking function lives in `api/src/routes/account.ts → maskKey()`.

### Docker sandbox injection

Keys are passed to containers as environment variables via `runtime/src/docker.ts → providerKeyEnv()`. This means they are visible via `docker inspect` on the host. Because the sandboxed code must be able to use the keys, switching to a tmpfs file does not reduce exposure — any code running in the container can read either.

The real risk is `docker inspect` access on the host, which requires Docker socket access (root-equivalent). Mitigated sufficiently by host access controls.

---

## Provider key access audit log

**Status**: implemented.

Every read, write, and delete of provider keys is recorded in the `provider_key_access_log` table.

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

`providers[]` holds the key names (e.g. `["ANTHROPIC_API_KEY"]`), never values.

### Call sites

| Event | Call site | `action` | `reason` |
|-------|-----------|----------|---------|
| User saves keys in settings UI | `api/src/routes/account.ts → setProviders` | `write` / `delete` | `"user_update"` |
| Keys fetched for sandbox run | `scheduler/src/runs.ts → fireMessage` | `read` | `"sandbox_run:<messageId>"` |

### Query helpers

`packages/server/db/src/queries/providerKeyAccessLog.ts` exports:
- `logKeyAccess(db, userId, action, providers, reason?)` — insert a log entry
- `getKeyAccessLog(db, userId, limit?)` — retrieve entries newest-first
