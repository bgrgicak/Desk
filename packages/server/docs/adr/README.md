# Architecture Decision Records

This directory holds Architecture Decision Records (ADRs) — short
documents that capture an architectural decision, the context that
produced it, and the consequences. Each ADR is immutable once
accepted: a new decision that supersedes an old one gets its own ADR
and the old one's status flips to **superseded by ADR-XXXX**.

ADRs live with the code they describe so the rationale doesn't drift
from the implementation; `packages/server/docs/adr/` is on the server
package because every ADR so far has been server-side. UI-side ADRs
would live next to whichever package they govern.

## Index

| # | Title | Status |
|---|---|---|
| [0001](./0001-tasks-as-messages.md) | Tasks live as messages.kind=task | Accepted |
| [0002](./0002-generic-connection-store.md) | Generic connection store keyed by (user_id, kind) | Accepted |
| [0003](./0003-workspace-memory.md) | Workspace memory as a special Library entry kind | Accepted |
| [0004](./0004-usage-visibility.md) | Per-workspace/agent/chat token + cost tracking | Accepted |
| [0005](./0005-sharing-model.md) | Read-only artifact share links, signed + expirable | Accepted |
| [0006](./0006-sqlite-scaling.md) | SQLite is single-node by design; the post-SQLite story | Accepted |

## Authoring

Use ADR-0001 as a template. Keep an ADR to one screen: title +
context (the forces in play) + decision (what we picked) +
consequences (what that costs).

Don't write ADRs for everything. Write them when a decision is:
- Hard to reverse later (schema shape, public API surface).
- Likely to surprise a new contributor.
- Made against a real alternative that someone might bring back up.
