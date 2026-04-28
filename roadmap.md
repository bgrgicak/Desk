# Roadmap — Desk app-prototype, private-beta cut

## Context

The next milestone for `packages/app-prototype` is a **design-partner / private
beta**: real users hitting it daily. The bar shifts from "demo well" to "hold up
under real workflows." This roadmap is built on a feature audit (below) plus
explicit user priorities: fix the two highest-pain mocks, ship Google Drive +
GitHub connections first, and build out agent autonomy and sharing.

## Current state — feature audit

Status: **REAL** = wired to `packages/server`; **MOCK** = local simulator;
**HYBRID** = part real, part placeholder.

### Real
- Chat (send/receive, history, WS push) — [App.tsx:30](packages/app-prototype/src/App.tsx#L30)
- Desk artifact gallery
- Tasks board + calendar — *modeled as `messages` with `kind=task`* — [App.tsx:187](packages/app-prototype/src/App.tsx#L187)
- Context Library (full CRUD: upload, folder, link, move, delete)
- Global command palette (`/api/search`, scoped)
- Settings: profile, password, agents, workspaces, models
- Auth (bearer tokens, `/api/me` boot check)
- Real-time WS at `/ws` with reconnect

### Mock / hybrid
- **Today/Inbox reply** — list is real, reply UX is `useMockChat` — [TodayInbox.tsx:380](packages/app-prototype/src/components/today/TodayInbox.tsx#L380)
- **Artifact Conversation tab** — `useMockChat`, doesn't reach the model — [ConversationPanel.tsx](packages/app-prototype/src/components/artifact/ConversationPanel.tsx)
- **Connections** — only Claude + ChatGPT keys are real; Drive/Notion/GitHub/Slack/Figma/Linear/Web Clipper are stub catalog entries — [connections.ts](packages/app-prototype/src/data/connections.ts)

## Roadmap themes

Ordered by priority for the private-beta milestone.

### 1. Make real — kill the embarrassing mocks
*Goal: every visible reply field actually answers.*

- **R1.1 Inbox reply uses real chat backend.** Swap `useMockChat` in [TodayInbox.tsx](packages/app-prototype/src/components/today/TodayInbox.tsx) and [TodayDetailPanel.tsx](packages/app-prototype/src/components/today/TodayDetailPanel.tsx) for `usePostChatMessageMutation` against the inbox item's chat. Keep optimistic UI.
- **R1.2 Artifact Conversation tab uses real chat.** Same swap in [ConversationPanel.tsx](packages/app-prototype/src/components/artifact/ConversationPanel.tsx); decide whether the conversation lives in the originating chat or its own thread (likely originating chat, scoped by artifact reference).
- **R1.3 Delete `use-mock-chat.ts`** once unreferenced.

### 2. Connections — Drive + GitHub
*Goal: two real third-party integrations the beta cohort will actually use.*

- **C2.1 Google Drive** — OAuth flow, server-side token storage alongside `/me/providers`, file picker that ingests selected files into the existing Library entity (reuse `/api/library` rather than inventing a parallel store), and "drive://" reference type so chats can attach without copying.
- **C2.2 GitHub** — App install or PAT, repo/issue picker, surface as Library entries, plus a `kind=issue` message variant so issues can flow through Today/Inbox like tasks already do.
- **C2.3 Connections shell** — promote `/me/providers` into a generic connection store so adding the next 5 doesn't require schema changes.

### 3. Agent autonomy & scheduled runs
*Goal: agents that do work without a user prompt.*

- **A3.1 Scheduled triggers** — let an agent run on cron (existing [packages/server/scheduler](packages/server/scheduler) is a likely home; verify before assuming) and post results as a regular chat message + Today/Inbox entry.
- **A3.2 Event triggers** — run on incoming events (e.g. a new GitHub issue, a new Drive doc). Reuses the WS event spine.
- **A3.3 Run history & output review** — every autonomous run produces a reviewable artifact + an awaiting-user state when human input is needed.
- **A3.4 Tasks-as-first-class** prerequisite check — recurrence, dependencies, and "this task is owned by an agent" all rub against the current `messages.kind=task` modeling. Decide early whether to lift Tasks into a real table or extend message metadata; the answer shapes A3.

### 4. Sharing & collaboration
*Goal: a beta user can show their work to a colleague.*

- **S4.1 Read-only artifact share links** — signed URLs, expirable, no login required for the recipient.
- **S4.2 Workspace invites** — email invite → joiner gets scoped access to a workspace's chats/artifacts/library.
- **S4.3 Per-resource permissions** — chat-level and artifact-level visibility (private / workspace / shared link).
- **S4.4 Comments on artifacts** — async feedback without polluting the chat thread.

### 5. Proposed net-new (private-beta-critical, not yet on the list)

- **N5.1 Notifications & digest** — beta users will not keep the tab open. Email digest for awaiting-user messages; web-push for live ones. Today/Inbox is the natural source-of-truth.
- **N5.2 Onboarding & empty states** — first-run flow that walks a partner through: pick a model, connect Drive, upload one library file, run their first agent. Today the empty workspace gives no scaffolding.
- **N5.3 Workspace memory** — long-lived facts the agent retains across chats (project context, preferences, glossary). Surfaced and editable in Settings.
- **N5.4 Usage visibility** — token + cost per workspace/agent/chat; design partners ask within week one when they're using their own API keys.
- **N5.5 Templates / prompt library** — reusable starting prompts and agent recipes; lowers cold-start cost for new partners.

### 6. Beta-readiness polish (cuts across themes)

- Error states + retry UX for every RTK Query surface (today many fail silently)
- Server-side rate-limit / quota signaling surfaced in the UI
- Audit log of what an agent did on the user's behalf (especially with connections)
- Basic observability for the server (latency + error rates per endpoint) so we know what beta users hit
- Test coverage parity per `AGENTS.md`: each new real surface gets an integration test against real Postgres + real Anthropic, not just unit tests

## Suggested sequencing (rough, not contractual)

1. **Sprint 1–2**: Theme 1 (Make real) + N5.2 (Onboarding) + start C2.3 (Connections shell).
2. **Sprint 3–5**: C2.1 (Drive) and C2.2 (GitHub) in parallel; N5.1 (Notifications) lands alongside since both want a server-side trigger story.
3. **Sprint 6–8**: A3.1/A3.2 (Scheduled + event triggers) building on the trigger infra from N5.1; decide on A3.4 (tasks model lift) before this work starts.
4. **Sprint 9–10**: S4 (Sharing) + N5.4 (Usage) + N5.3 (Workspace memory).
5. **Throughout**: Theme 6 polish — done as the price of admission for each shipped feature, not a separate phase.

## Critical files / surfaces to touch

- [packages/app-prototype/src/hooks/use-mock-chat.ts](packages/app-prototype/src/hooks/use-mock-chat.ts) — to be deleted (Theme 1)
- [packages/app-prototype/src/components/today/](packages/app-prototype/src/components/today/) — Inbox reply real-ification
- [packages/app-prototype/src/components/artifact/ConversationPanel.tsx](packages/app-prototype/src/components/artifact/ConversationPanel.tsx)
- [packages/app-prototype/src/data/connections.ts](packages/app-prototype/src/data/connections.ts) — connection catalog grows, plus per-kind config
- [packages/server/api/src/routes/](packages/server/api/src/routes/) — new routes for Drive, GitHub, triggers, sharing
- [packages/server/scheduler](packages/server/scheduler) — verify shape before placing scheduled-run work
- [packages/server/api/src/ws/](packages/server/api/src/ws/) — extend for trigger events

## How we'll know we hit the bar

The private-beta milestone is met when:
- A new design partner can sign in, connect Drive *or* GitHub, run an agent on real data, receive an emailed digest of awaiting-user items, and share an artifact link with a colleague — without anyone on the team intervening.
- No surface in the app uses `useMockChat` or stub connection data.
- The team has dashboards showing per-endpoint error rate and per-workspace token usage so we can see what beta users hit before they tell us.
