# Desk app storage interaction

Use this when the user asks you to inspect, import, export, migrate, fix,
or otherwise CRUD records for an existing Desk app.

## First, load the app's contract

Each app owns its data model. Before editing storage, inspect the app
directory and read the most specific guide available:

1. `fragments/<name>/skill.md` when the request names or clearly targets
   a fragment.
2. App-level `skill.md` if the app has one.
3. `desk.app.json`, `fragments/*/desk.fragment.json`, and the app source
   only if the skill files do not define the storage contract.

The skill should tell you which collections exist, the document shape,
stable IDs if any, validation rules, and user-visible invariants. If it
doesn't, infer the minimum needed from the source and update the app skill
after you finish so the next agent does not have to reverse-engineer it.

## Prefer app APIs from app code

When you are authoring or modifying app UI, use
`getStorageClient()` from `src/storage/client.ts`. The client talks to
`window.desk.storage` and enforces the app's declared `storage.read` and
`storage.write` capabilities.

Do not add direct HTTP calls to `/apps/.../storage/...` in app code. Do
not use `localStorage`, `sessionStorage`, or `IndexedDB` as persistent
record storage.

## Direct CRUD from the agent

When the user explicitly asks you to manipulate the app's stored data, it
is acceptable to edit the app's SQLite database from the sandbox filesystem
after reading the app's storage contract.

Storage location:

```
<name>.app/.storage/data.sqlite
```

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

## Safety rules

- Back up `data.sqlite` before bulk imports, migrations, or destructive edits.
- Do not invent collections or fields unless the user asked for a schema change.
- Do not bypass app validation casually. If source code enforces derived fields,
  status transitions, uniqueness, or denormalized counters, preserve those
  invariants when editing SQLite directly.
- After direct edits, run the app's relevant tests and `npm run verify` from
  the app directory when feasible.
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
