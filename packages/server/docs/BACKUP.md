# Backup & Restore

The Desk app keeps **all** durable state under `~/Desk/` on the host:

- `~/Desk/.database/desk.sqlite3` — SQLite database (users, workspaces,
  chats, messages, tasks, auth sessions, encrypted provider keys). Mode
  0600 — readable only by the host user.
- `~/Desk/workspaces/{slug}/` — workspace files (notes, attachments, chat
  logs, note-history snapshots).
- `~/Desk/.trash/` — soft-deleted workspaces and rotated logs.

The DB lives under a dotfile parent (`.database/`) so it doesn't show up
in any in-app library listing of `~/Desk`. The dotfile is **not** a
security boundary — file mode 0600 is. Other local users on the same
host can still see the file with `ls -a` if their UID has read access.

The Lima VM holds zero durable state; a `vm:reset` is non-destructive.

## Manual backup

The pool opens the DB with `locking_mode = EXCLUSIVE` (single-writer-process
guarantee, plus 9p compatibility), which means a separate `sqlite3
.backup` CLI run can't open the file while the server is up. Two
options that both produce a consistent snapshot:

### Online backup via the server (recommended — no downtime)

The server exposes `POST /internal/backup` (loopback + bearer-token
auth) that runs SQLite's `VACUUM INTO` on the live connection. From
inside the VM:

```bash
T=$(sudo cat /etc/desk-server/internal-token)
curl -sf -X POST -H "Authorization: Bearer $T" \
  http://127.0.0.1:8080/internal/backup
# → {"ok":true,"path":"/home/desk/Desk/backups/desk-2026-04-28-09-15-22.sqlite3","sizeBytes":...}
```

Default destination is `~/Desk/backups/desk-<UTC timestamp>.sqlite3` on
the host mount, so backups ride your existing host-side filesystem
backup. Pass `{"path": "..."}` in the body to override; the path must
not already exist (`VACUUM INTO` refuses to overwrite).

### Offline backup with the CLI

Stop the server first so the EXCLUSIVE lock is released:

```bash
vm.sh halt
sqlite3 ~/Desk/.database/desk.sqlite3 \
  ".backup '$HOME/Desk/backups/desk-$(date +%F).sqlite3'"
vm.sh up
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

1. Stop the server: `vm.sh halt` (or `systemctl stop desk-server` on the VM).
2. Replace `~/Desk/.database/desk.sqlite3` with the backup file (and
   delete any leftover `desk.sqlite3-wal` and `desk.sqlite3-shm` so SQLite
   doesn't replay stale WAL on top of the restored snapshot).
3. Restore `~/Desk/workspaces/` if needed.
4. Start the server: `vm.sh up`.

The migrations are idempotent — if the backup is from an older schema, the
server will run any pending migrations on first boot.

## What does not need backing up

- The Lima VM disk image (no durable state inside it).
- `~/Desk/.database/desk.sqlite3-wal` and `desk.sqlite3-shm` — SQLite's
  write-ahead log and shared memory files. They're regenerated on boot,
  and `sqlite3 .backup` already produces a checkpointed snapshot.
  Copying them alongside the main file is fine but not necessary.

## Why SQLite + a host-mounted directory

Postgres used to run inside the Lima VM, with its data dir trapped on the
VM disk image. A `vm:reset` (or any disk-image issue) wiped the entire
app DB with no off-VM copy.

SQLite is a single file. With the file on the host (via the virtiofs
`~/Desk` mount), backup collapses to filesystem-level operations and the
VM stays disposable — its job is sandbox-container isolation, not state
storage.

## Credentials at rest

The DB stores derivatives, not raw secrets:

- **User passwords**: argon2id hashes in `users.password_hash`.
- **Auth session tokens**: SHA-256 hashes in `auth_sessions.token_hash` —
  the raw token only ever exists in the cookie/header sent by the
  browser.
- **Provider API keys** (Anthropic, OpenAI, etc.): AES-256-GCM
  encrypted blobs in `user_settings.provider_keys_encrypted`. The
  encryption key is a 32-byte file at `$DESK_SECRET_KEY_PATH` (default
  `/home/desk/secret.key`, mode 0600) — back it up alongside the DB or
  the encrypted blobs are unrecoverable.
- **Internal API token** (at/cron jobs → `/internal/messages/fire`):
  `/etc/desk-server/internal-token`, mode 0600. Regenerated on first
  boot if missing — no need to back up.

Persistence between restarts: everything except the in-memory WebSocket
connection registry. User passwords, sessions, schedules, messages,
provider keys all live in the SQLite file and survive any restart.
