# Backup & Restore

The Roomy app keeps **all** durable state under `~/Roomy/` on the host:

- `~/Roomy/.database/roomy.sqlite3` — SQLite database (users, workspaces,
  chats, messages, tasks, auth sessions, non-secret connection metadata). Mode
  0600 — readable only by the host user.
- `~/Roomy/{slug}/` — workspace files (notes, attachments, chat
  logs, summary snapshots under `.chats/*/notes/`). One directory per
  workspace, sitting directly under `~/Roomy/`.
- `~/Roomy/.trash/` — soft-deleted workspaces and rotated logs.

The DB lives under a dotfile parent (`.database/`) so it doesn't show up
in any in-app library listing of `~/Roomy`. The dotfile is **not** a
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
T=$(cat /etc/roomy-server/internal-token 2>/dev/null \
    || cat ~/.config/roomy-server/internal-token 2>/dev/null)
curl -sf -X POST -H "Authorization: Bearer $T" \
  http://127.0.0.1:35138/internal/backup
# → {"ok":true,"path":"~/Roomy/backups/roomy-2026-04-28-09-15-22.sqlite3","sizeBytes":...}
```

Default destination is `~/Roomy/backups/roomy-<UTC timestamp>.sqlite3`, so
backups ride your existing filesystem backup. Pass `{"path": "..."}` in
the body to override; the path must not already exist (`VACUUM INTO`
refuses to overwrite).

### Offline backup with the CLI

Stop the server first so the EXCLUSIVE lock is released:

```bash
# stop `npm run dev` / roomy start, then:
sqlite3 ~/Roomy/.database/roomy.sqlite3 \
  ".backup '$HOME/Roomy/backups/roomy-$(date +%F).sqlite3'"
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
Machine and `cp -r ~/Roomy` include dotfiles; restic/borg without an
explicit `--include` may not. Verify the tool you use copies
`~/Roomy/.database/` and `~/Roomy/.trash/`.

## Restore

1. Stop the server (Ctrl+C the dev process).
2. Replace `~/Roomy/.database/roomy.sqlite3` with the backup file (and
   delete any leftover `roomy.sqlite3-wal` and `roomy.sqlite3-shm` so SQLite
   doesn't replay stale WAL on top of the restored snapshot).
3. Restore the per-workspace directories under `~/Roomy/` if needed.
4. Start the server again.

The migrations are idempotent — if the backup is from an older schema, the
server will run any pending migrations on first boot.

## What does not need backing up

- `~/Roomy/.database/roomy.sqlite3-wal` and `roomy.sqlite3-shm` — SQLite's
  write-ahead log and shared memory files. They're regenerated on boot,
  and `sqlite3 .backup` already produces a checkpointed snapshot.
  Copying them alongside the main file is fine but not necessary.

## Credentials at rest

The DB stores derivatives, not raw secrets:

- **User passwords**: argon2id hashes in `users.password_hash`.
- **Auth session tokens**: SHA-256 hashes in `auth_sessions.token_hash` —
  the raw token only ever exists in the cookie/header sent by the
  browser.
- **Provider API keys** (user-supplied per-provider tokens): entries in the
  per-user KDBX vault at `${ROOMY_HOME}/.vaults/{userId}.kdbx`.
- **Internal API token** (at/cron jobs → `/internal/messages/fire`):
  generated on first boot if missing — no need to back up.
- **Per-user secrets vault** (provider API keys and logins for sites the agent
  should sign in to): a KDBX 4 file per user at
  `${ROOMY_HOME}/.vaults/{userId}.kdbx`. It is encrypted with a password the
  user picks through the signup wizard (or the in-app VaultDialog on first
  credential save). Back up the KDBX files; the password is not stored on
  disk — if the user forgets it, the vault is unrecoverable.

Persistence between restarts: everything except the in-memory WebSocket
connection registry and the per-user vault unlock state. User passwords,
sessions, schedules, and messages live in the SQLite file; provider keys and
site logins live in the KDBX vaults, which the user re-unlocks through the
VaultDialog after every server restart.
