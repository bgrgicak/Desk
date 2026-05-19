# ADR-0002: Generic connection store keyed by (user_id, kind)

**Status**: Accepted (2026-05-18)
**Roadmap**: C2.3 (Connections shell)

## Context

The roadmap lands Google Drive + GitHub + Notion + Slack +
Figma + Linear + Web Clipper. The current state has two parallel
storage paths:

1. `/me/providers` — single env-var-shaped credential per provider
   (Anthropic, OpenAI, GitHub PAT). Stored in the per-user KDBX
   vault.
2. `connector_connections` — multi-account rows for connectors
   that support multiple accounts (a user with two Slack
   workspaces).

Adding integration #6 with the current shape requires either: a
new table (path 1) or a new column on the connections row (path
2). Both ossify the schema around the *specific* integrations that
exist today.

## Decision

Promote `connector_connections` into the canonical store. Every
integration — including the legacy single-key ones — registers a
typed Zod schema for its credentials payload, validated at the API
boundary.

```ts
// shared/src/connectors.ts (target shape)
const ConnectorSchemas = {
  github: z.object({ token: z.string(), scope: z.array(z.string()) }),
  drive:  z.object({ refreshToken: z.string(), accessToken: z.string(), expiresAt: z.string() }),
  notion: z.object({ accessToken: z.string(), workspaceId: z.string() }),
  // …
} as const;
```

Each kind's credentials live in the per-user vault as a single
KDBX entry; the connector row holds the metadata
(`provider_id`, `display_name`, `external_account_id`, `scopes`,
`status`, `is_default`) but not the secret.

## Consequences

- Adding a new integration is: (a) one entry in `ConnectorSchemas`
  (b) one OAuth/PAT capture flow (c) optional UI affordance in
  Settings. No schema migration.
- `/me/providers` becomes a thin shim that proxies into the same
  store using a synthetic kind. Existing API shape preserved.
- The vault unlock requirement now gates every integration the
  same way — `vault.unlock` is the single bottleneck on first
  use.
- Errors surface uniformly: a connector with a stale/refresh-
  required token returns the same `{code: "CONNECTOR_REAUTH",
  ...}` shape regardless of provider.

## Alternatives considered

Per-kind subtables (`drive_connections`, `github_connections`, …)
were rejected on the schema-migration cost above.

A typed-column-per-kind on a single table (`drive_token TEXT`,
`github_token TEXT`, …) was rejected on the "adds a column per
integration" anti-pattern.

## Reversal cost

If a kind's credential shape outgrows JSON-in-vault (large blobs,
binary data), lift just that kind into its own table; the typed
schema in shared/ is the contract that keeps the rest of the code
unaware of the storage move.
