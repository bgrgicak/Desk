# Roomy app storage interaction

Use this when the user asks you to inspect, import, export, migrate, fix,
or otherwise CRUD records for an existing Roomy app.

This is an operational data skill, not the normal way to implement app
features. When authoring or modifying app UI, update the app source and use
the scaffold storage client; do not seed or patch data with direct SQLite
writes just to make unfinished UI appear to work.

## First, load the app's contract

Each app owns its data model. Before editing storage, inspect the app
directory and read the most specific guide available:

1. `fragments/<name>/skill.md` when the request names or clearly targets
   a fragment, collection, or UI surface. If the request mentions a
   collection like `habits`, prefer `fragments/habits/skill.md`; do not
   just read the first `skill.md` returned by glob.
2. App-level `skill.md` if the app has one.
3. `roomy.app.json`, `fragments/*/roomy.fragment.json`, and the app source
   only if the skill files do not define the storage contract.

If multiple fragment skills exist and the target is unclear, read all
fragment `skill.md` files and choose the one whose storage contract names
the requested collection or document type.

The skill should tell you which collections exist, the document shape,
stable IDs if any, validation rules, and user-visible invariants. If it
doesn't, infer the minimum needed from the source and update the app skill
after you finish so the next agent does not have to reverse-engineer it.

## Prefer app APIs from app code

When you are authoring or modifying app UI, use
`getStorageClient()` from `src/storage/client.ts`. The client talks to
`window.roomy.storage` and enforces the app's declared `storage.read` and
`storage.write` capabilities.

Do not add direct HTTP calls to `/apps/.../storage/...` in app code. Do
not use `localStorage`, `sessionStorage`, or `IndexedDB` as persistent
record storage.

Test storage-backed UI with real integration or end-to-end coverage. Do not
mock the storage client as the only proof that reads, writes, refreshes, or
capability handling work. Manually test the storage flow in the built app
before saying it is ready.

Integration and end-to-end tests need a real test database. Do not point
tests at the user's live `.storage/data.sqlite`. Create an isolated temporary
app directory or temporary `.storage/data.sqlite` for each test run, initialize
the real `docs` schema, exercise the real storage path, and discard the test
database after the test. The test database should be real SQLite with the real
schema, not an in-memory fake or mocked storage client.

## Direct CRUD from the agent

When the user explicitly asks you to manipulate the app's stored data, it
is acceptable to edit the app's SQLite database from the sandbox filesystem
after reading the app's storage contract.

Do not use direct SQLite CRUD for ordinary app implementation. Direct writes
are only for explicit data operations such as inspection, import, export,
migration, repair, or one-off user-requested record changes. If the app
source, manifests, or fragment skills disagree with the data you are about
to write, stop and reconcile the contract first instead of inventing a new
schema.

Storage location:

```
<name>.app/.storage/data.sqlite
```

The database may not exist yet. Roomy creates it lazily the first time the
running app uses storage. If the user asked you to create or import records
and `.storage/data.sqlite` is missing, create the `.storage/` directory,
open `data.sqlite`, and initialize the schema below before writing records.
If `data.sqlite` exists but the `docs` table is missing, initialize the same
schema before writing records. If the user only asked you to inspect existing
records, report that no app storage has been initialized yet instead of
creating an empty database.

Schema:

```sql
CREATE TABLE docs (
  collection TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  doc        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, doc_id)
);
```

CRUD mapping:

- List: `SELECT doc_id, doc, created_at, updated_at FROM docs WHERE collection = ? ORDER BY updated_at DESC, doc_id DESC`
- Read: `SELECT doc FROM docs WHERE collection = ? AND doc_id = ?`
- Create: insert JSON into `doc` with `created_at` and `updated_at` set to `Date.now()` milliseconds.
- Update/upsert: preserve `created_at` for existing rows and advance `updated_at`.
- Delete: delete the row by `(collection, doc_id)`.

Keep `doc` valid JSON. Collection names must match
`^[a-z][a-z0-9_-]{0,62}$`; document IDs must match
`^[A-Za-z0-9_-]{1,128}$`.

Use Node's `node:sqlite` module for direct CRUD. The Roomy sandbox has Node,
while `sqlite3` and `python3` CLIs may be absent. Do not start with the
`sqlite3` CLI. Do not use Python unless you have already verified it exists.
If the Node script fails, fix the Node script; never fall back to a mock or
JSON store.

Recommended direct-write pattern:

```sh
node --input-type=module <<'NODE'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const appDir = '/home/agent/.chats/<chatId>/artifacts/<name>.app'
const dbPath = join(appDir, '.storage', 'data.sqlite')
mkdirSync(dirname(dbPath), { recursive: true })

const db = new DatabaseSync(dbPath)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      collection TEXT NOT NULL,
      doc_id     TEXT NOT NULL,
      doc        TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (collection, doc_id)
    );
  `)

  const now = Date.now()
  const upsert = db.prepare(`
    INSERT INTO docs (collection, doc_id, doc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(collection, doc_id) DO UPDATE
      SET doc = excluded.doc, updated_at = excluded.updated_at
  `)

  upsert.run('habits', 'example-id', JSON.stringify({ name: 'Example' }), now, now)

  const rows = db.prepare(
    'SELECT collection, doc_id, doc FROM docs WHERE collection = ? ORDER BY doc_id'
  ).all('habits')
  console.log(JSON.stringify(rows, null, 2))
} finally {
  db.close()
}
NODE
```

Adapt the collection, document IDs, and JSON document shape to the app's
own skill contract before running it.

Never create a parallel fallback store such as `.storage/docs.json`,
`localStorage` seed files, TypeScript constants, or ad-hoc JSON files. Roomy
app storage is the SQLite `docs` table in `.storage/data.sqlite`; anything
else will be invisible to the app and to the Roomy storage API.

After writes, verify with a fresh SQLite read from `data.sqlite` and print
the rows you read back. A successful CRUD operation means the `docs` table
contains the expected `(collection, doc_id, doc)` rows, not merely that a
script wrote without throwing.

## Safety rules

- Back up `data.sqlite` before bulk imports, migrations, or destructive edits.
- For risky storage changes, operate on a copy first. Copy
  `.storage/data.sqlite` to a temporary file, run the import/migration/repair
  against the copy, verify the expected rows from the copy, and only then
  apply the verified change to the real database after backing up the
  original.
- Do not invent collections or fields unless the user asked for a schema change.
- Do not create seed data to hide an app implementation bug. Fix the app UI,
  storage client usage, capabilities, or validation instead.
- Do not bypass app validation casually. If source code enforces derived fields,
  status transitions, uniqueness, or denormalized counters, preserve those
  invariants when editing SQLite directly.
- If storage behavior changed, update the relevant app or fragment `skill.md`
  so future agents do not have to reverse-engineer the schema.
- After direct edits, run the app's relevant integration or end-to-end tests
  and `npm run verify` from the app directory when feasible. Do not rely on
  mock-only tests.
- Manually open the built app after direct storage edits when the change
  should be visible in the UI, then confirm the app can read the edited data.
- Attach the updated `.app/` directory if your change should be visible in chat.

## What app and fragment skills should document

Every real app or fragment that uses storage should include a storage section
with:

- Capabilities required: `storage.read`, `storage.write`, or both.
- Collections used.
- TypeScript-ish document shape for each collection.
- Whether IDs are generated with `create` or app-chosen with `put`.
- Allowed CRUD operations and any validation/invariants.
- Example records for imports or manual repair.
