import { visit, SKIP } from 'unist-util-visit'
import type { Root, Text, Link, InlineCode, Parent } from 'mdast'

export type InlineEntityKind = 'chat' | 'workspace'

const ENTITY_ID_RE = /(?<![A-Za-z0-9_-])(?:(cht|wks)_[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/g
const ENTITY_ID_ONLY_RE = /^(?:cht|wks)_[A-Za-z0-9_-]+$/

function entityKind(id: string): InlineEntityKind | null {
  if (id.startsWith('cht_')) return 'chat'
  if (id.startsWith('wks_')) return 'workspace'
  return null
}

function makeEntityLink(id: string): Link | null {
  const kind = entityKind(id)
  if (!kind) return null
  return {
    type: 'link',
    url: `desk-entity:${kind}:${encodeURIComponent(id)}`,
    title: null,
    children: [{ type: 'text', value: id }],
  }
}

/**
 * Converts Desk chat/workspace ids in message text into internal links so the
 * renderer can display navigable title chips instead of raw ids.
 */
export function remarkEntityIds() {
  return (tree: Root) => {
    visit(tree, 'inlineCode', (node: InlineCode, index, parent: Parent | undefined) => {
      if (!parent || index == null) return
      const value = node.value.trim()
      if (!ENTITY_ID_ONLY_RE.test(value)) return
      const link = makeEntityLink(value)
      if (!link) return
      parent.children.splice(index, 1, link)
      return [SKIP, index + 1] as const
    })

    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index == null) return
      if (parent.type === 'link') return

      ENTITY_ID_RE.lastIndex = 0
      const matches: { start: number; end: number; id: string }[] = []
      let m: RegExpExecArray | null
      while ((m = ENTITY_ID_RE.exec(node.value)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length, id: m[0] })
      }
      if (matches.length === 0) return

      const nodes: (Text | Link)[] = []
      let cursor = 0
      for (const match of matches) {
        if (match.start > cursor) {
          nodes.push({ type: 'text', value: node.value.slice(cursor, match.start) })
        }
        const link = makeEntityLink(match.id)
        if (link) nodes.push(link)
        else nodes.push({ type: 'text', value: match.id })
        cursor = match.end
      }
      if (cursor < node.value.length) {
        nodes.push({ type: 'text', value: node.value.slice(cursor) })
      }

      parent.children.splice(index, 1, ...nodes)
      return [SKIP, index + nodes.length] as const
    })
  }
}
