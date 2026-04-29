import { useState, useMemo, useRef, useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/PageHeader'
import { BoardView } from './BoardView'
import { TaskDetailPanel } from './TaskDetailPanel'
import { TaskSheet, type TaskCreateInput } from './TaskSheet'
import type { Task } from '@/data/ui-types'

interface TasksPageProps {
  tasks: Task[]
  /** Called when a board drop moves a task to a different column. Wires
   * through to PATCH /chats/:id/messages/:id in App.tsx. Intra-column
   * reorders don't fire this hook — the server has no ordering field. */
  onTaskMove?: (task: Task, newStatus: Task['status']) => Promise<void> | void
  onCreateTask?: (input: TaskCreateInput) => Promise<void> | void
}

export function TasksPage({ tasks, onTaskMove, onCreateTask }: TasksPageProps) {
  const [createSheetOpen, setCreateSheetOpen] = useState(false)
  const [defaultCreateStatus, setDefaultCreateStatus] = useState<Task['status']>('todo')
  const [selectedTask, setSelectedTask]   = useState<Task | null>(null)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [searchQuery, setSearchQuery]     = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Keep the selected task in sync with the underlying list: after a
  // lifecycle PATCH (pause/resume/cancel) invalidates the messages
  // query, the incoming `tasks` array carries the updated row.
  useEffect(() => {
    if (!selectedTask) return
    const fresh = tasks.find(t => t.id === selectedTask.id)
    if (!fresh) return
    if (fresh !== selectedTask) setSelectedTask(fresh)
  }, [tasks, selectedTask])

  const filteredTasks = useMemo(() => {
    if (!searchQuery.trim()) return tasks
    const q = searchQuery.toLowerCase()
    return tasks.filter(t => t.name.toLowerCase().includes(q))
  }, [tasks, searchQuery])

  function handleSelectTask(task: Task) {
    setSelectedTask(task)
    setPanelCollapsed(false)
  }

  const showPanel = selectedTask && !panelCollapsed

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">

      {/* ── Header bar ── */}
      <PageHeader
        breadcrumb={<span className="text-sm font-semibold">Tasks</span>}
        actions={<div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="h-8 w-40 rounded-md border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-ring/20 focus:border-ring/40 transition-all"
            />
          </div>

          <Button size="sm" data-testid="tasks-create" onClick={() => { setDefaultCreateStatus('todo'); setCreateSheetOpen(true) }}>
            Create
          </Button>
        </div>}
      />

      {/* ── Body ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          <BoardView
            tasks={filteredTasks}
            selectedTaskId={selectedTask?.id ?? null}
            onSelectTask={handleSelectTask}
            onTaskMove={(task, newStatus) => onTaskMove?.(task, newStatus)}
            onAddTask={status => {
              setDefaultCreateStatus(status)
              setCreateSheetOpen(true)
            }}
          />
        </div>

        <AnimatePresence>
          {showPanel && (
            <motion.div
              key={selectedTask.id}
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 360, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              className="shrink-0 flex flex-col border-l overflow-hidden"
              style={{ minWidth: 0 }}
            >
              <TaskDetailPanel
                task={selectedTask}
                onCollapse={() => { setPanelCollapsed(true); setSelectedTask(null) }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <TaskSheet
        open={createSheetOpen}
        onOpenChange={open => setCreateSheetOpen(open)}
        defaultStatus={defaultCreateStatus}
        onCreateTask={async (input) => {
          await onCreateTask?.(input)
          setCreateSheetOpen(false)
        }}
      />
    </div>
  )
}
