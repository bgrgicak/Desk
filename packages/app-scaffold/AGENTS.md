# Desk app scaffold — agent instructions

This directory is the template for an agent-authored Desk app. When
`desk-agent app create <name>` runs, this whole tree is copied into
`~/.chats/<chatId>/artifacts/<name>.app/` (or, after promotion, into
`~/<name>.app/`). Anything you write here ends up inside a chat artifact.

## Architectural rules (these are not negotiable)

1. **Static-only.** A Desk app is a pure client-side static site. Build
   produces `dist/` and that's it. No Express, no Hono, no Node server,
   no SSR, no per-fragment HTTP endpoints, no background jobs, no
   webhooks. The only backend is the Desk API.

2. **Identity comes from Desk.** Don't author your own auth. The
   capability bridge injects identity at iframe load time and mediates
   privileged operations from the parent Desk app.

3. **No direct persistence.** Don't write to `localStorage` or
   `IndexedDB` as a source of truth. Both are fine as caches. Real
   persistence goes through `src/storage/client.ts`, which calls
   `window.desk.storage` over the capability bridge.

4. **No backend creep.** If a feature seems to need a server, it's
   either:
   - already an existing Desk API endpoint — call that, OR
   - a missing capability — flag it to the user instead of inventing
     a sidecar.

5. **Sandboxed iframe.** Apps are served by `desk-server` at
   `/apps/library/<name>/dist/*` (library apps) or
   `/apps/chat/<chatId>/<name>/dist/*` (chat artifacts). Use relative
   paths in built assets — `vite.config.ts` already sets `base: './'`.
   Do not depend on same-origin browser APIs; the iframe runs without
   `allow-same-origin`.

6. **Components are the unit of reuse, fragments are the unit of
   embedding.** A fragment is a focused app surface that can be embedded
   directly in a chat message, such as a chart, form, preview, or task
   editor. Create one when that surface is useful outside the full app
   shell; keep ordinary subcomponents in `src/components/`. A fragment
   lives in `fragments/<name>/`, owns its `Component.tsx`, and exists in
   two render contexts: the full app imports it as a route, and the
   fragment's own `index.html` mounts it standalone for chat-message
   embedding. Same component source, two render contexts. **Don't
   duplicate the component.**

## When to split into fragments

Reach for a fragment any time a piece of the app could plausibly stand
on its own in the chat — both as a way for the agent to drop just that
surface into a message, and as a way to author + reason about each
part independently.

Heuristics:

- **One screen with no internal navigation** → no fragments. Put the
  whole UI in `src/App.tsx`. Trivial calculators, single-form tools,
  and "show me X" displays fit here. The example fragment can stay
  as a placeholder while you build, but delete it before you ship.
- **Multiple views the user navigates between** (list + detail, list +
  add-form, dashboard with cards that drill in) → one fragment per
  view. The full app composes them via `react-router-dom` routes;
  the fragment-standalone build embeds the same view by itself.
- **Surfaces with different capability profiles** (a "view" fragment
  reads storage, an "import" fragment writes storage + library) →
  always split. Fragments declare capabilities individually in
  `desk.fragment.json`, and that's how the bridge can grant least
  privilege per surface.

### Concrete examples

- *"todo tracker"* → fragments: `todo-list` (read), `add-todo` (write).
  Full app shows the list with the add form below; standalone, the
  list and the form each work as their own chat-message embed.
- *"trip planner"* → fragments: `itinerary`, `expenses`,
  `packing-list`. The full app is a tabbed shell over the three;
  each fragment is shareable on its own.
- *"daily mood log"* → fragments: `today-entry`, `history-chart`.
- *"unit converter"* → no fragments; one `src/App.tsx` is enough.

### Don't do this

- **Don't build two `.app/` directories** for what's really one app
  with two screens. The user has to install + open + reason about
  each `.app/` individually; collapse them into one app with two
  fragments instead.
- **Don't duplicate component source** between `fragments/<a>/` and
  `src/`. The fragment's `Component.tsx` is the only render of that
  surface; the full app imports it.
- **Don't depend on the full app from inside a fragment.** Fragments
  must be standalone-renderable (mounted at `#root` in their own
  `index.html`), so a fragment that imports `App.tsx` or hits a
  full-app-only Redux store breaks the standalone embed.

## Directory layout

```
<name>.app/
  package.json
  vite.config.ts            # multi-entry: index.html + each fragments/*/index.html
  index.html                # full-app entry
  desk.app.json             # app manifest (name, capabilities, fragments)
  src/
    main.tsx                # full-app bootstrap
    App.tsx                 # imports fragment components, wires routes
    index.css               # Tailwind entry; @import "@agent-desk/ui/styles.css"
    storage/client.ts       # shared Desk storage bridge client
  fragments/
    <fragment>/
      Component.tsx         # the actual UI — the only render of the component
      main.tsx              # standalone bootstrap (mounts Component at #root)
      index.html            # standalone entry
      desk.fragment.json    # name, description, capabilities
      skill.md              # how the agent should drive this fragment
  dist/                     # produced by `npm run build`
```

Every fragment must have `Component.tsx`, `main.tsx`, `index.html`,
`desk.fragment.json`, and `skill.md`. Vite's multi-entry config
discovers fragments by reading `fragments/*/index.html`.

## Develop and build

```
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run build        # vite build → dist/
npm run verify       # typecheck + tests + build
npm run dev          # local Vite dev (mainly for human verification)
```

The sandbox image already has Node 22, npm, and an offline-installed
`node_modules/`. Use `npm run verify` to verify your changes; you don't
need to `npm install` unless you're adding a new dependency.

## Test before responding

Write or update tests for every user-visible behavior change before you
implement the feature. Build success only proves the bundle compiles; it
does not prove the app behaves correctly.

Run `npm run verify` after editing the app and confirm it exits zero
before telling the user the app is ready. A verification failure is
something the user should never see surface as "the app is broken in the
iframe."

Vitest runs in Node. Prefer tests around pure data transformations,
capability/API adapters, and server-render smoke tests for app and
fragment composition. If a browser-only interaction needs manual
verification, still cover the state transition or validation logic with
an automated test.

## Fragment checklist

When adding a fragment, copy the shape of `fragments/example/`: create
`Component.tsx`, `main.tsx`, `index.html`, `desk.fragment.json`, and
`skill.md`; import the component from `src/App.tsx`; and add the fragment
name to `desk.app.json`.

## How to remove the example fragment

When you've written the real fragments:

Delete `fragments/example/`, remove the import and route from
`src/App.tsx`, remove `"example"` from `fragments` in `desk.app.json`,
and replace the scaffold smoke tests with tests for the real app.

The build won't fail with the example present, but leaving placeholder
content in shipped apps is sloppy.

## @agent-desk/ui

Components come from `@agent-desk/ui`. Browse what's available by
importing from the package — the export list is in
`node_modules/@agent-desk/ui/dist/index.d.ts`. Common entries: `Button`,
`Input`, `Dialog`, `DropdownMenu`, `Card`, `Tabs`, `Sheet`. Tailwind v4
classes work because the package ships its own `@source` directives.

Don't add a separate component library. If a primitive is missing,
build it locally in `src/components/` rather than installing a parallel
shadcn/ui or chakra/etc.

## Capability and API story

Desk apps run in a sandboxed iframe without same-origin privileges:

- Don't call Desk APIs directly from app code.
- Declare capabilities you intend to use in `desk.app.json`
  (`capabilities: ["storage.read", "storage.write"]`) so Desk can grant
  only the operations the app needs.
- Use `getStorageClient()` from `src/storage/client.ts` for persistence.
  It calls `window.desk.storage`, which is parent-mediated and capability
  checked.
