import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PathChip } from '@/components/shared/PathChip'
import { remarkSandboxPaths } from '@/lib/remark-sandbox-paths'

interface MarkdownContentProps {
  text: string
  /**
   * When provided, /home/agent/... sandbox paths in the text are detected and
   * rendered as PathChip components showing the equivalent user-visible path.
   * Should be the on-disk workspace directory name (e.g. "desk-2").
   */
  workspacePath?: string
}

function urlTransform(url: string): string {
  // Allow desk-path: links through; they're handled by the custom `a` renderer.
  if (url.startsWith('desk-path:')) return url
  // Default: block javascript: and other unsafe schemes.
  if (/^(https?:|mailto:|#)/.test(url)) return url
  if (url.startsWith('/') || url.startsWith('.')) return url
  return ''
}

export function MarkdownContent({ text, workspacePath }: MarkdownContentProps) {
  const remarkPlugins = workspacePath
    ? [remarkGfm, remarkSandboxPaths(workspacePath)]
    : [remarkGfm]

  return (
    <div className="prose prose-neutral prose-sm max-w-none text-foreground prose-headings:font-semibold prose-headings:text-foreground prose-p:text-sm prose-p:leading-relaxed prose-p:my-1 prose-li:text-sm prose-li:my-0 prose-ul:my-1 prose-ol:my-1 prose-strong:text-foreground prose-strong:font-semibold prose-code:text-sm prose-code:text-foreground prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-pre:bg-muted prose-pre:text-xs prose-pre:text-foreground prose-table:text-sm prose-th:text-left prose-th:font-medium prose-a:text-primary">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        urlTransform={workspacePath ? urlTransform : undefined}
        components={workspacePath ? {
          a: ({ href, children }) => {
            if (href?.startsWith('desk-path:')) {
              const sandboxPath = decodeURIComponent(href.slice('desk-path:'.length))
              const displayPath = String(children)
              return <PathChip sandboxPath={sandboxPath} displayPath={displayPath} />
            }
            return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          },
        } : undefined}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
