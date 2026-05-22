# ADR-0003: Workspace memory as a special Library entry kind

**Status**: Accepted (2026-05-18)
**Roadmap**: N5.3 (Workspace memory)

## Context

"Workspace memory" — long-lived facts the agent retains across
chats — has three plausible homes:

1. **A `workspace_memory` table** keyed by `workspace_id` with one
   row per fact.
2. **A special Library entry** kind, with the same retrieval +
   editing surface as any other Library content.
3. **In-system-prompt only**: facts stored in the agent's system
   prompt template; no persistence.

Forces:
- The user must be able to inspect and edit memory directly from
  Settings or the Library — option (3) is opaque to them.
- The agent already reads from the Library on every turn (RAG
  retrieval); option (2) reuses that path and doesn't add a new
  context-injection mechanism.
- (1) duplicates the Library's existing affordances (versioning,
  edit history, FTS) for a single new entity.

## Decision

Workspace memory is a Library entry with `kind='memory'`. Existing
Library affordances apply (edit, version, search). The agent's
system prompt injects every `kind='memory'` entry's content
verbatim, capped at a configurable byte budget so a runaway memory
doesn't eat the context window.

## Consequences

- Zero new tables. The Library FTS index covers memory entries
  for free.
- The agent prompt template grows a templated section listing
  every memory entry; cap enforced server-side at
  `ROOMY_WORKSPACE_MEMORY_MAX_BYTES` (default 8KB).
- "Forget this fact" maps to deleting the Library entry.
- The Library UI gains a memory filter so users can see only
  facts the agent will inject.

## Alternatives considered

Option (1) was rejected on table-duplication grounds.
Option (3) was rejected on inspect/edit grounds — users explicitly
want to see and revise what the agent knows.

## Reversal cost

If a per-workspace cap of 8KB ever proves too small for a real
workflow, the next step is to switch from "inject all memories
verbatim" to "RAG-retrieve relevant memories" using the same
Library retrieval path that already works for arbitrary content.
No schema migration needed.
