# Multi-workspace library-app URLs (issue #47 follow-up)

## Context

PR-E (`feat/chat-apps-pr-e-library-promotion`, #71) introduced library-scope app serving with the URL shape:

```
GET  /apps/library/:appName/dist/*
POST /apps/library/:appName/issue
```

The server picks the user's workspace via `workspaceForUser(pool, userId)` which selects the oldest workspace owned by the user. That works for single-workspace deployments and is what's currently shipped.

The same-name-app-across-workspaces edge case was flagged in the PR-E review: if a user has `foo.app/` in two workspaces, both library cookies are sent to the same path scope (`/apps/library/foo/dist`), and the handler picks the first matching cookie by JS iteration order. The session-row workspaceId check prevents cross-workspace authority leakage, but the user can see "the wrong workspace's foo.app" served, which is a UX surprise.

This document plans the URL redesign that lets the URL itself disambiguate.

## Target URL scheme

```
GET  /apps/library/:workspaceId/:appName/dist/*
POST /apps/library/:workspaceId/:appName/issue
GET  /apps/library/:workspaceId/:appName/storage/:collection
POST /apps/library/:workspaceId/:appName/storage/:collection
... etc.
```

Cookie name stays as `desk_libapp_<workspaceId>_<appName>` (already encodes workspaceId, so the change is URL-only).

## Server changes

1. **`packages/server/api/src/routes/apps.ts`**
   - `issueLibraryAppSession(pool, storage, userId, workspaceId, appName)` — verify user owns the workspace via `requireOwnedWorkspace(pool, userId, workspaceId)` before resolving the dist path.
   - `handleIssueLibraryAppSession` — extract `workspaceId` from URL.
   - `handleStaticLibraryAppRequest` — parse `segments[2] = workspaceId`, `segments[3] = appName`, `segments[4] = "dist"`. Drop the cookie-prefix-walking trick (we know the workspaceId from the URL now); look up the cookie by exact name.
   - `resolveLibraryAppDist` — already takes `workspaceSlug`; no change beyond the new caller signature.

2. **`packages/server/api/src/app.ts`** dispatcher
   - Library-scope segment count goes from `>= 3` to `>= 4`.
   - `segments[2] = workspaceId`, `segments[3] = appName`.
   - Same updates for app-storage dispatcher.

3. **`packages/server/api/src/routes/app-storage.ts`**
   - Library route match: `segments[0]=apps && segments[1]=library && segments[3]=storage` (workspaceId at `segments[2]`, appName at … wait, this needs the full redesign). Adjust to the new URL shape.
   - `resolveLibraryStorage` — verify the workspaceId in URL matches the cookie's workspaceId (defense in depth).

## SPA changes

1. **`packages/app/src/components/context/AppPreview.tsx`**
   - `AppPreviewProps`: library scope gains `workspaceId: string`.
   - `issueAppSession`: library URL becomes `/apps/library/${workspaceId}/${appName}/issue`.
   - Bootstrap URL rewrite (fragment case) still concatenates `dist/fragments/<name>/`.

2. **Library list / `appAttachmentToPreview`**
   - Library items already live within a workspace context. The path parser returns `appName` only; the workspaceId comes from the active-workspace selector in the SPA. Either:
     - Thread `workspaceId` through `appAttachmentToPreview`, or
     - Leave the parser shape unchanged and require callers to supply `workspaceId` separately when constructing `AppPreviewProps`.

3. **Pinned-sidebar / message-embed call sites** — pass `workspaceId` from the active-workspace context.

## Migration notes

- The cookie name doesn't change → existing tokens stay valid.
- Old URL `/apps/library/<appName>/...` returns 404 after this lands. Acceptable for a prototype; stage by either soft-deprecation (server-side fallback to "primary workspace") or coordinated SPA + server deploys.

## Tests to add / update

- `library-app-promotion.integration.test.ts` — every `POST /apps/library/<APP_NAME>/issue` becomes `POST /apps/library/<WORKSPACE_ID>/<APP_NAME>/issue`. Add a "deny when user doesn't own workspace" test.
- `app-storage.integration.test.ts` — same URL update for library-scope cases.
- New: cross-workspace replay test — issue token for workspace A's `foo.app`, send the cookie back at workspace B's URL → 401.

## Out of scope

- Multi-workspace UX in the SPA (active-workspace switcher, library-list grouping).
- Workspace-aware navigation in the main app shell.

These should land separately once the URL redesign exposes the right primitives.
