import { visit, SKIP } from 'unist-util-visit'
import type { Root, Text, Link, InlineCode, Parent } from 'mdast'

export const SANDBOX_HOME = '/home/agent'

/**
 * Matches either /home/agent/... or ~/... paths as written by the agent.
 * The tilde form requires ~/ (tilde + slash) to avoid matching bare ~.
 * A negative lookbehind ensures ~/ only matches when not preceded by a
 * word character (prevents false matches like foo~/bar in URLs or text).
 * Trailing slashes on directory paths may be stripped by the regex.
 */
const SANDBOX_PATH_RE = /(?:\/home\/agent(?:\/[^\s"'`<>()[\]{},|#\n]*[^\s"'`<>()[\]{},|#\n./]|\/[^\s"'`<>()[\]{},|#\n.]*|\/?(?=[/\s"'`<>()[\]{},|#\n]|$))|(?<![a-zA-Z0-9_])~\/(?:[^\s"'`<>()[\]{},|#\n]*[^\s"'`<>()[\]{},|#\n./]|[^\s"'`<>()[\]{},|#\n.]*|(?=[/\s"'`<>()[\]{},|#\n]|$)))/g

function isSandboxPath(value: string): boolean {
  return value.startsWith(SANDBOX_HOME) || value.startsWith('~/')
}

function linkUrlToSandboxPath(url: string): string | null {
  let decoded = url
  try {
    decoded = decodeURI(url)
  } catch {
    // Keep the original URL if it is not valid URI-encoded text.
  }

  return isSandboxPath(decoded) ? decoded : null
}

export function sandboxToUserPath(sandboxPath: string, workspacePath: string): string {
  if (sandboxPath.startsWith('~/')) {
    // ~/foo  →  ~/Desk/<slug>/foo
    return `~/Desk/${workspacePath}/` + sandboxPath.slice(2)
  }
  return sandboxPath.replace(SANDBOX_HOME, `~/Desk/${workspacePath}`)
}

function makePathLink(sandboxPath: string, workspacePath: string): Link {
  return {
    type: 'link',
    url: `desk-path:${encodeURIComponent(sandboxPath)}`,
    title: null,
    children: [{ type: 'text', value: sandboxToUserPath(sandboxPath, workspacePath) }],
  }
}

/**
 * Remark plugin that transforms sandbox paths in agent message text into link
 * nodes with a desk-path: URL. MarkdownContent renders these as PathChip
 * components. Handles both /home/agent/... and ~/... path forms.
 */
export function remarkSandboxPaths(workspacePath: string) {
  return () => (tree: Root) => {
    // Replace inlineCode nodes whose entire value is a sandbox path.
    visit(tree, 'inlineCode', (node: InlineCode, index, parent: Parent | undefined) => {
      if (!parent || index == null) return
      if (!isSandboxPath(node.value)) return
      const link = makePathLink(node.value.trim(), workspacePath)
      parent.children.splice(index, 1, link)
      return [SKIP, index + 1] as const
    })

    // Rewrite explicit markdown links whose href is a sandbox path, e.g.
    // [report](/home/agent/report.md) or [folder](/home/agent/folder/).
    // Without this, react-markdown preserves the absolute /home/agent href and
    // the browser treats it as an app route, which is especially visible for
    // directory links rendered from artifact/library references.
    visit(tree, 'link', (node: Link) => {
      const sandboxPath = linkUrlToSandboxPath(node.url)
      if (!sandboxPath) return
      node.url = `desk-path:${encodeURIComponent(sandboxPath)}`
      node.children = [{ type: 'text', value: sandboxToUserPath(sandboxPath, workspacePath) }]
      return SKIP
    })

    // Split text nodes that contain one or more sandbox paths.
    // Skip text inside link nodes — those are already-translated display labels
    // and processing them would create nested links.
    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index == null) return
      if (parent.type === 'link') return

      SANDBOX_PATH_RE.lastIndex = 0
      const matches: { start: number; end: number; path: string }[] = []
      let m: RegExpExecArray | null
      while ((m = SANDBOX_PATH_RE.exec(node.value)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length, path: m[0] })
      }
      if (matches.length === 0) return

      const nodes: (Text | Link)[] = []
      let cursor = 0
      for (const match of matches) {
        if (match.start > cursor) {
          nodes.push({ type: 'text', value: node.value.slice(cursor, match.start) })
        }
        nodes.push(makePathLink(match.path, workspacePath))
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
