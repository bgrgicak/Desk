# Roomy App Scaffold Instructions

This directory is the template copied by `roomy-agent app create <name>` into
`~/.chats/<chatId>/artifacts/<name>.app/` and later, after promotion, into
`~/<name>.app/`. Anything changed here becomes part of generated apps.

## Start Here

Build the smallest correct fragment-composed static app that satisfies the
user. Fragments are the primary building blocks of Roomy apps, not optional
garnish. Identify distinct user-facing surfaces, workflows, storage-backed
capabilities, and capability boundaries before filling in the app shell. A
single broad “workspace” fragment is not sufficient when the app contains
multiple independently useful surfaces.

Non-negotiable rules:

- Static-only: no Express, Hono, Node server, SSR, background jobs, webhooks, or
  sidecars. The only backend is Roomy.
- Use the Roomy capability bridge for privileged work. Do not author auth,
  cookies, direct Roomy API fetches, or `window.parent` DOM access.
- Persist user records with `getStorageClient()` from `src/storage/client.ts`.
  Never use `localStorage`, `sessionStorage`, `IndexedDB`, constants, or ad-hoc
  JSON files as the source of truth.
- Generated apps run inside `sandbox="allow-scripts allow-forms"` without
  `allow-same-origin`; do not depend on same-origin browser APIs, downloads,
  popups, top-level navigation, or browser permissions.
- If a feature seems to need a backend or unavailable capability, tell the user
  what is missing instead of inventing a workaround.

## Working Loop

1. Decide the fragment model first, before writing `src/App.tsx`: write a brief
   inventory of each fragment's name, user-facing job, props/state contract,
   storage collections, capabilities, standalone rendering needs, and
   `roomy.app.json` registration. Implement those focused fragments under
   `fragments/<name>/`, then compose them from `src/App.tsx`. Skip real
   fragments only when the app is genuinely atomic and has no storage-backed
   workflow or reusable user-facing surface.
2. Edit source in place; do not create another `.app/` unless the user clearly
   wants a separate app.
3. Add storage capabilities before using storage: `storage.read` and/or
   `storage.write` in `roomy.app.json`, and in each storage-backed fragment's
   `roomy.fragment.json`.
4. Replace or delete `fragments/example/` before shipping real work. `npm run
   verify` fails while the example fragment directory remains.
5. Run `npm run build` from the app directory, then confirm `dist/` exists and
   is populated. If build hangs or fails because of sandbox worker/fork limits,
   retry once with `npx vite build`.
6. Run `npm run verify` when the sandbox supports worker/fork-heavy test
   runners. If verification cannot run because of sandbox limits, report that
   explicitly instead of treating the app as fully verified.
7. Manually test the built app in Roomy's sandboxed iframe, including each real
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

Start from fragments, not from `src/App.tsx`. A Roomy app must be composed from
focused fragments whenever it has distinct surfaces, reusable workflows, storage
contracts, or capability boundaries. `src/App.tsx` is for layout, routing,
coordination, navigation, and app-specific state wiring.

`src/App.tsx` must not contain the primary implementation of list, detail,
create, edit, search, import, export, preview, dashboard-card, chart, or form
surfaces when those surfaces could be fragments. It should import focused
fragment components and wire them together instead of duplicating or hiding
their UI.

Do not collapse a multi-surface app into one generic fragment named things like
`workspace`, `dashboard`, `main`, `home`, or `<app-name>-workspace`. A single
broad fragment that contains list, create, edit, detail, search, delete,
dashboard, or import/export behavior is the same architectural failure as
putting everything directly in `src/App.tsx`: Roomy cannot address, reuse,
inspect, or show those capabilities independently in chat.

Use one screen in `src/App.tsx` only for genuinely atomic utilities: trivial
calculators or simple displays with no storage-backed workflow, no meaningful
internal feature boundary, and no surface that would be useful directly in chat
or another app.

Use fragments for:

- Multiple user-facing views, such as list/detail, dashboard/cards, tabs, or
  list/add flows.
- Create/add/input surfaces, edit/update forms, focused detail views, and
  collection/list surfaces that can be useful on their own.
- Surfaces useful directly in chat messages, such as a chart, editor, preview,
  or focused form.
- Surfaces with different capability profiles, such as read-only view and
  write/import UI.

Fragment rules:

- Each fragment lives in `fragments/<name>/` and has `Component.tsx`,
  `main.tsx`, `index.html`, `roomy.fragment.json`, and `skill.md`.
- Fragment names must be **kebab-case** matching `^[a-z][a-z0-9-]{0,62}$`
  (lowercase letter, then letters/digits/hyphens). Underscores are not
  allowed — they break the serve-time URL matcher. Use `add-todo`, not
  `add_todo`; `yes-no`, not `yes_no`. Same constraint applies to the app
  directory name (`<name>.app`).
- Each real fragment must be listed in `roomy.app.json`; no unregistered real
  fragment should be left behind as dead code.
- The fragment's `Component.tsx` is the only implementation of that surface.
  The full app imports it; do not duplicate code under `src/`.
- A fragment must render standalone. Do not import `src/App.tsx` or depend on a
  full-app-only store from fragment code.
- Any standalone fragment meant to open a specific record, detail view, editor,
  filtered list, chart slice, or search result must declare the necessary
  `params` in `roomy.fragment.json` (for example `note_id`, `task_id`, or
  `query`) and read them from `new URLSearchParams(window.location.search)`.
  Do not ship record-specific fragments that silently select the first stored
  record when no param is supplied; render an empty/select state instead. The
  `skill.md` must document these params so agents can attach the fragment with
  concrete `--param key=value` values from chat.
- If the user asks to show a specific record, the fragment should display that
  record directly; do not turn the fragment into a generic list with no targeted
  selection and then let chat fill in the record text.
- Keep ordinary reusable UI pieces in `src/components/`.

Examples:

- Note app: `notes-list` for search/filter/select, `new-note` or `note-create`
  for creation, `note-editor` for edit/save/delete, and optionally
  `note-detail` for read-only display. Do not ship this as one
  `notes-workspace` fragment unless the user explicitly asks for a monolithic
  surface.
- Todo tracker: `todo-list`, `add-todo`, and `todo-detail` fragments when those
  surfaces exist.
- Dashboard: separate chart, card, summary, table, and filter fragments when
  each surface is useful standalone in chat.
- Trip planner: `itinerary`, `expenses`, and `packing-list` fragments.
- Unit converter with no history/storage: one `src/App.tsx`, no real fragments.

## Directory Map

```text
<name>.app/
  package.json
  vite.config.ts
  index.html
  roomy.app.json
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
      roomy.fragment.json
      skill.md
  dist/
```

`vite.config.ts` already builds `index.html` plus every
`fragments/*/index.html` entry and sets `base: './'` for iframe-safe relative
assets.

## Persistent app storage

Use Roomy storage for records that must survive refreshes, app reloads, chat
artifact promotion, future editing sessions, or movement between clients such
as desktop and phone. Browser storage is only for disposable UI cache.

Roomy storage is exposed to app code through `window.roomy.storage`; use the
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

Roomy currently backs app storage with `.storage/data.sqlite` inside the app
directory, so it travels with the `.app/` when Roomy promotes or replaces the
app. Cross-device availability depends on Roomy syncing app storage, not on
browser-device-local storage.

Storage-backed UI must handle loading and errors. Do not call storage at module
scope or unguarded during render; use effects, event handlers, or explicit async
actions with error handling.

## Posting back to the chat

Use `window.roomy.chat.sendMessage(text, opts?)` to bubble a user choice back
into the chat as a new user message — the agent reads it on its next turn.
Required for any fragment that asks the user a question via UI controls
(yes/no, radio, checkbox, form) instead of expecting a free-text reply.

```ts
await window.roomy.chat.sendMessage('Yes')
await window.roomy.chat.sendMessage('Yes', { artifactRefMessageId: '<msgId>' })
```

Rules:

- Declare `chats.write` in both `roomy.app.json` and the calling fragment's
  `roomy.fragment.json`. Without it the bridge rejects the call.
- `text` is a plain string (≤ 4000 chars). It lands in the chat exactly as
  typed — keep it short and structured. For a yes/no question, send `"Yes"`
  or `"No"`. For multi-select, send a single line like `"red, blue"`.
- After the call resolves, disable the affected UI controls and show a
  small "Submitted: …" line so the user sees their choice was recorded.
  Don't allow re-submission within the same iframe lifetime; if the user
  reloads the chat the fragment re-mounts and that's expected.
- Read fragment props (e.g. the question text) from
  `new URLSearchParams(window.location.search)`. Declare them in
  `roomy.fragment.json` `params`.

This bridge is only for chat replies. Anything else (storing records,
reading files) still goes through the storage bridge or workspace-scoped
APIs.

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

Never mock `window.roomy.storage`, `getStorageClient()`, or any Roomy capability
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
- `fragments/example/` has been removed, and `roomy.app.json` does not reference
  any example fragment.
- Every real fragment has `Component.tsx`, `main.tsx`, `index.html`,
  `roomy.fragment.json`, `skill.md`, registration in `roomy.app.json`, a built
  standalone entry, and manual coverage of its main flow.
- Multi-surface apps are decomposed into focused fragments. If the app has only
  one real fragment, verify that it is truly atomic rather than a generic
  workspace fragment hiding multiple capabilities.
- The full app imports fragment components instead of reimplementing their UI,
  and `src/App.tsx` is mostly composition, layout, navigation, and shared state
  coordination.
- The built full app works inside an iframe with
  `sandbox="allow-scripts allow-forms"` and no `allow-same-origin`.
- Every real standalone fragment entry loads and its main flow works.
- Storage-backed flows create, read, update, delete, refresh, and still show the
  expected data through Roomy storage.
- The app has no leftover example-fragment UI unless explicitly requested.

## UI Library

Use `@roomy-ai/ui` components before adding new UI dependencies. Browse the
exports in `node_modules/@roomy-ai/ui/dist/index.d.ts`. Common exports include
`Button`, `Input`, `Dialog`, `DropdownMenu`, `Card`, `Tabs`, and `Sheet`.

If a primitive is missing, build a small local component in `src/components/`
instead of installing another component library.
