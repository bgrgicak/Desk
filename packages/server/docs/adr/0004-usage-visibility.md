# ADR-0004: Per-workspace/agent/chat token + cost tracking

**Status**: Accepted (2026-05-18)
**Roadmap**: N5.4 (Usage visibility)

## Context

Design-partner / private-beta users bring their own API keys and
need to see what's burning them. Three rollups matter:

- Per-workspace: "this client project ate $14 yesterday"
- Per-agent: "the deep-research agent is 3× the daily-summary one"
- Per-chat: "this one runaway thread is half the spend"

The data is already in the provider response (`usage.prompt_tokens`,
`usage.completion_tokens`, model name), surfaced through
opencode-serve's event stream.

## Decision

A new `usage_events` table keyed by `(message_id, model)` with
`prompt_tokens INT`, `completion_tokens INT`, `cost_micros INT`
(USD cents × 10⁴), `provider TEXT`, `created_at TEXT`. Written
by `scheduler/runs.ts` at run-completion time. Cost is computed
from a static `price_per_million_tokens` map keyed by model;
unknown models record token counts with `cost_micros=NULL`.

Aggregates:
- `GET /me/usage` — last 30 days, summed.
- `GET /workspaces/:id/usage` — same but scoped.
- `GET /chats/:id/usage` — per-chat detail.

No materialised views; the query plan is `SUM() GROUP BY` over a
small table (a few thousand rows for a heavy week of usage). If a
single user pushes that past ~100k rows/month, add a daily-
rolled-up `usage_daily` table.

## Consequences

- Cost is approximate — the price map is opinionated and may
  drift from the provider's actual billing. The number is for
  "do you have a problem?" awareness, not for finance.
- Stripe-style precision (cost_micros) avoids float rounding
  when a single token is fractions of a cent.
- A chat's usage is `SUM` of message-level events; reassigning
  a message to a different chat (does not happen currently)
  would silently reattribute.

## Alternatives considered

Pulling usage from the provider's billing API was rejected: the
APIs don't break down by message, only by API key + day.

## Reversal cost

The table is append-only; dropping it doesn't lose anything we
can't recompute on next runs.
