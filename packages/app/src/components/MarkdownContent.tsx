import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PathChip } from '@/components/shared/PathChip'
import { remarkSandboxPaths, sandboxToUserPath } from '@/lib/remark-sandbox-paths'

interface MarkdownContentProps {
  text: string
  /**
   * When provided, sandbox paths (/home/agent/... or ~/...) are detected and
   * rendered as PathChip components. Should be the workspace directory name
   * (e.g. "desk-2"). Pair with workspaceId to make chips navigable.
   */
  workspacePath?: string
  /** Workspace UUID — when paired with workspacePath, PathChip clicks open
   *  the file in the library (context view). */
  workspaceId?: string
}

function urlTransform(url: string): string {
  if (url.startsWith('desk-path:')) return url
  if (/^(https?:|mailto:|#)/.test(url)) return url
  if (url.startsWith('/') || url.startsWith('.')) return url
  return ''
}

export function MarkdownContent({ text, workspacePath, workspaceId }: MarkdownContentProps) {
  const remarkPlugins = workspacePath
    ? [remarkGfm, remarkSandboxPaths(workspacePath)]
    : [remarkGfm]

  const components = {
    pre: ({ children, ...props }: React.ComponentProps<'pre'>) => (
      <pre
        {...props}
        className="max-w-full overflow-x-hidden whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs text-foreground"
      >
        {children}
      </pre>
    ),
    code: ({ children, className, ...props }: React.ComponentProps<'code'>) => (
      <code
        {...props}
        className={`${className ?? ''} whitespace-pre-wrap break-words`}
      >
        {children}
      </code>
    ),
    ...(workspacePath ? {
      a: ({ href, children }: React.ComponentProps<'a'>) => {
        if (href?.startsWith('desk-path:')) {
          const sandboxPath = decodeURIComponent(href.slice('desk-path:'.length))
          // Compute display path from the sandbox path — avoids String(children)
          // which would produce [object Object] for React element trees.
          const displayPath = sandboxToUserPath(sandboxPath, workspacePath)
          return (
            <PathChip
              sandboxPath={sandboxPath}
              displayPath={displayPath}
              workspaceId={workspaceId}
            />
          )
        }
        return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      },
    } : {}),
  }

  return (
    <div className="prose prose-neutral prose-sm min-w-0 max-w-none break-words text-foreground prose-headings:font-semibold prose-headings:text-foreground prose-p:text-sm prose-p:leading-relaxed prose-p:my-1 prose-li:text-sm prose-li:my-0 prose-ul:my-1 prose-ol:my-1 prose-strong:text-foreground prose-strong:font-semibold prose-code:text-sm prose-code:text-foreground prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-pre:max-w-full prose-pre:overflow-x-hidden prose-pre:whitespace-pre-wrap prose-pre:break-words prose-pre:bg-muted prose-pre:text-xs prose-pre:text-foreground prose-table:w-full prose-table:table-fixed prose-table:break-words prose-table:text-sm prose-th:text-left prose-th:font-medium prose-th:break-words prose-td:break-words prose-a:text-primary">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        urlTransform={workspacePath ? urlTransform : undefined}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
