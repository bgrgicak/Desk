import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { shallowEqual } from 'react-redux'
import { createSelector } from '@reduxjs/toolkit'
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
  const match = href.match(/^desk-entity:(chat|workspace|task|artifact|file):(.+)$/)
  if (!match) return null
  try {
    const kind = match[1] as EntityChipKind
    const id = decodeURIComponent(match[2])
    const PREFIX: Record<EntityChipKind, string> = {
      chat: 'cht_', workspace: 'wks_', task: 'tsk_', artifact: 'art_', file: 'fil_',
    }
    if (!id.startsWith(PREFIX[kind])) return null
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

/**
 * Module-level memoized selector that walks the entire RTK Query cache to
 * find every cached chat (across all workspace-scoped `getChats` queries
 * plus any individual `getChat` fetches). Used by the markdown renderer
 * to resolve `desk-entity:chat:<id>` links to chip titles without forcing
 * the caller to know which query holds the row.
 *
 * Previously inlined as a `useAppSelector` arrow function inside the
 * component, this fan-out cost N (one walk per mounted MarkdownContent)
 * on every Redux dispatch — including dispatches that didn't touch any
 * api cache (e.g. UI slice toggles, derived/markChatRunning during
 * streaming). Moving to a `createSelector` at module level shares the
 * computation across all subscribers and short-circuits on dispatches
 * that leave the api state reference unchanged.
 */
const selectAllCachedChats = createSelector(
  [(state: RootState) => state[api.reducerPath].queries],
  (queries): ServerChat[] => {
    const byId = new Map<string, ServerChat>()
    for (const query of Object.values((queries ?? {}) as Record<string, CachedQueryEntry>)) {
      if (query?.endpointName !== 'getChats' && query?.endpointName !== 'getChat') continue
      const data = query.data
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        if (!isServerChat(item)) continue
        byId.set(item.id, item)
      }
    }
    return [...byId.values()]
  },
)

const selectAllCachedWorkspaces = createSelector(
  [(state: RootState) => state[api.reducerPath].queries],
  (queries): ServerWorkspace[] => {
    const byId = new Map<string, ServerWorkspace>()
    for (const query of Object.values((queries ?? {}) as Record<string, CachedQueryEntry>)) {
      if (query?.endpointName !== 'getWorkspaces') continue
      const data = query.data
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        if (!isServerWorkspace(item)) continue
        byId.set(item.id, item)
      }
    }
    return [...byId.values()]
  },
)

/**
 * Per-id chat lookup. Pushing the cache subscription down to a child
 * component is what stops a single chat update (e.g. a streaming chunk
 * mutating one chat's `updatedAt`) from invalidating every mounted
 * `MarkdownContent` in the thread. The narrow `{ title, workspaceId }`
 * projection with `shallowEqual` further ensures we only re-render when
 * this specific chat's title or owning workspace actually changes —
 * not on unrelated cache churn.
 */
function ChatEntityChip({ id, fallbackWorkspaceId }: { id: string; fallbackWorkspaceId?: string }) {
  const bits = useAppSelector(state => {
    const chat = selectAllCachedChats(state).find(c => c.id === id)
    return { title: chat?.title, workspaceId: chat?.workspaceId }
  }, shallowEqual)
  return (
    <EntityChip
      kind="chat"
      id={id}
      title={bits.title}
      workspaceId={bits.workspaceId ?? fallbackWorkspaceId}
    />
  )
}

function WorkspaceEntityChip({ id }: { id: string }) {
  // Selecting a string keeps the default `===` comparison cheap and
  // re-renders only when this workspace's name actually changes.
  const title = useAppSelector(state =>
    selectAllCachedWorkspaces(state).find(w => w.id === id)?.name,
  )
  return <EntityChip kind="workspace" id={id} title={title} />
}

export const MarkdownContent = memo(function MarkdownContent({ text, workspacePath, workspaceId }: MarkdownContentProps) {
  // The plugins array and components map used to be recreated inline on
  // every render. ReactMarkdown's internal optimizations rely on stable
  // identities for these, so churning them defeats any reuse and forces a
  // full re-parse + reconcile every time the parent re-renders for any
  // reason.
  const remarkPlugins = useMemo(
    () => workspacePath
      ? [remarkGfm, remarkSandboxPaths(workspacePath), remarkEntityIds]
      : [remarkGfm, remarkEntityIds],
    [workspacePath],
  )

  // Crucially the `chats` / `workspaces` arrays no longer appear here —
  // entity chip resolution moved to the `*EntityChip` subcomponents
  // above, which subscribe per-id. With only the stable string props
  // (`workspacePath`, `workspaceId`) in this dep list the `components`
  // map keeps its identity across most re-renders, letting the outer
  // `memo` wrapper (and ReactMarkdown's internal reuse) actually work.
  const components = useMemo(() => ({
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
          if (entity.kind === 'chat') {
            return <ChatEntityChip id={entity.id} fallbackWorkspaceId={workspaceId} />
          }
          if (entity.kind === 'workspace') {
            return <WorkspaceEntityChip id={entity.id} />
          }
          return <EntityChip kind={entity.kind} id={entity.id} workspaceId={workspaceId} />
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
  }), [workspacePath, workspaceId])

  return (
    <div className="prose prose-neutral prose-sm min-w-0 max-w-none break-words text-foreground prose-headings:font-semibold prose-headings:text-foreground prose-p:text-sm prose-p:leading-relaxed prose-p:my-1 prose-li:text-sm prose-li:my-1 prose-ul:my-3 prose-ol:my-3 prose-strong:text-foreground prose-strong:font-semibold prose-code:text-sm prose-code:text-foreground prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:max-w-full prose-pre:overflow-x-hidden prose-pre:whitespace-pre-wrap prose-pre:break-words prose-pre:bg-muted prose-pre:text-xs prose-pre:text-foreground prose-pre:font-normal prose-table:w-full prose-table:table-fixed prose-table:break-words prose-table:text-sm prose-th:text-left prose-th:font-medium prose-th:break-words prose-td:break-words prose-a:text-primary">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        urlTransform={urlTransform}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
