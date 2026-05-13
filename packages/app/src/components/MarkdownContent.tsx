import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { shallowEqual } from 'react-redux'
import { PathChip } from '@/components/shared/PathChip'
import { EntityChip, type EntityChipKind } from '@/components/shared/EntityChip'
import { api } from '@/store/api'
import { useAppSelector } from '@/store/hooks'
import type { RootState } from '@/store/store'
import type { ServerChat, ServerWorkspace } from '@/store/types'
import { remarkEntityIds } from '@/lib/remark-entity-ids'
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
  if (url.startsWith('desk-entity:')) return url
  if (/^(https?:|mailto:|#)/.test(url)) return url
  if (url.startsWith('/') || url.startsWith('.')) return url
  return ''
}

export function parseEntityUrl(href: string): { kind: EntityChipKind; id: string } | null {
  const match = href.match(/^desk-entity:(chat|workspace):(.+)$/)
  if (!match) return null
  try {
    const kind = match[1] as EntityChipKind
    const id = decodeURIComponent(match[2])
    if (kind === 'chat' && !id.startsWith('cht_')) return null
    if (kind === 'workspace' && !id.startsWith('wks_')) return null
    return { kind, id }
  } catch {
    return null
  }
}

type CachedQueryEntry = {
  endpointName?: string
  data?: unknown
}

function isServerChat(value: unknown): value is ServerChat {
  return !!value && typeof value === 'object'
    && typeof (value as ServerChat).id === 'string'
    && typeof (value as ServerChat).workspaceId === 'string'
    && typeof (value as ServerChat).title === 'string'
}

function isServerWorkspace(value: unknown): value is ServerWorkspace {
  return !!value && typeof value === 'object'
    && typeof (value as ServerWorkspace).id === 'string'
    && typeof (value as ServerWorkspace).name === 'string'
}

function selectCachedQueryItems<T>(
  state: RootState,
  endpointName: string,
  isItem: (value: unknown) => value is T,
): T[] {
  const queries = (state[api.reducerPath].queries ?? {}) as Record<string, CachedQueryEntry>
  const byId = new Map<string, T>()

  for (const query of Object.values(queries)) {
    if (query?.endpointName !== endpointName) continue
    const data = query.data
    const items = Array.isArray(data) ? data : [data]
    for (const item of items) {
      if (!isItem(item)) continue
      byId.set((item as { id: string }).id, item)
    }
  }

  return [...byId.values()]
}

export function MarkdownContent({ text, workspacePath, workspaceId }: MarkdownContentProps) {
  const chats = useAppSelector(state => [
    ...selectCachedQueryItems(state, 'getChats', isServerChat),
    ...selectCachedQueryItems(state, 'getChat', isServerChat),
  ], shallowEqual)
  const workspaces = useAppSelector(
    state => selectCachedQueryItems(state, 'getWorkspaces', isServerWorkspace),
    shallowEqual,
  )
  const remarkPlugins = workspacePath
    ? [remarkGfm, remarkSandboxPaths(workspacePath), remarkEntityIds]
    : [remarkGfm, remarkEntityIds]

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
        className={`${className ?? ''} whitespace-pre-wrap break-words before:content-none after:content-none`}
      >
        {children}
      </code>
    ),
    a: ({ href, children }: React.ComponentProps<'a'>) => {
        if (href?.startsWith('desk-entity:')) {
          const entity = parseEntityUrl(href)
          if (entity) {
            const chat = entity.kind === 'chat'
              ? chats?.find(c => c.id === entity.id)
              : undefined
            const workspace = entity.kind === 'workspace'
              ? workspaces?.find(w => w.id === entity.id)
              : undefined
            return (
              <EntityChip
                kind={entity.kind}
                id={entity.id}
                title={chat?.title ?? workspace?.name}
                workspaceId={chat?.workspaceId ?? (entity.kind === 'chat' ? workspaceId : undefined)}
              />
            )
          }
          return <>{children}</>
        }
        if (href?.startsWith('desk-path:')) {
          if (!workspacePath) return <>{children}</>
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
  }

  return (
    <div className="prose prose-neutral prose-sm min-w-0 max-w-none break-words text-foreground prose-headings:font-semibold prose-headings:text-foreground prose-p:text-sm prose-p:leading-relaxed prose-p:my-1 prose-li:text-sm prose-li:my-0 prose-ul:my-1 prose-ol:my-1 prose-strong:text-foreground prose-strong:font-semibold prose-code:text-sm prose-code:text-foreground prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-code:before:content-none prose-code:after:content-none prose-pre:max-w-full prose-pre:overflow-x-hidden prose-pre:whitespace-pre-wrap prose-pre:break-words prose-pre:bg-muted prose-pre:text-xs prose-pre:text-foreground prose-table:w-full prose-table:table-fixed prose-table:break-words prose-table:text-sm prose-th:text-left prose-th:font-medium prose-th:break-words prose-td:break-words prose-a:text-primary">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        urlTransform={urlTransform}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
