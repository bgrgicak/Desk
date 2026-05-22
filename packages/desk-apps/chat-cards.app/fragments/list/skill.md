# list fragment

Renders 1..N cards stacked vertically (one per row). Use for text-heavy
result sets where reading a column beats a multi-column grid — articles,
papers, entity lookup, news, comparison summaries. For image-led results
(products, places, photos) the `grid` fragment usually scans better.

## Behavior

- Reads the URL `items` param (JSON-encoded array of card objects).
- Optionally reads a `title` param and renders it as a header above the
  list.
- Each item renders as a single Card stacked one per row:
  - `title` — optional. Hyperlinked when `link` is set; otherwise plain
    text.
  - `description` — optional.
  - `image` — optional URL. Rendered as a plain `<img>`.
  - `onClick` — optional. When present, the whole card body becomes
    clickable. `{ link }` opens the URL in a new tab; `{ reply }` calls
    `window.desk.chat.sendMessage(reply)`.
  - `actions` — optional array of buttons. Each is either
    `{ label, link }` or `{ label, reply }`. Actions stopPropagation so
    they don't double-fire with `onClick`.

## Capabilities

- `chats.write` — required for `reply` actions.

## Params

| Param   | Type   | Description                                                     |
|---------|--------|-----------------------------------------------------------------|
| `items` | string | JSON-encoded array of card objects (see schema below). Required. Must be non-empty. |
| `title` | string | Optional header rendered above the list.                        |

### Card schema

```json
{
  "title": "Tokio Tutorial 2026",
  "description": "Building async applications in Rust — covers task spawning, channels, and structured concurrency.",
  "image": "https://example.com/tokio-thumb.jpg",
  "link": "https://example.com/tokio-tutorial",
  "onClick": { "link": "https://example.com/tokio-tutorial" },
  "actions": [
    { "label": "Add to reading list", "reply": "Save the Tokio tutorial to my reading list" }
  ]
}
```

All fields optional. `onClick` is either `{ link }` or `{ reply }`.

## Attach example

```
desk-agent chat attach-artifact \
  /opt/desk-apps/chat-cards.app/dist/fragments/list \
  --param title="Recent Rust async runtime articles" \
  --param items='[
    {
      "title": "Tokio Tutorial 2026",
      "description": "Building async applications in Rust.",
      "link": "https://example.com/tokio-tutorial"
    },
    {
      "title": "Tokio vs Smol in 2026",
      "description": "Side-by-side benchmark across realistic workloads.",
      "link": "https://example.com/tokio-vs-smol"
    }
  ]'
```

## Storage contract

This fragment does not use persistent app storage. All state is held in
the iframe until the user clicks a reply action, after which one chat
message is posted back.

## When to use

Any time the agent has a set of items to surface that the user wants to
read through in order — search results, articles, papers, recommendation
lists, entity lookup. For browseable/visual result sets where the layout
helps scanning, use the `grid` fragment instead.
