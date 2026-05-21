# ADR-0005: Read-only artifact share links, signed + expirable

**Status**: Accepted (2026-05-18)
**Roadmap**: S4.* (Sharing & collaboration)

## Context

The private-beta requirement: a user shares an artifact with a
colleague without inviting them to Desk. Three mechanisms:

1. **Signed URLs**: artifact URL embeds a token, expires at a
   timestamp, recipient hits the URL with no login.
2. **Per-resource ACLs**: artifact rows learn a `shared_with`
   column; recipient must have a Desk account to view.
3. **Workspace invites**: recipient gets full workspace access.

The roadmap calls for all three, but the unblocker for the beta
is (1) — colleagues are unlikely to install Desk just to read
one document.

## Decision

Phase one: signed read-only share links.

Schema (new): `artifact_shares` with `id`, `artifact_id`,
`workspace_id` (denormalised for cleanup speed), `created_by`,
`created_at`, `expires_at` (optional), `revoked_at` (nullable).

URL shape: `/share/:share_id`. Public path (no auth), bypasses
`requireAuth` like `/health` does. Handler verifies the share is
not expired or revoked, serves a read-only HTML view of the
artifact.

Authoring flow:
- `POST /artifacts/:id/shares { expires_at?, label? }` → returns
  `{ url, share_id }`.
- `DELETE /shares/:share_id` → revokes.

## Consequences

- Shares are per-artifact, not per-chat. Linking to a chat would
  require a separate flow (Phase two).
- The recipient sees what the artifact looked like at access
  time, not a snapshot — if the artifact gets edited, the share
  reflects the new content. (For "send a snapshot" semantics, the
  user takes a separate snapshot in the artifact's version
  history.)
- `expires_at IS NULL` means "no expiry"; the SPA defaults the UI
  to 7 days but accepts unbounded for power users.
- Cleanup: an `artifact_shares` row whose `artifact_id` is gone
  responds 410 Gone (and gets pruned on the next reaper run).
  Cascade-delete on artifact_id covers happy path.

## Alternatives considered

Workspace invites (Phase 3 of the roadmap) are deferred — they
need real account-management UX. Per-resource ACLs land alongside
them.

A JWT-based unsigned-shared-secret URL was rejected on
revocability: revoking a JWT after the fact requires a deny-list,
which is a row in the DB — at which point we're just storing
shares in a table.

## Reversal cost

The share-id is an opaque token; rotating the URL shape from
`/share/:id` to something else (e.g. `/s/:id`) requires only the
route renaming and a stub redirect on the old path.
