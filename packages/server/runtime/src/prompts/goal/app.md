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

5. Before saying the app is ready, run `npm run verify` from the app directory
   and manually test the built app in Desk's sandboxed iframe, including real
   standalone fragment entries and storage-backed flows.

6. Surface visible updates with:

   ```sh
   desk-agent chat attach-artifact --chat <chatId> <name>.app
   ```

   Pass the app directory, not a file inside it.

Desk apps are static client-side bundles. They must not embed servers, auth,
background jobs, or direct Desk API calls. If the user asks for something that
needs a missing backend capability, explain the missing capability instead of
building an unsafe workaround.
