import { useState, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ConversationSidebar } from './ConversationSidebar'
import { ComposeThread } from './ComposeThread'
import type { Artifact } from '@/data/mock-data'
import type { ConversationMeta } from './ConversationSidebar'

interface ComposeShellProps {
  onBack: () => void
  onArtifactAdded: (artifact: Artifact) => void
  onArtifactClick: (artifact: Artifact) => void
}

// ── Auto-title ──────────────────────────────────────────────────────────────

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

// ── Mock conversation history ───────────────────────────────────────────────

const d = (daysAgo: number, hour = 10, min = 0) => {
  const dt = new Date('2026-04-20T00:00:00')
  dt.setDate(dt.getDate() - daysAgo)
  dt.setHours(hour, min, 0, 0)
  return dt
}

const MOCK_CONVERSATIONS: ConversationMeta[] = [
  // ── Today (April 20) ──
  { id: 'm-1',  title: 'Q2 Marketing Strategy updates',      createdAt: d(0,  9, 30), started: true },
  { id: 'm-2',  title: 'Tweaks to the expense tracker',      createdAt: d(0, 11, 15), started: true },
  { id: 'm-3',  title: "What's the churn rate in the Q1 report?", createdAt: d(0, 14,  0), started: true },
  // ── This week (Apr 13–19) ──
  { id: 'm-4',  title: 'Add dark mode to the landing page',  createdAt: d(2, 16, 45), started: true },
  { id: 'm-5',  title: 'Team offsite venue options',          createdAt: d(3, 10, 20), started: true },
  { id: 'm-6',  title: 'Customer interview patterns',         createdAt: d(5,  9,  0), started: true },
  { id: 'm-7',  title: 'Brand guidelines typography question',createdAt: d(6, 14, 30), started: true },
  // ── Earlier ──
  { id: 'm-8',  title: 'Product roadmap Q3 priorities',       createdAt: d(10, 11,  0), started: true },
  { id: 'm-9',  title: 'Set up weekly standup dashboard',     createdAt: d(12,  9, 30), started: true },
  { id: 'm-10', title: 'Build an expense tracker',            createdAt: d(15, 15,  0), started: true },
  { id: 'm-11', title: 'Summarise Q1 revenue data',           createdAt: d(17, 10,  0), started: true },
  { id: 'm-12', title: 'Logo refresh for creative project',   createdAt: d(21, 14,  0), started: true },
  { id: 'm-13', title: 'Landing page hero section copy',      createdAt: d(23,  9, 45), started: true },
  { id: 'm-14', title: 'Competitor analysis notes',           createdAt: d(26, 11, 30), started: true },
  { id: 'm-15', title: 'Email draft — Henderson project',     createdAt: d(31, 10,  0), started: true },
  { id: 'm-16', title: 'Color palette exploration',           createdAt: d(36,  9,  0), started: true },
]

// ── Counter for new conversations ───────────────────────────────────────────

let _counter = 0
function newConv(): ConversationMeta {
  _counter++
  return {
    id: `conv-${Date.now()}-${_counter}`,
    title: 'New conversation',
    createdAt: new Date(),
    started: false,
  }
}

// ── Component ───────────────────────────────────────────────────────────────

export function ComposeShell({ onBack, onArtifactAdded, onArtifactClick }: ComposeShellProps) {
  const [conversations, setConversations] = useState<ConversationMeta[]>(() => {
    const fresh = newConv()
    return [fresh, ...MOCK_CONVERSATIONS]
  })
  const [activeId, setActiveId]           = useState<string>(() => conversations[0].id)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId]   = useState<string | null>(null)

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleNew = useCallback(() => {
    const c = newConv()
    setConversations(prev => [c, ...prev])
    setActiveId(c.id)
  }, [])

  const handleSelect = useCallback((id: string) => setActiveId(id), [])

  const handleRename = useCallback((id: string, title: string) => {
    setConversations(prev => prev.map(c => c.id === id ? { ...c, title } : c))
  }, [])

  const requestDelete = useCallback((id: string) => setDeleteConfirmId(id), [])

  const confirmDelete = useCallback(() => {
    const id = deleteConfirmId
    if (!id) return
    setDeleteConfirmId(null)
    setConversations(prev => {
      const remaining = prev.filter(c => c.id !== id)
      if (remaining.length === 0) { onBack(); return prev }
      setActiveId(curr => {
        if (curr !== id) return curr
        const idx = prev.findIndex(c => c.id === id)
        return remaining[Math.max(0, idx - 1)].id
      })
      return remaining
    })
  }, [deleteConfirmId, onBack])

  // Mark conversation as started and auto-title it
  const handleFirstMessage = useCallback((convId: string, message: string) => {
    setConversations(prev => prev.map(c =>
      c.id === convId ? { ...c, title: autoTitle(message), started: true } : c
    ))
  }, [])

  const deleteTarget = conversations.find(c => c.id === deleteConfirmId)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-20 flex overflow-hidden">

      {/* Dark conversation sidebar — desktop only */}
      <AnimatePresence initial={false}>
        {!sidebarCollapsed && (
          <motion.div
            key="conv-sidebar"
            initial={{ width: 0 }}
            animate={{ width: 256 }}
            exit={{ width: 0 }}
            transition={{ type: 'spring', damping: 30, stiffness: 260 }}
            className="hidden md:block shrink-0 overflow-hidden"
          >
            <ConversationSidebar
              conversations={conversations}
              activeId={activeId}
              onBack={onBack}
              onNew={handleNew}
              onSelect={handleSelect}
              onRename={handleRename}
              onDelete={requestDelete}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat threads — all mounted, only active visible */}
      <motion.div
        initial={{ opacity: 0, x: 24 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 24 }}
        transition={{ type: 'spring', damping: 30, stiffness: 260 }}
        className="flex-1 flex flex-col min-w-0 overflow-hidden bg-background"
      >
        {conversations.map(conv => (
          <ComposeThread
            key={conv.id}
            isActive={conv.id === activeId}
            title={conv.title}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed(v => !v)}
            onBack={onBack}
            onRename={title => handleRename(conv.id, title)}
            onDelete={() => requestDelete(conv.id)}
            onFirstMessage={msg => handleFirstMessage(conv.id, msg)}
            onArtifactAdded={onArtifactAdded}
            onArtifactClick={onArtifactClick}
          />
        ))}
      </motion.div>

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteConfirmId !== null}
        onOpenChange={open => { if (!open) setDeleteConfirmId(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.title}" will be permanently deleted. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
