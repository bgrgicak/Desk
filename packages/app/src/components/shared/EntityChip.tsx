import type { MouseEvent } from 'react'
import { MessageSquare, PanelTop, Zap, Sparkles, FileText, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { buildPath } from '@/router/nav'
import { useAppDispatch } from '@/store/hooks'
import { openArtifact } from '@/store/slices/previewPanelSlice'

export type EntityChipKind = 'chat' | 'workspace' | 'task' | 'artifact' | 'file'

const ENTITY_ICON: Record<EntityChipKind, LucideIcon> = {
  chat: MessageSquare,
  workspace: PanelTop,
  task: Zap,
  artifact: Sparkles,
  file: FileText,
}

const ENTITY_NOUN: Record<EntityChipKind, string> = {
  chat: 'Chat',
  workspace: 'Workspace',
  task: 'Task',
  artifact: 'Artifact',
  file: 'File',
}

interface EntityChipProps {
  kind: EntityChipKind
  id: string
  title?: string
  workspaceId?: string
}

function compactTitle(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 28) return trimmed
  return `${trimmed.slice(0, 25)}…`
}

function fallbackId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 7)}…${id.slice(-4)}`
}

export function EntityChip({ kind, id, title, workspaceId }: EntityChipProps) {
  const dispatch = useAppDispatch()
  const Icon = ENTITY_ICON[kind]
  const label = compactTitle(title || fallbackId(id))
  const href = (() => {
    if (kind === 'workspace') return buildPath(id, 'pinned')
    if (!workspaceId) return null
    switch (kind) {
      case 'chat': return buildPath(workspaceId, 'pinned', { chat: id })
      case 'task': return buildPath(workspaceId, 'tasks', { task: id })
      case 'artifact': return buildPath(workspaceId, 'pinned', { artifact: id })
      case 'file': return buildPath(workspaceId, 'context', { item: id })
    }
  })()
  // File chips open the in-chat preview panel on plain click instead of
  // navigating to the Library detail page. Modifier clicks fall through
  // to the <Link> so the file's detail page can still open in a new tab.
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (kind !== 'file' || !workspaceId) return
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    e.preventDefault()
    dispatch(openArtifact({ workspaceId, path: id, name: title ?? (id.split('/').pop() || id) }))
  }
  const chipTitle = title ? `${ENTITY_NOUN[kind]}: ${title} (${id})` : id
  const className = "inline-flex max-w-[18rem] items-center gap-1 rounded border border-border/50 bg-muted px-1.5 py-0.5 align-baseline text-xs font-medium text-foreground no-underline transition-colors hover:bg-muted/80 aria-disabled:cursor-default aria-disabled:opacity-70"

  const contents = <>
    <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
    <span className="truncate">{label}</span>
  </>

  if (!href) {
    return (
      <span
        aria-disabled="true"
        title={chipTitle}
        className={className}
      >
        {contents}
      </span>
    )
  }

  return (
    <Link
      to={href}
      onClick={handleClick}
      title={chipTitle}
      className={className}
    >
      {contents}
    </Link>
  )
}
