import { useState, useRef, useEffect } from 'react'
import { PanelRightClose, Plus, MoreHorizontal, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface ConversationMeta {
  id: string
  title: string
  createdAt: Date
  started: boolean
}

interface ConversationSidebarProps {
  conversations: ConversationMeta[]
  activeId: string
  onNew: () => void
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onCollapse: () => void
}

// ── Time helpers ─────────────────────────────────────────────────────────────

type Section = 'today' | 'this-week' | 'earlier'

function getSection(date: Date): Section {
  const now     = new Date()
  const today   = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7)
  if (date >= today)   return 'today'
  if (date >= weekAgo) return 'this-week'
  return 'earlier'
}

const SECTION_LABELS: Record<Section, string> = {
  'today':     'Today',
  'this-week': 'This week',
  'earlier':   'Earlier',
}

const INITIAL_VISIBLE = 3

// ── Component ────────────────────────────────────────────────────────────────

export function ConversationSidebar({
  conversations, activeId, onNew, onSelect, onRename, onDelete, onCollapse,
}: ConversationSidebarProps) {
  const [expanded, setExpanded] = useState<Record<Section, boolean>>({
    'today': false, 'this-week': false, 'earlier': false,
  })
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId && renameRef.current) {
      renameRef.current.focus()
      renameRef.current.select()
    }
  }, [renamingId])

  const startRename = (id: string, currentTitle: string) => {
    setRenameValue(currentTitle)
    setRenamingId(id)
  }

  const commitRename = () => {
    if (renamingId && renameValue.trim()) onRename(renamingId, renameValue.trim())
    setRenamingId(null)
  }

  const started = conversations.filter(c => c.started)

  const bySection: Record<Section, ConversationMeta[]> = {
    'today':     started.filter(c => getSection(c.createdAt) === 'today'),
    'this-week': started.filter(c => getSection(c.createdAt) === 'this-week'),
    'earlier':   started.filter(c => getSection(c.createdAt) === 'earlier'),
  }

  const sections: Section[] = ['today', 'this-week', 'earlier']

  return (
    <div className="flex flex-col h-full w-[280px] border-l bg-background overflow-hidden">

      {/* ── Panel header ── */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0">
        <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={onNew}>
          <Plus className="h-3.5 w-3.5" />
          New conversation
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onCollapse}>
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>

      {/* ── Scrollable list ── */}
      <div className="flex-1 overflow-y-auto px-2 py-3 min-h-0">
        <div className="space-y-5">
          {sections.map(section => {
            const items = bySection[section]
            if (items.length === 0) return null
            const isExpanded = expanded[section]
            const visible = isExpanded ? items : items.slice(0, INITIAL_VISIBLE)
            const hasMore = items.length > INITIAL_VISIBLE

            return (
              <div key={section}>
                {/* Section label */}
                <div className="group flex items-center justify-between px-2 mb-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {SECTION_LABELS[section]}
                  </span>
                  {hasMore && (
                    <ChevronDown
                      className={`h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-all ${isExpanded ? 'rotate-180' : ''}`}
                    />
                  )}
                </div>

                {/* Items */}
                <div className="space-y-0.5">
                  {visible.map(conv => (
                    <ConversationItem
                      key={conv.id}
                      conv={conv}
                      isActive={conv.id === activeId}
                      isRenaming={renamingId === conv.id}
                      renameValue={renameValue}
                      renameRef={renameRef}
                      onSelect={() => onSelect(conv.id)}
                      onStartRename={() => startRename(conv.id, conv.title)}
                      onRenameChange={setRenameValue}
                      onRenameCommit={commitRename}
                      onRenameCancel={() => setRenamingId(null)}
                      onDelete={() => onDelete(conv.id)}
                    />
                  ))}

                  {hasMore && (
                    <button
                      onClick={() => setExpanded(prev => ({ ...prev, [section]: !prev[section] }))}
                      className="flex items-center gap-2 w-full px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                    >
                      <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', isExpanded && 'rotate-180')} />
                      <span>{isExpanded ? 'Show less' : 'See more'}</span>
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Single conversation item ──────────────────────────────────────────────────

interface ConversationItemProps {
  conv: ConversationMeta
  isActive: boolean
  isRenaming: boolean
  renameValue: string
  renameRef: React.RefObject<HTMLInputElement | null>
  onSelect: () => void
  onStartRename: () => void
  onRenameChange: (v: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onDelete: () => void
}

function ConversationItem({
  conv, isActive, isRenaming, renameValue, renameRef,
  onSelect, onStartRename, onRenameChange, onRenameCommit, onRenameCancel, onDelete,
}: ConversationItemProps) {
  return (
    <div
      onClick={onSelect}
      className={`group relative flex items-center gap-2 h-8 px-2 rounded-md cursor-pointer transition-colors ${
        isActive
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
    >
      {isRenaming ? (
        <input
          ref={renameRef}
          value={renameValue}
          onChange={e => onRenameChange(e.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={e => {
            if (e.key === 'Enter') onRenameCommit()
            if (e.key === 'Escape') onRenameCancel()
          }}
          onClick={e => e.stopPropagation()}
          className="flex-1 min-w-0 bg-transparent text-sm outline-none text-foreground"
        />
      ) : (
        <span className="flex-1 min-w-0 text-sm truncate">{conv.title}</span>
      )}

      {!isRenaming && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              onClick={e => e.stopPropagation()}
              className="shrink-0 h-6 w-6 flex items-center justify-center rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-foreground/8 transition-all"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom" className="w-32">
            <DropdownMenuItem onClick={e => { e.stopPropagation(); onStartRename() }}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={e => { e.stopPropagation(); onDelete() }}
              className="text-destructive focus:text-destructive"
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
