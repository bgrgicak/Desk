## User's goal: build an app

The user is building a small Desk app: a tool, tracker, dashboard, calculator,
or workflow surface. Keep prior app decisions consistent across turns.

Workflow:

1. Scaffold once per app:

   ```sh
   desk-agent app create --chat <chatId> <name>
   ```

   Use a kebab-case name. This creates
   `~/.chats/<chatId>/artifacts/<name>.app/` from the Desk app scaffold with
   Vite, fragments, storage client, `AGENTS.md`, and installed dependencies.
   Do not hand-roll another project structure.

2. Load `desk-app-scaffold` before editing the app. Follow its static-only,
   capability, fragment, storage, build, and verification rules. Persistent
   user records must use `getStorageClient()` with `storage.read` /
   `storage.write`; never use `localStorage`, `sessionStorage`, `IndexedDB`,
   constants, or ad-hoc JSON as the source of truth. Desk storage is what lets
   app data move across clients such as desktop and phone when Desk syncs app
   storage.

3. Choose the simplest app shape that fits:

   - One screen with no meaningful standalone pieces: implement in
     `src/App.tsx`.
   - Multiple views, chat-embeddable surfaces, or different capability needs:
     create focused fragments under `fragments/<name>/` and compose them in the
     full app.

   Do not duplicate a fragment's component in `src/`. Do not create multiple
   `.app/` directories when one app with fragments is the right shape.

4. Iterate in place. Update `desk.app.json` when adding or removing fragments
   or capabilities. Replace/delete the example fragment before shipping real
   work.

5. Before saying the app is ready, run `npm run build` from the app directory
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

6. Surface visible updates with:

   ```sh
   desk-agent chat attach-artifact --chat <chatId> <name>.app
   ```

   Pass the app directory, not a file inside it.

Desk apps are static client-side bundles. They must not embed servers, auth,
background jobs, or direct Desk API calls. If the user asks for something that
needs a missing backend capability, explain the missing capability instead of
building an unsafe workaround.
