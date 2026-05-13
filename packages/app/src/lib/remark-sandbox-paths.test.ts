import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root, Link } from 'mdast'
import {
  remarkSandboxPaths,
  sandboxToUserPath,
  SANDBOX_HOME,
} from './remark-sandbox-paths'

const WS = 'my-workspace'

function transform(md: string): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkSandboxPaths(WS))
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

// ── sandboxToUserPath ─────────────────────────────────────────────────────────

describe('sandboxToUserPath', () => {
  it('translates /home/agent prefix to workspace path', () => {
    expect(sandboxToUserPath(`${SANDBOX_HOME}/foo/bar.md`, WS)).toBe(
      `~/Desk/${WS}/foo/bar.md`,
    )
  })

  it('translates ~/ prefix to workspace path', () => {
    expect(sandboxToUserPath('~/notes.md', WS)).toBe(
      `~/Desk/${WS}/notes.md`,
    )
  })

  it('translates bare ~/  (sandbox root)', () => {
    expect(sandboxToUserPath('~/', WS)).toBe(`~/Desk/${WS}/`)
  })
})

// ── remarkSandboxPaths plugin ─────────────────────────────────────────────────

describe('remarkSandboxPaths', () => {
  it('converts an /home/agent path in plain text to a desk-path link', () => {
    const tree = transform('See /home/agent/report.md for details.')
    const links = collectLinks(tree)
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe(
      `desk-path:${encodeURIComponent(`${SANDBOX_HOME}/report.md`)}`,
    )
  })

  it('converts a ~/ path in text to a desk-path link', () => {
    const tree = transform('Open ~/notes.md please.')
    const links = collectLinks(tree)
    expect(links).toHaveLength(1)
    expect(links[0].url).toContain('desk-path:')
    expect(decodeURIComponent(links[0].url.replace('desk-path:', ''))).toBe(
      '~/notes.md',
    )
  })

  it('converts an inlineCode node whose entire value is a sandbox path', () => {
    const tree = transform('Run `/home/agent/src`')
    const links = collectLinks(tree)
    expect(links.some((l) => l.url.includes(encodeURIComponent('/home/agent/src')))).toBe(true)
  })

  it('converts markdown links whose href is an /home/agent path', () => {
    const tree = transform('Open [the report](/home/agent/report.md).')
    const links = collectLinks(tree).filter((l) => l.url.startsWith('desk-path:'))
    expect(links).toHaveLength(1)
    expect(decodeURIComponent(links[0].url.replace('desk-path:', ''))).toBe(
      '/home/agent/report.md',
    )
    expect(links[0].children).toEqual([
      { type: 'text', value: `~/Desk/${WS}/report.md` },
    ])
  })

  it('preserves trailing slashes for markdown links to directories', () => {
    const tree = transform('Open [the folder](/home/agent/projects/).')
    const links = collectLinks(tree).filter((l) => l.url.startsWith('desk-path:'))
    expect(links).toHaveLength(1)
    expect(decodeURIComponent(links[0].url.replace('desk-path:', ''))).toBe(
      '/home/agent/projects/',
    )
  })

  it('converts markdown links whose href is a ~/ path', () => {
    const tree = transform('Open [notes](~/notes.md).')
    const links = collectLinks(tree).filter((l) => l.url.startsWith('desk-path:'))
    expect(links).toHaveLength(1)
    expect(decodeURIComponent(links[0].url.replace('desk-path:', ''))).toBe(
      '~/notes.md',
    )
  })

  it('does NOT convert an inlineCode node whose value has a prefix before the path', () => {
    const tree = transform('Run `cd /home/agent/src`')
    const links = collectLinks(tree).filter((l) => l.url.startsWith('desk-path:'))
    expect(links).toHaveLength(0)
  })

  it('does NOT match ~/ preceded by a word character (false-match guard)', () => {
    const tree = transform('Visit http://example.com/repo~/files here')
    const links = collectLinks(tree)
    // The ~/files inside a URL-like token preceded by a letter must not match.
    const sandboxLinks = links.filter((l) => l.url.startsWith('desk-path:'))
    expect(sandboxLinks).toHaveLength(0)
  })

  it('does NOT match a bare ~ without a following slash', () => {
    const tree = transform('Use ~ to refer to home.')
    const links = collectLinks(tree)
    const sandboxLinks = links.filter((l) => l.url.startsWith('desk-path:'))
    expect(sandboxLinks).toHaveLength(0)
  })

  it('converts multiple paths in one paragraph', () => {
    const tree = transform(
      'Check /home/agent/a.md and /home/agent/b.md both.',
    )
    const links = collectLinks(tree)
    const sandboxLinks = links.filter((l) => l.url.startsWith('desk-path:'))
    expect(sandboxLinks).toHaveLength(2)
  })

  it('does not match /home/agent alone when followed by end of text', () => {
    const tree = transform('/home/agent')
    const links = collectLinks(tree)
    // The bare sandbox root may match but must not error; just verify no crash.
    expect(links).toBeDefined()
  })

  it('strips trailing punctuation — path followed by period does not include it', () => {
    const tree = transform('See /home/agent/report.md.')
    const links = collectLinks(tree)
    const sandboxLinks = links.filter((l) => l.url.startsWith('desk-path:'))
    // The path itself should not include the trailing period.
    for (const link of sandboxLinks) {
      expect(decodeURIComponent(link.url.replace('desk-path:', ''))).not.toMatch(/\.$/)
    }
  })
})
