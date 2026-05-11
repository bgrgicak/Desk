# Backup & Restore

The Desk app keeps **all** durable state under `~/Desk/` on the host:

- `~/Desk/.database/desk.sqlite3` — SQLite database (users, workspaces,
  chats, messages, tasks, auth sessions, encrypted provider keys). Mode
  0600 — readable only by the host user.
- `~/Desk/{slug}/` — workspace files (notes, attachments, chat
  logs, summary snapshots under `.chats/*/notes/`). One directory per
  workspace, sitting directly under `~/Desk/`.
- `~/Desk/.trash/` — soft-deleted workspaces and rotated logs.

The DB lives under a dotfile parent (`.database/`) so it doesn't show up
in any in-app library listing of `~/Desk`. The dotfile is **not** a
security boundary — file mode 0600 is. Other local users on the same
host can still see the file with `ls -a` if their UID has read access.

## Manual backup

The pool opens the DB with `locking_mode = EXCLUSIVE` (single-writer-process
guarantee), which means a separate `sqlite3 .backup` CLI run can't open
the file while the server is up. Two options that both produce a
consistent snapshot:

### Online backup via the server (recommended — no downtime)

The server exposes `POST /internal/backup` (loopback + bearer-token auth)
that runs SQLite's `VACUUM INTO` on the live connection.

```bash
T=$(cat /etc/desk-server/internal-token 2>/dev/null \
    || cat ~/.config/desk-server/internal-token 2>/dev/null)
curl -sf -X POST -H "Authorization: Bearer $T" \
  http://127.0.0.1:35138/internal/backup
# → {"ok":true,"path":"~/Desk/backups/desk-2026-04-28-09-15-22.sqlite3","sizeBytes":...}
```

Default destination is `~/Desk/backups/desk-<UTC timestamp>.sqlite3`, so
backups ride your existing filesystem backup. Pass `{"path": "..."}` in
the body to override; the path must not already exist (`VACUUM INTO`
refuses to overwrite).

### Offline backup with the CLI

Stop the server first so the EXCLUSIVE lock is released:

```bash
# stop `npm run dev` / desk start, then:
sqlite3 ~/Desk/.database/desk.sqlite3 \
  ".backup '$HOME/Desk/backups/desk-$(date +%F).sqlite3'"
# restart the server
```

The workspace tree is just files — back it up with whatever tool already
covers `~/`:

- macOS Time Machine
- restic, borgbackup, kopia
- rsync to another disk or rsync.net
- Backblaze, iCloud, Dropbox

**Watch out for dotfile excludes.** Some backup tools skip dotfiles by
default or via common include-glob patterns (`* `, `[!.]*`). Time
Machine and `cp -r ~/Desk` include dotfiles; restic/borg without an
explicit `--include` may not. Verify the tool you use copies
`~/Desk/.database/` and `~/Desk/.trash/`.

## Restore

1. Stop the server (Ctrl+C the dev process).
2. Replace `~/Desk/.database/desk.sqlite3` with the backup file (and
   delete any leftover `desk.sqlite3-wal` and `desk.sqlite3-shm` so SQLite
   doesn't replay stale WAL on top of the restored snapshot).
3. Restore the per-workspace directories under `~/Desk/` if needed.
4. Start the server again.

The migrations are idempotent — if the backup is from an older schema, the
server will run any pending migrations on first boot.

## What does not need backing up

- `~/Desk/.database/desk.sqlite3-wal` and `desk.sqlite3-shm` — SQLite's
  write-ahead log and shared memory files. They're regenerated on boot,
  and `sqlite3 .backup` already produces a checkpointed snapshot.
  Copying them alongside the main file is fine but not necessary.

## Credentials at rest

The DB stores derivatives, not raw secrets:

- **User passwords**: argon2id hashes in `users.password_hash`.
- **Auth session tokens**: SHA-256 hashes in `auth_sessions.token_hash` —
  the raw token only ever exists in the cookie/header sent by the
  browser.
- **Provider API keys** (user-supplied per-provider tokens): AES-256-GCM
  encrypted blobs in `user_settings.provider_keys_encrypted`. The
  encryption key is `DESK_SECRET_KEY` from `.env` (preferred) or a
  32-byte file at `$DESK_SECRET_KEY_PATH` — back it up alongside the
  DB or the encrypted blobs are unrecoverable.
- **Internal API token** (at/cron jobs → `/internal/messages/fire`):
  generated on first boot if missing — no need to back up.
- **Per-user secrets vault** (logins for sites the agent should sign
  in to): a KDBX 4 file per user at `${DESK_HOME}/vaults/{userId}.kdbx`.
  Encrypted with the user's master password (Argon2id KDF + AES-256).
  The master password is **never** persisted on disk — it lives in
  server memory only, dropped on restart and on logout. Back up the
  KDBX files alongside the DB; the user keeps their master password
  separately. If the master is lost, the file is unrecoverable.

Persistence between restarts: everything except the in-memory WebSocket
connection registry and the per-user vault unlock state. User passwords,
sessions, schedules, messages, provider keys all live in the SQLite file
and survive any restart. Secrets vaults survive restarts on disk but
require re-unlock from the SPA after each restart.
