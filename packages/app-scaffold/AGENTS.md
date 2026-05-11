# Desk App Scaffold Instructions

This directory is the template copied by `desk-agent app create <name>` into
`~/.chats/<chatId>/artifacts/<name>.app/` and later, after promotion, into
`~/<name>.app/`. Anything changed here becomes part of generated apps.

## Start Here

Build the smallest correct static app that satisfies the user. Prefer one clear
screen when that is enough; split into fragments only when a surface should also
stand alone in chat or needs its own capabilities.

Non-negotiable rules:

- Static-only: no Express, Hono, Node server, SSR, background jobs, webhooks, or
  sidecars. The only backend is Desk.
- Use the Desk capability bridge for privileged work. Do not author auth,
  cookies, direct Desk API fetches, or `window.parent` DOM access.
- Persist user records with `getStorageClient()` from `src/storage/client.ts`.
  Never use `localStorage`, `sessionStorage`, `IndexedDB`, constants, or ad-hoc
  JSON files as the source of truth.
- Generated apps run inside `sandbox="allow-scripts allow-forms"` without
  `allow-same-origin`; do not depend on same-origin browser APIs, downloads,
  popups, top-level navigation, or browser permissions.
- If a feature seems to need a backend or unavailable capability, tell the user
  what is missing instead of inventing a workaround.

## Working Loop

1. Decide the app shape: one `src/App.tsx` screen, or one app composed from
   focused fragments under `fragments/<name>/`.
2. Edit source in place; do not create another `.app/` unless the user clearly
   wants a separate app.
3. Add storage capabilities before using storage: `storage.read` and/or
   `storage.write` in `desk.app.json`, and in each storage-backed fragment's
   `desk.fragment.json`.
4. Replace or delete `fragments/example/` before shipping real work.
5. Run `npm run build` from the app directory, then confirm `dist/` exists and
   is populated. If build hangs or fails because of sandbox worker/fork limits,
   retry once with `npx vite build`.
6. Run `npm run verify` when the sandbox supports worker/fork-heavy test
   runners. If verification cannot run because of sandbox limits, report that
   explicitly instead of treating the app as fully verified.
7. Manually test the built app in Desk's sandboxed iframe, including each real
   standalone fragment entry and the main user flow.

Useful commands:

```sh
npm run typecheck
npm run test
npm run build
npm run verify
npm run dev
```

The sandbox image already has Node 22, npm, and offline-installed
`node_modules/`. Do not run `npm install` unless adding a dependency.

## App Shape

Use one screen in `src/App.tsx` for trivial calculators, single forms, or simple
displays with no internal navigation.

Use fragments for:

- Multiple user-facing views, such as list/detail, dashboard/cards, tabs, or
  list/add flows.
- Surfaces useful directly in chat messages, such as a chart, editor, preview,
  or focused form.
- Surfaces with different capability profiles, such as read-only view and
  write/import UI.

Fragment rules:

- Each fragment lives in `fragments/<name>/` and has `Component.tsx`,
  `main.tsx`, `index.html`, `desk.fragment.json`, and `skill.md`.
- The fragment's `Component.tsx` is the only implementation of that surface.
  The full app imports it; do not duplicate code under `src/`.
- A fragment must render standalone. Do not import `src/App.tsx` or depend on a
  full-app-only store from fragment code.
- Keep ordinary reusable UI pieces in `src/components/`.

Examples:

- Todo tracker: `todo-list` and `add-todo` fragments.
- Trip planner: `itinerary`, `expenses`, and `packing-list` fragments.
- Unit converter: one `src/App.tsx`, no real fragments.

## Directory Map

```text
<name>.app/
  package.json
  vite.config.ts
  index.html
  desk.app.json
  src/
    main.tsx
    App.tsx
    index.css
    storage/client.ts
  fragments/
    <fragment>/
      Component.tsx
      main.tsx
      index.html
      desk.fragment.json
      skill.md
  dist/
```

`vite.config.ts` already builds `index.html` plus every
`fragments/*/index.html` entry and sets `base: './'` for iframe-safe relative
assets.

## Persistent app storage

Use Desk storage for records that must survive refreshes, app reloads, chat
artifact promotion, future editing sessions, or movement between clients such
as desktop and phone. Browser storage is only for disposable UI cache.

Desk storage is exposed to app code through `window.desk.storage`; use the
scaffold client:

```ts
import { getStorageClient } from './storage/client'
```

From a fragment, the import is usually:

```ts
import { getStorageClient } from '../../src/storage/client'
```

Declare capabilities before calling storage:

```json
{
  "capabilities": ["storage.read", "storage.write"]
}
```

Store JSON documents in named collections:

```ts
interface Todo {
  title: string
  done: boolean
}

const storage = getStorageClient()
const todos = await storage.list<Todo>('todos')
const todo = await storage.create<Todo>('todos', { title: 'Plan trip', done: false })
await storage.put<Todo>('todos', todo.id, { ...todo.doc, done: true })
await storage.delete('todos', todo.id)
```

API shape:

- `list<T>(collection): Promise<StorageDoc<T>[]>`
- `get<T>(collection, id): Promise<StorageDoc<T> | null>`
- `create<T>(collection, doc): Promise<StorageDoc<T>>`
- `put<T>(collection, id, doc): Promise<StorageDoc<T>>`
- `delete(collection, id): Promise<void>`

Collection names must match `^[a-z][a-z0-9_-]{0,62}$`. Document IDs are created
by `create`; use `put` only when the app genuinely needs a stable chosen ID.
Documents must be JSON-serializable.

Desk currently backs app storage with `.storage/data.sqlite` inside the app
directory, so it travels with the `.app/` when Desk promotes or replaces the
app. Cross-device availability depends on Desk syncing app storage, not on
browser-device-local storage.

Storage-backed UI must handle loading and errors. Do not call storage at module
scope or unguarded during render; use effects, event handlers, or explicit async
actions with error handling.

## App and fragment skills

`skill.md` files are operational contracts for future agents, not filler. If a
fragment or app uses storage, keep its contract accurate.

Storage contract template:

````md
## Storage contract

Capabilities: `storage.read`, `storage.write`

Collections:
- `todos`

Document shape:
```ts
interface Todo {
  title: string
  done: boolean
  createdAt: string
}
```

IDs: generated by `storage.create`; do not choose semantic IDs.

Allowed agent operations:
- List/export todos.
- Create todos from user-provided titles.
- Update `done` only through explicit user request.
- Delete only after the user asks to remove a todo.

Invariants:
- `title` is non-empty after trimming.
- `createdAt` is an ISO timestamp.
````

If storage behavior changes, update the matching `skill.md` before shipping.

## Testing Standard

Write or update tests for user-visible behavior changes before implementing the
feature. Prefer integration or end-to-end coverage that exercises real routes,
real fragment entries, real manifests, real storage bridge behavior, and built
output. Helper tests are supplemental only.

Storage-backed tests must use an isolated real SQLite database with the real
`docs` schema. Never point tests at the user's live `.storage/data.sqlite`, and
never use a mocked or in-memory storage client as the only proof that storage
works.

Never mock `window.desk.storage`, `getStorageClient()`, or any Desk capability
bridge. A mocked bridge validates a contract that does not exist in production
and hides real sandbox, capability, and adapter bugs.

Instead:

- Extract sort, filter, validation, and transformation logic into pure functions
  and test those directly.
- Test component rendering with inline real-shaped `StorageDoc<T>[]` fixtures;
  fabricate data, not the storage client.
- Add storage integration smoke tests that exercise the real adapter shape.
- If a function requires async storage, test the synchronous transformation layer
  separately and cover the storage path with integration or end-to-end testing.

Example component fixture pattern:

```ts
import type { StorageDoc } from './storage/client'

interface Task {
  title: string
  done: boolean
}

const tasks: StorageDoc<Task>[] = [
  {
    id: 'task_1',
    doc: { title: 'Plan trip', done: false },
    createdAt: 1710000000000,
    updatedAt: 1710000000000,
  },
]
```

Before telling the user the app is ready, verify:

- `npm run verify` exits zero.
- `dist/` exists and contains built output. `npm run verify` checks this; an app
  with missing or empty `dist/` is broken even if another command reported
  success.
- The built full app works inside an iframe with
  `sandbox="allow-scripts allow-forms"` and no `allow-same-origin`.
- Every real standalone fragment entry loads and its main flow works.
- Storage-backed flows create, read, update, delete, refresh, and still show the
  expected data through Desk storage.
- The app has no leftover example-fragment UI unless explicitly requested.

## UI Library

Use `@agent-desk/ui` components before adding new UI dependencies. Browse the
exports in `node_modules/@agent-desk/ui/dist/index.d.ts`. Common exports include
`Button`, `Input`, `Dialog`, `DropdownMenu`, `Card`, `Tabs`, and `Sheet`.

If a primitive is missing, build a small local component in `src/components/`
instead of installing another component library.
