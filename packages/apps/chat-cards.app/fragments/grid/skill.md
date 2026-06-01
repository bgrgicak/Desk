# grid fragment

Renders 1..N cards in a responsive grid. Use when the visual layout helps
the user scan results — products, places, photos, dashboards. For
text-heavy result lists (articles, papers, entity lookup) the `list`
fragment usually reads better.

## Behavior

- Reads the URL `items` param (JSON-encoded array of card objects).
- Optionally reads a `title` param and renders it as a header above the
  grid.
- The grid auto-fits columns to the actual item count and available width:
  a single card fills the row, while multiple cards share responsive columns.
- Each item renders as a single Card:
  - `title` — optional. Hyperlinked when `link` is set; otherwise plain
    text.
  - `description` — optional.
  - `image` — optional URL. Rendered as a plain `<img>`; the agent is
    responsible for picking a compact thumbnail URL (no resizing happens
    here).
  - `onClick` — optional. When present, the whole card body becomes
    clickable. `{ link }` opens the URL in a new tab; `{ reply }` calls
    `window.roomy.chat.sendMessage(reply)`.
  - `actions` — optional array of buttons rendered at the bottom of the
    card. Each is either `{ label, link }` or `{ label, reply }`. Actions
    `stopPropagation` so they don't double-fire with `onClick`.
- All fields on a card are optional. A card with only `image` is a thumb;
  with only `title` is a name; with `title + link` is a hyperlink card.

## Capabilities

- `chats.write` — required for `reply` actions on cards or buttons.

## Params

| Param   | Type   | Description                                                     |
|---------|--------|-----------------------------------------------------------------|
| `items` | string | JSON-encoded array of card objects (see schema below). Required. Must be non-empty. |
| `title` | string | Optional header rendered above the grid.                        |

### Card schema

```json
{
  "title": "Sony WH-1000XM5",
  "description": "Best ANC.",
  "image": "https://example.com/thumb.jpg",
  "link": "https://example.com/sony",
  "onClick": { "reply": "Tell me more about Sony WH-1000XM5" },
  "actions": [
    { "label": "Pick this", "reply": "I want the Sony WH-1000XM5" },
    { "label": "Compare",   "link": "https://example.com/compare" }
  ]
}
```

All fields optional. `onClick` is either `{ link }` or `{ reply }` —
clicking the card body opens the link or posts the reply back to chat.

## Attach example

```
roomy-agent chat attach-artifact \
  /opt/roomy-apps/chat-cards.app/dist/fragments/grid \
  --param title="Noise-cancelling headphones under €250" \
  --param items='[
    {
      "title": "Sony WH-1000XM5",
      "description": "Best ANC.",
      "image": "https://example.com/sony-thumb.jpg",
      "link": "https://example.com/sony",
      "actions": [{ "label": "Pick this", "reply": "I want the Sony" }]
    },
    {
      "title": "Bose QC Ultra",
      "description": "More comfortable for long sessions.",
      "image": "https://example.com/bose-thumb.jpg",
      "link": "https://example.com/bose",
      "actions": [{ "label": "Pick this", "reply": "I want the Bose" }]
    }
  ]'
```

## Storage contract

This fragment does not use persistent app storage. All state is held in
the iframe until the user clicks a reply action, after which one chat
message is posted back.

## When to use

Any time the agent has a set of items to surface that the user might
want to scan, compare, click into, or pick from — search results,
product/place/photo lists, comparison cards, source lists. For prose-
heavy article-style results that read better as a vertical column, use
the `list` fragment instead.
