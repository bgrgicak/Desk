import { visit, SKIP } from 'unist-util-visit'
import type { Root, Text, Link, InlineCode, Parent } from 'mdast'

export const SANDBOX_HOME = '/home/agent'

/**
 * Regex matching an absolute sandbox path starting with /home/agent.
 * Stops at whitespace and common punctuation that wouldn't be part of a path.
 */
const SANDBOX_PATH_RE = /\/home\/agent(?:\/[^\s"'`<>()[\]{},|#\n]*[^\s"'`<>()[\]{},|#\n./]|\/[^\s"'`<>()[\]{},|#\n.]*|\/?(?=[/\s"'`<>()[\]{},|#\n]|$))/g

export function sandboxToUserPath(sandboxPath: string, workspacePath: string): string {
  return sandboxPath.replace(SANDBOX_HOME, `~/Desk/workspaces/${workspacePath}`)
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
 * Remark plugin that transforms /home/agent/... paths in agent message text
 * into link nodes with a desk-path: URL. MarkdownContent renders these as
 * PathChip components. Works on both inline text and inline code nodes.
 */
export function remarkSandboxPaths(workspacePath: string) {
  return () => (tree: Root) => {
    // Replace inlineCode nodes whose entire value is a sandbox path.
    visit(tree, 'inlineCode', (node: InlineCode, index, parent: Parent | undefined) => {
      if (!parent || index == null) return
      if (!node.value.startsWith(SANDBOX_HOME)) return
      const link = makePathLink(node.value.trim(), workspacePath)
      parent.children.splice(index, 1, link)
      return [SKIP, index + 1] as const
    })

    // Split text nodes that contain one or more sandbox paths.
    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index == null) return

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
