import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root, Link } from 'mdast'
import { remarkEntityIds } from './remark-entity-ids'

function transform(md: string): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkEntityIds)
  const tree = processor.parse(md)
  return processor.runSync(tree) as Root
}

function collectLinks(tree: Root): Link[] {
  const links: Link[] = []
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n.type === 'link') links.push(n as unknown as Link)
    if (Array.isArray(n.children)) (n.children as unknown[]).forEach(walk)
  }
  walk(tree)
  return links
}

describe('remarkEntityIds', () => {
  it('converts chat ids in plain text to desk-entity links', () => {
    const links = collectLinks(transform('Open cht_VBC2TUA8lwIcVctX4iq3v now.'))
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe('desk-entity:chat:cht_VBC2TUA8lwIcVctX4iq3v')
  })

  it('converts workspace ids in plain text to desk-entity links', () => {
    const links = collectLinks(transform('Workspace wks_9gX8d6tQ1uHFWbODZFeEG'))
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe('desk-entity:workspace:wks_9gX8d6tQ1uHFWbODZFeEG')
  })

  it('converts an inlineCode node whose entire value is an entity id', () => {
    const links = collectLinks(transform('Use `cht_abc123`'))
    expect(links.map(l => l.url)).toContain('desk-entity:chat:cht_abc123')
  })

  it('does not convert inlineCode that only begins with an entity id', () => {
    const links = collectLinks(transform('Use `cht_abc123 extra`'))
    expect(links).toHaveLength(0)
  })

  it('does not convert ids inside existing markdown links', () => {
    const links = collectLinks(transform('[cht_abc123](https://example.com)'))
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe('https://example.com')
  })
})
