import { MessageSquare, PanelTop } from 'lucide-react'
import { Link } from 'react-router-dom'
import { buildPath } from '@/router/nav'

export type EntityChipKind = 'chat' | 'workspace'

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
  const Icon = kind === 'chat' ? MessageSquare : PanelTop
  const label = compactTitle(title || fallbackId(id))
  const href = kind === 'workspace'
    ? buildPath(id, 'pinned')
    : workspaceId
      ? buildPath(workspaceId, 'pinned', { chat: id })
      : null
  const chipTitle = title ? `${kind === 'chat' ? 'Chat' : 'Workspace'}: ${title} (${id})` : id
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
      title={chipTitle}
      className={className}
    >
      {contents}
    </Link>
  )
}
