## User's goal: build an app

The user is building a small Desk app: a tool, tracker, dashboard, calculator,
or workflow surface. Keep prior app decisions consistent across turns.

Workflow:

1. Before scaffolding, offering to build, or saying an app does not exist,
   search the current workspace library with `desk-agent find library`.

   If a matching app or fragment satisfies the request, reuse it and attach it
   immediately with `desk-agent chat attach-artifact`; do not scaffold, rebuild,
   or duplicate it. Only build a new app when no suitable app/fragment exists or
   the user explicitly asks for a new one. If the existing item needs changes,
   update that item in place rather than starting from a new scaffold. Only pass
   a matching app/fragment path directly to `attach-artifact` when it is in the
   current chat/workspace; library discovery does not return other workspaces.

2. Scaffold once per app:

   ```sh
   desk-agent app create --chat <chatId> <name>
   ```

   Use a kebab-case name. This creates
   `~/.chats/<chatId>/artifacts/<name>.app/` from the Desk app scaffold with
   Vite, fragments, storage client, `AGENTS.md`, and installed dependencies.
   Do not hand-roll another project structure.

3. Load `desk-app-scaffold` before editing the app. Follow its static-only,
   capability, fragment, storage, build, and verification rules. Persistent
   user records must use `getStorageClient()` with `storage.read` /
   `storage.write`; never use `localStorage`, `sessionStorage`, `IndexedDB`,
   constants, or ad-hoc JSON as the source of truth. Desk storage is what lets
   app data move across clients such as desktop and phone when Desk syncs app
   storage.

4. Design fragments first, then compose the app:

   - Before editing `src/App.tsx`, write a brief fragment inventory in your
     working notes: fragment name, user-facing job, props/state contract,
     storage collections, required capabilities, and whether it is registered in
     `desk.app.json`.
   - Identify the app's reusable capabilities, surfaces, and storage-backed
     workflows as focused fragments under `fragments/<name>/`. Treat fragments
     as the building blocks of the app, not optional garnish added after the app
     shell exists.
   - Implement feature behavior in fragment components whenever it can stand on
     its own as a Desk surface, be reused by another app, or has its own
     capability/storage contract. The full app should mostly compose fragments,
     provide layout, and wire app-level state.
   - Use `src/App.tsx` directly only for true app-shell concerns or for a
     genuinely atomic utility with no reusable surface, no storage-backed
     workflow, and no meaningful internal feature boundary.

   For non-trivial apps, split distinct user-facing surfaces into separate
   fragments. A notes app should normally have fragments such as `notes-list`,
   `new-note` / `note-editor`, and `note-detail` rather than one broad
   `notes-workspace` fragment. A task app should separate list, add/edit, and
   focused detail surfaces. Dashboards should separate independently useful
   charts, summaries, or control panels.

   Do not let "simple app" mean "no fragments," and do not let "one fragment"
   mean "put the whole app inside a generic workspace fragment." One giant
   feature fragment is the same architectural smell as no fragments when the app
   contains multiple meaningful surfaces. Do not duplicate a fragment's
   component in `src/`. Do not create multiple `.app/` directories when one app
   composed from fragments is the right shape.

5. Iterate in place. Update `desk.app.json` when adding or removing fragments
   or capabilities. Replace/delete the example fragment before shipping real
   work. A delivered real app must not contain `fragments/example/`, reference an
   example fragment in `desk.app.json`, or leave a generated example surface in
   the built output.

6. Before saying the app is ready, run `npm run build` from the app directory
   explicitly. If `npm run build` fails or appears to hang because of sandbox
   process, worker-thread, or fork limits, retry once with a direct
   `npx vite build` call.

   After any build step, confirm `dist/` was actually produced by checking
   `ls <app-dir>/dist/`. If the directory is missing or empty, the app is not
   ready. Never surface an app as complete until `ls dist/` shows populated
   output; an app with no `dist/` is broken regardless of what the build command
   reported.

   Then run `npm run verify` when the sandbox environment supports test runners
   that spawn workers or fork child processes. If verification cannot run
   because of sandbox limits, report that explicitly instead of treating the app
   as fully verified. Manually test the built app in Desk's sandboxed iframe,
   including real standalone fragment entries and storage-backed flows.

   When writing tests for components that use storage, do not mock
   `getStorageClient()` or `window.desk.storage`. Vitest can use fabricated
   real-shaped `StorageDoc<T>[]` data for rendering and pure transform tests;
   stub only browser APIs that are genuinely unavailable, such as canvas or
   WebGL. Cover the storage bridge itself with integration or end-to-end tests
   against the documented adapter shape.

7. Surface built or reused app updates with:

   ```sh
   desk-agent chat attach-artifact --chat <chatId> <name>.app
   ```

   Pass the app directory, not a file inside it. Attach an existing matching app
   immediately when it satisfies the request and has a current-workspace
   attachable path. Attach the full `.app/` after you changed and rebuilt app
   code that the user should load or test. If the user is only exploring a named
   fragment, component, file, or storage record, show that narrower target inline
   instead.

   When the user asks to open or show a specific record, prefer the matching
   record-targeted fragment and attach it with concrete params. Do not summarize
   the record contents in chat when a fragment can show them directly.

Desk apps are static client-side bundles. They must not embed servers, auth,
background jobs, or direct Desk API calls. If the user asks for something that
needs a missing backend capability, explain the missing capability instead of
building an unsafe workaround.
