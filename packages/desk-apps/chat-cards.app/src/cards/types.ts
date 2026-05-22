// Item / action schema shared by the grid and list fragments. The agent
// passes a JSON-encoded array via `--param items=...`; each entry is one
// card. Every field is optional except where noted.

export type LinkAction = { label: string; link: string }
export type ReplyAction = { label: string; reply: string }
export type Action = LinkAction | ReplyAction

export type OnClick = { link: string } | { reply: string }

export interface Item {
  /** Card heading. Hyperlinked iff `link` is set. */
  title?: string
  /** One- to a few-sentence description / verdict. */
  description?: string
  /** Thumbnail URL. Rendered as a plain <img>. */
  image?: string
  /**
   * Convenience: makes the title a hyperlink. Independent of `onClick` —
   * clicking the title opens this URL; clicking the rest of the card
   * follows `onClick` if set.
   */
  link?: string
  /**
   * Optional: when set, the whole card body is clickable. Either opens an
   * external link or posts a reply back to chat via the chat bridge.
   */
  onClick?: OnClick
  /**
   * Optional: 0..N buttons rendered at the bottom of the card. Each is
   * either a link (opens external URL) or a reply (posts back to chat).
   */
  actions?: Action[]
}

export function isLinkAction(a: Action): a is LinkAction {
  return typeof (a as LinkAction).link === 'string'
}

export function isLinkOnClick(o: OnClick): o is { link: string } {
  return typeof (o as { link: string }).link === 'string'
}
