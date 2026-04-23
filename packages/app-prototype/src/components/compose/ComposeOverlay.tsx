import { useState, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft, MoreHorizontal, PanelRight, PanelRightClose,
  Search, FileText, ChevronDown, Link2, StickyNote, Paperclip, Plus, X, Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ComposeThread } from './ComposeThread'
import type { Artifact, ContextItem } from '@/data/mock-data'
import { MOCK_ARTIFACTS, MOCK_CONTEXT, getArtifactIcon, getRelativeTime } from '@/data/mock-data'
import { ArtifactsEmptyState, FilesEmptyState } from '@/components/shared/PanelEmptyStates'

// ── Types ─────────────────────────────────────────────────────────────────────

type RightTab = 'artifacts' | 'files'
type ArtifactFilter = 'all' | 'document' | 'app' | 'image' | 'spreadsheet' | 'site'

interface ComposeOverlayProps {
  onClose: () => void
  onArtifactAdded: (artifact: Artifact) => void
  onArtifactClick: (artifact: Artifact) => void
  onSaveArtifact?: (artifact: Artifact) => void
  initialChatId?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function autoTitle(message: string): string {
  const lower = message.toLowerCase().trim()
  if (lower.match(/expense|budget|cost/))               return 'Expense tracking'
  if (lower.match(/marketing|campaign|strategy/))       return 'Marketing strategy'
  if (lower.match(/brief|proposal/))                    return 'Project brief'
  if (lower.match(/summar(i[sz]e|y)/))                  return 'Content summary'
  if (lower.match(/roadmap/))                           return 'Product roadmap'
  if (lower.match(/report/))                            return 'Weekly report'
  if (lower.match(/plan|planning/))                     return 'Planning notes'
  if (lower.match(/design|color|colour|palette|logo/)) return 'Design work'
  if (lower.match(/app|build|tracker|dashboard/))       return 'App project'
  if (lower.match(/site|website|landing/))              return 'Website project'
  const t = message.trim()
  return t.length > 34 ? t.slice(0, 33).trimEnd() + '…' : t
}

const ARTIFACT_TYPE_LABELS: Record<string, string> = {
  document: 'Doc', app: 'App', image: 'Image', spreadsheet: 'Sheet', site: 'Site',
}

const CONTEXT_ICON: Record<ContextItem['type'], typeof FileText> = {
  file: FileText,
  note: StickyNote,
  link: Link2,
}

// Pre-seeded "recent" artifacts shown in the panel at session start
const INITIAL_ARTIFACTS = ['art-5', 'art-3', 'art-4'].map(
  id => MOCK_ARTIFACTS.find(a => a.id === id)!
)

// Pre-seeded files for the session (research notes & brief that inspired this task)
const INITIAL_FILE_IDS = ['ctx-1', 'ctx-3', 'ctx-6']

// ── Artifacts panel ───────────────────────────────────────────────────────────

function ArtifactsPanel({
  artifacts,
  onArtifactClick,
}: {
  artifacts: Artifact[]
  onArtifactClick?: (artifact: Artifact) => void
}) {
  const [filter, setFilter] = useState<ArtifactFilter>('all')
  const [search, setSearch] = useState('')

  const filtered = artifacts.filter(a => {
    if (filter !== 'all' && a.type !== filter) return false
    if (search.trim() && !a.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  if (artifacts.length === 0) {
    return <ArtifactsEmptyState />
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-full h-7 pl-6 pr-2 rounded-md border bg-background text-xs outline-none placeholder:text-muted-foreground/50 focus:ring-1 focus:ring-ring/30"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 h-7 px-2 rounded-md border bg-background text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0">
              {filter === 'all' ? 'All types' : ARTIFACT_TYPE_LABELS[filter]}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            {(['all', 'document', 'app', 'image', 'spreadsheet', 'site'] as const).map(f => (
              <DropdownMenuItem key={f} onClick={() => setFilter(f)} className={filter === f ? 'bg-muted/50' : ''}>
                {f === 'all' ? 'All types' : ARTIFACT_TYPE_LABELS[f]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex-1 overflow-y-auto py-1.5 px-1.5 flex flex-col gap-0.5">
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">No results</p>
        ) : (
          filtered.map((artifact) => {
            const Icon = getArtifactIcon(artifact.type)
            return (
              <button
                key={artifact.id}
                onClick={() => onArtifactClick?.(artifact)}
                className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-lg hover:bg-muted/50 transition-colors text-left"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Icon className="h-4 w-4 text-muted-foreground/70" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{artifact.name}</p>
                  <p className="text-xs text-muted-foreground">{ARTIFACT_TYPE_LABELS[artifact.type]} · {getRelativeTime(artifact.updatedAt)}</p>
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── Files panel ───────────────────────────────────────────────────────────────

function FilesPanel({ initialReferenceIds }: { initialReferenceIds: string[] }) {
  const [refs, setRefs] = useState<ContextItem[]>(() =>
    initialReferenceIds.map(id => MOCK_CONTEXT.find(c => c.id === id)).filter(Boolean) as ContextItem[]
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pickerSearch, setPickerSearch] = useState('')

  const filteredRefs = refs.filter(r =>
    !search.trim() || r.name.toLowerCase().includes(search.toLowerCase())
  )
  const available = MOCK_CONTEXT.filter(
    c => !refs.some(r => r.id === c.id) &&
    (!pickerSearch || c.name.toLowerCase().includes(pickerSearch.toLowerCase()))
  )

  const removeRef = (id: string) => setRefs(prev => prev.filter(r => r.id !== id))
  const addRef = (item: ContextItem) => {
    setRefs(prev => [...prev, item])
    setPickerOpen(false)
    setPickerSearch('')
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-full h-7 pl-6 pr-2 rounded-md border bg-background text-xs outline-none placeholder:text-muted-foreground/50 focus:ring-1 focus:ring-ring/30"
          />
        </div>
        <div className="relative shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={() => { setPickerOpen(v => !v); setPickerSearch('') }}
          >
            <Plus className="h-3 w-3" />
            Add
          </Button>

          {pickerOpen && (
            <div className="absolute right-0 top-full mt-1 w-72 rounded-lg border bg-background shadow-lg z-50 overflow-hidden flex flex-col">
              <div className="flex items-center gap-2 px-3 py-2 border-b">
                <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <input
                  autoFocus
                  value={pickerSearch}
                  onChange={e => setPickerSearch(e.target.value)}
                  placeholder="Search files…"
                  className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground/50"
                />
                <button onClick={() => setPickerOpen(false)} className="text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="overflow-y-auto max-h-52">
                {available.length === 0 && (
                  <p className="px-3 py-4 text-xs text-muted-foreground text-center">
                    {pickerSearch ? 'No results' : 'All library items already added'}
                  </p>
                )}
                {available.map(item => {
                  const Icon = CONTEXT_ICON[item.type] ?? FileText
                  return (
                    <button
                      key={item.id}
                      onClick={() => addRef(item)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left"
                    >
                      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate">{item.name}</span>
                    </button>
                  )
                })}
              </div>
              <div className="border-t">
                <button
                  onClick={() => addRef({ id: `upload-${Date.now()}`, type: 'file', name: 'Uploaded file.pdf', content: '', addedAt: new Date(), usedBy: [], uploadedBy: 'user', relatedArtifactIds: [] })}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left text-muted-foreground"
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0" />
                  <span>Upload a file…</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1.5 px-1.5 flex flex-col gap-0.5">
        {refs.length === 0 ? (
          <FilesEmptyState />
        ) : filteredRefs.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">No results</p>
        ) : (
          filteredRefs.map(ref => {
            const Icon = CONTEXT_ICON[ref.type] ?? FileText
            return (
              <div key={ref.id} className="group flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-muted/40 transition-colors">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{ref.name}</p>
                  <p className="text-xs text-muted-foreground capitalize">{ref.type}</p>
                </div>
                <button
                  onClick={() => removeRef(ref.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                  title="Remove from chat"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── Main ComposeOverlay ───────────────────────────────────────────────────────

export function ComposeOverlay({ onClose, onArtifactAdded, onArtifactClick, onSaveArtifact }: ComposeOverlayProps) {
  const [title, setTitle]                       = useState('New conversation')
  const [hasStarted, setHasStarted]             = useState(false)
  const [panelOpen, setPanelOpen]               = useState(true)
  const [rightTab, setRightTab]                 = useState<RightTab>('artifacts')
  const [sessionArtifacts, setSessionArtifacts] = useState<Artifact[]>([])

  // Escape closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleArtifactAdded = useCallback((artifact: Artifact) => {
    setSessionArtifacts(prev => [artifact, ...prev])
    onArtifactAdded(artifact)
  }, [onArtifactAdded])

  const handleFirstMessage = useCallback((message: string) => {
    setTitle(autoTitle(message))
    // Populate panel with mock data and fly it in on first send
    setSessionArtifacts(INITIAL_ARTIFACTS)
    setHasStarted(true)
    setPanelOpen(true)
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex h-screen bg-background overflow-hidden">

      {/* ── Left column: header + thread ── */}
      <div className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-2 border-b px-4 py-2.5 shrink-0">
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full shrink-0" onClick={onClose}>
            <ArrowLeft className="h-4 w-4" />
          </Button>

          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium truncate block">{title}</span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem>Rename</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={onClose}
                >
                  Clear &amp; close
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {!panelOpen && (
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPanelOpen(true)}>
                <PanelRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Thread */}
        <ComposeThread
          isActive={true}
          onArtifactAdded={handleArtifactAdded}
          onArtifactClick={onArtifactClick}
          onFirstMessage={handleFirstMessage}
          onSaveArtifact={onSaveArtifact}
        />
      </div>

      {/* ── Right panel: animates in after first message ── */}
      <AnimatePresence>
        {panelOpen && (
          <motion.div
            key="compose-panel"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 280, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="shrink-0 flex flex-col border-l overflow-hidden"
            style={{ minWidth: 0 }}
          >
            {/* Fixed-width inner so content doesn't squish during animation */}
            <div className="w-[280px] flex flex-col h-full">
              {/* Panel header — same height as main header */}
              <div className="flex items-center justify-between px-3 border-b shrink-0" style={{ height: '53px' }}>
                <div className="flex items-center h-8 bg-muted rounded-full p-0.5">
                  {(['artifacts', 'files'] as RightTab[]).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setRightTab(tab)}
                      className={`rounded-full px-3 text-xs font-medium capitalize transition-colors h-full flex items-center ${
                        rightTab === tab
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {tab === 'files' ? 'Files' : 'Artifacts'}
                    </button>
                  ))}
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setPanelOpen(false)}>
                  <PanelRightClose className="h-4 w-4" />
                </Button>
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-hidden flex flex-col">
                {rightTab === 'artifacts' && (
                  <ArtifactsPanel
                    artifacts={sessionArtifacts}
                    onArtifactClick={onArtifactClick}
                  />
                )}
                {rightTab === 'files' && (
                  <FilesPanel
                    key={hasStarted ? 'started' : 'empty'}
                    initialReferenceIds={hasStarted ? INITIAL_FILE_IDS : []}
                  />
                )}

              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  )
}
