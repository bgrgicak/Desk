# Backup & Restore

The Desk app keeps **all** durable state under `~/Desk/` on the host:

- `~/Desk/desk.db` — SQLite database (users, workspaces, chats, messages,
  tasks, auth sessions, encrypted provider keys).
- `~/Desk/workspaces/{slug}/` — workspace files (notes, attachments, chat
  logs, note-history snapshots).
- `~/Desk/.trash/` — soft-deleted workspaces and rotated logs.

The Lima VM holds zero durable state; a `vm:reset` is non-destructive.

## Manual backup

The DB is a single file. `sqlite3 .backup` is consistent without needing
to checkpoint WAL or pause the server:

```bash
mkdir -p ~/Desk/backups
sqlite3 ~/Desk/desk.db ".backup '~/Desk/backups/desk-$(date +%F).db'"
```

The workspace tree is just files — back it up with whatever tool already
covers `~/`:

- macOS Time Machine
- restic, borgbackup, kopia
- rsync to another disk or rsync.net
- Backblaze, iCloud, Dropbox

## Restore

1. Stop the server: `vm.sh halt` (or `systemctl stop desk-server` on the VM).
2. Replace `~/Desk/desk.db` with the backup file.
3. Restore `~/Desk/workspaces/` if needed.
4. Start the server: `vm.sh up`.

The migrations are idempotent — if the backup is from an older schema, the
server will run any pending migrations on first boot.

## What does not need backing up

- The Lima VM disk image (no durable state inside it).
- `~/Desk/desk.db-wal` and `~/Desk/desk.db-shm` — SQLite's write-ahead log
  and shared memory files. They're regenerated on boot, and `sqlite3
  .backup` already produces a checkpointed snapshot. Copying them
  alongside `desk.db` is fine but not necessary.

## Why SQLite + a host-mounted directory

Postgres used to run inside the Lima VM, with its data dir trapped on the
VM disk image. A `vm:reset` (or any disk-image issue) wiped the entire
app DB with no off-VM copy.

SQLite is a single file. With the file on the host (via the virtiofs
`~/Desk` mount), backup collapses to filesystem-level operations and the
VM stays disposable — its job is sandbox-container isolation, not state
storage.
