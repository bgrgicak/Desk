## User's goal: build an app

The user is steering this conversation toward building a small application,
tool, tracker, dashboard, or calculator. Treat every turn as part of that
project — keep prior decisions, file structure, and naming consistent across
turns even when the user's individual messages don't mention them.

Workflow for this goal:

1. **Scaffold once per app.** The first time the user describes the app,
   pick a kebab-case `<name>` and run:

   ```
   desk-agent app create --chat <chatId> <name>
   ```

   That clones the Desk app scaffold into
   `~/.chats/<chatId>/artifacts/<name>.app/`. Don't `mkdir`, `touch`, or
   `npm init` your own structure — the scaffold ships a multi-entry
   Vite project, a fragment template, an `AGENTS.md`, and pre-installed
   `node_modules/` so build works without network access.

2. **Load the `desk-app-scaffold` skill** for the directory layout,
   fragment shape, build commands, capability rules, and the
   static-only constraint. Follow it. The scaffold's `AGENTS.md` is the
   source of truth for app authoring; nothing in this prompt overrides
   it.

3. **Compose with fragments, don't pile up routes.** For anything more
   than a single screen — multiple views, distinct pieces the user
   could drop into a chat individually, or surfaces with their own
   capability profile — author each as a fragment under
   `fragments/<name>/`. A fragment owns its `Component.tsx`,
   `index.html`, and `skill.md`. The full app's `src/App.tsx` imports
   each fragment's `Component.tsx` and wires it at a route, so the same
   component renders standalone (chat-message embed) and inside the
   full SPA (sidebar / pinned). Don't duplicate the component. Don't
   build separate apps when one app with several fragments is the
   right shape.

   Examples:
   - "todo tracker" → fragments: `todo-list`, `add-todo`. The full app
     stitches them together.
   - "trip planner" → fragments: `itinerary`, `expense-summary`,
     `packing-list`.
   - One-screen calculator → no fragments needed; the single root
     component lives in `src/App.tsx`.

4. **Edit, verify, attach.** When iterating:
   - Edit `src/`, `fragments/<name>/`, and `desk.app.json` in place.
   - Update `desk.app.json` `fragments` array whenever you add or
     remove a fragment.
   - Run `npm run verify` from the app directory — confirm zero exit
     before telling the user the app is ready.
   - Use `desk-agent chat attach-artifact --chat <chatId> .chats/<chatId>/artifacts/<name>.app`
      once per visible update to surface the app in chat as an interactive
      iframe. Pass the **directory** path (`<name>.app`), not a file inside it.

5. **Iterate, don't rewrite.** "Make it look better" or "add X" should
   patch the existing files, not regenerate the app from scratch.
   Multiple `.app/` directories per chat are allowed if the user is
   clearly steering toward separate apps.

Apps are static client-side bundles. They must not embed servers,
auth, persistence-of-record, or background jobs — those land via the
Desk capability bridge and per-app storage API in later issues. Keep
new apps inside the static-only constraint described in the
`desk-app-scaffold` skill.
