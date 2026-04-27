import { useState, useRef, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  X,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  User,
  Bot,
  Loader2,
  CheckCircle2,
  MessageSquare,
  Pause,
  Play,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Task, TaskOccurrence } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { useGetAgentsQuery, usePatchMessageMutation } from '@/store/api'
import { buildPath } from '@/router/nav'
import { StatusBadge, PriorityIcon, PRIORITY_LABELS } from './task-badges'
import { usePersistedState } from '@/hooks/use-persisted-state'
import { ScheduleEditor, type SchedulePatch } from './ScheduleEditor'

type PanelTab = 'details' | 'chat'

interface TaskDetailPanelProps {
  task: Task
  onCollapse: () => void
}

// RTK Query rejects with `{ status, data }`, not an Error.
function describeApiError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { data?: { message?: unknown }; error?: unknown }
    if (typeof e.data?.message === 'string') return e.data.message
    if (typeof e.error === 'string') return e.error
  }
  if (err instanceof Error) return err.message
  return 'Unknown error'
}

function OccurrenceStatusIcon({ status }: { status: TaskOccurrence['status'] }) {
  switch (status) {
    case 'active':    return <Loader2     className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
    case 'completed': return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
    case 'failed':    return <AlertCircle  className="h-3.5 w-3.5 text-red-500 shrink-0" />
  }
}

export function TaskDetailPanel({ task, onCollapse }: TaskDetailPanelProps) {
  const descRef = useRef<HTMLParagraphElement>(null)
  const [activeTab, setActiveTab]             = usePersistedState<PanelTab>(`desk.task.${task.id}.tab`, 'details')
  const [historyOpen, setHistoryOpen]         = useState(true)
  const [showAllHistory, setShowAllHistory]   = useState(false)
  const [instructionsOpen, setInstructionsOpen] = useState(true)
  const [showFullInstructions, setShowFullInstructions] = useState(false)
  const [isDescClamped, setIsDescClamped]     = useState(false)
  const navigate = useNavigate()
  const { wsId = '' } = useParams<{ wsId: string }>()

  const { data: agents } = useGetAgentsQuery()
  const [patchMessage, patchState] = usePatchMessageMutation()

  useEffect(() => {
    setShowAllHistory(false)
    setShowFullInstructions(false)
    setIsDescClamped(false)
  }, [task.id])

  useEffect(() => {
    if (!instructionsOpen || !descRef.current) return
    setIsDescClamped(descRef.current.scrollHeight > descRef.current.clientHeight)
  }, [task.description, instructionsOpen])

  // "History" is past-only — filter the synthesized upcoming preview
  // occurrences (id ends with `-upcoming`) that the calendar uses to
  // place scheduled tasks on their future date. Newest-first.
  const history = (task.history ?? [])
    .filter(occ => !occ.id.endsWith('-upcoming'))
    .slice()
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
  const visibleHistory = showAllHistory ? history : history.slice(0, 5)

  const isPaused = task.statusText.toLowerCase().includes('paused')

  async function transition(nextState: 'paused' | 'pending' | 'cancelled', extra?: { executeAt?: string | null }) {
    if (!task.chatId || !task.messageId) {
      toast.error('This task is not wired to a server message yet')
      return
    }
    try {
      await patchMessage({
        chatId: task.chatId,
        messageId: task.messageId,
        patch: { state: nextState, ...(extra ?? {}) },
      }).unwrap()
    } catch (err) {
      toast.error('Action failed', { description: describeApiError(err) })
    }
  }

  function changeStatus(next: Task['status']) {
    if (next === task.status && !isPaused) return
    if (next === 'active') {
      toast.message('"Active" is set by the server when the task fires.')
      return
    }
    if (next === 'todo')      void transition('pending', { executeAt: null })
    if (next === 'complete')  void transition('cancelled')
    if (next === 'scheduled') void transition('pending')
  }

  const openInChat = () => {
    if (!task.chatId || !wsId) return
    navigate(buildPath(wsId, 'desk', { chat: task.chatId, message: task.messageId ?? null }))
  }

  const busy = patchState.isLoading
  const assigneeAgent = agents?.find(a => a.id === task.assigneeId)
  const assigneeLabel = !task.assigneeId || task.assigneeId === 'user'
    ? 'You'
    : assigneeAgent?.name ?? task.agentName ?? 'Agent'

  const [scheduleOpen, setScheduleOpen] = useState(false)

  async function applySchedulePatch(patch: SchedulePatch) {
    if (!task.chatId || !task.messageId) {
      toast.error('This task is not wired to a server message yet')
      return
    }
    try {
      // Server enforces state-transition rules (e.g. paused→pending only),
      // so we only ride the schedule fields here. If the task was paused,
      // the user can resume it separately via the Resume button.
      await patchMessage({
        chatId: task.chatId,
        messageId: task.messageId,
        patch,
      }).unwrap()
    } catch (err) {
      toast.error('Couldn’t update schedule', { description: describeApiError(err) })
    }
  }

  // What the Schedule row shows when not editing.
  const scheduleLabel = task.schedule
    ? task.schedule
    : task.scheduledFor
      ? `${task.scheduledFor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${task.scheduledFor.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
      : 'Not scheduled'

  // The status the dropdown highlights as "current" — paused tasks live
  // under the Scheduled column in the UI, so reflect that.
  const effectiveStatus: Task['status'] = isPaused ? 'scheduled' : task.status
  const canPause  = !isPaused && (task.status === 'active' || task.status === 'scheduled')
  const canResume = isPaused
  const canCancel = task.status !== 'complete'

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-background">
      {/* Header */}
      <div className="h-[52px] flex items-center justify-between px-4 border-b shrink-0 gap-2">
        <div className="flex items-center h-8 bg-muted rounded-full p-0.5">
          {(['details', 'chat'] as PanelTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`rounded-full px-3 text-xs font-medium capitalize transition-colors h-full ${
                activeTab === tab
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab === 'chat' ? 'Chat' : 'Details'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          {canPause && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              data-testid="task-pause"
              title="Pause"
              disabled={busy}
              onClick={() => void transition('paused')}
            >
              <Pause className="h-4 w-4" />
            </Button>
          )}
          {canResume && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              data-testid="task-resume"
              title="Resume"
              disabled={busy}
              onClick={() => void transition('pending')}
            >
              <Play className="h-4 w-4" />
            </Button>
          )}
          {canCancel && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
              data-testid="task-cancel"
              title="Cancel"
              disabled={busy}
              onClick={() => void transition('cancelled')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onCollapse}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Chat tab */}
      {activeTab === 'chat' && (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="text-sm text-foreground font-medium">Originating chat</p>
            <p className="text-xs text-muted-foreground mt-1">
              This task was created in a chat. Open it to see the full conversation and jump to the scheduled message.
            </p>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              data-testid="open-in-chat"
              disabled={!task.chatId}
              onClick={openInChat}
            >
              <MessageSquare className="mr-2 h-3.5 w-3.5" />
              Open in chat
            </Button>
          </div>
        </div>
      )}

      {/* Details tab */}
      {activeTab === 'details' && (
        <div className="flex-1 overflow-y-auto">

          {/* Name + meta block */}
          <div className="px-4 py-4 border-b">
            <h2 className="text-sm font-semibold text-foreground">{task.name}</h2>
            <div className="mt-4 space-y-2.5">

              {/* Status */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Status</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild disabled={busy}>
                    <button data-testid="task-status-trigger" className="hover:opacity-70 transition-opacity disabled:opacity-50" disabled={busy}>
                      {isPaused ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-px text-[11px] font-medium text-amber-700">
                          <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-amber-500" />
                          Paused
                        </span>
                      ) : (
                        <StatusBadge status={effectiveStatus} small />
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    {(['todo', 'scheduled', 'complete'] as Task['status'][]).map(s => (
                      <DropdownMenuItem key={s} onSelect={() => changeStatus(s)} className="gap-2">
                        <StatusBadge status={s} />
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Assignee */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Assignee</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-px text-[11px] font-medium text-foreground">
                  {!task.assigneeId || task.assigneeId === 'user'
                    ? <User className="h-3 w-3 text-muted-foreground shrink-0" />
                    : <Bot className="h-3 w-3 text-muted-foreground shrink-0" />}
                  {assigneeLabel}
                </span>
              </div>

              {/* Priority */}
              {task.priority && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Priority</span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-px text-[11px] font-medium text-foreground">
                    <PriorityIcon priority={task.priority} className="!h-3 !w-3" />
                    {PRIORITY_LABELS[task.priority]}
                  </span>
                </div>
              )}

              {/* Schedule (editable) */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Schedule</span>
                <Popover open={scheduleOpen} onOpenChange={setScheduleOpen}>
                  <PopoverTrigger asChild disabled={busy}>
                    <button
                      data-testid="task-schedule-trigger"
                      className="text-xs text-foreground hover:opacity-70 transition-opacity disabled:opacity-50 underline-offset-4 hover:underline"
                      disabled={busy}
                    >
                      {scheduleLabel}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-auto p-0">
                    <ScheduleEditor
                      currentExecuteAt={task.scheduledFor}
                      currentCron={task.schedule}
                      busy={busy}
                      onSave={applySchedulePatch}
                      onClear={() => applySchedulePatch({ executeAt: null, cron: null })}
                      onClose={() => setScheduleOpen(false)}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              {/* Next run — computed, read-only */}
              {task.nextRun && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Next run</span>
                  <span className="text-xs text-foreground">
                    {task.nextRun.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    {' at '}
                    {task.nextRun.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
              )}

              {/* Last run */}
              {task.hasRealStartedAt && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Last run</span>
                  <span className="text-xs text-foreground">{getRelativeTime(task.startedAt)}</span>
                </div>
              )}

            </div>{/* end meta rows */}
          </div>{/* end name + meta block */}

          {/* Instructions collapsible */}
          {task.description && (
            <div className="border-b">
              <button
                onClick={() => setInstructionsOpen(v => !v)}
                className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors"
              >
                <span className="text-sm font-medium">Instructions</span>
                {instructionsOpen
                  ? <ChevronDown  className="h-4 w-4 text-muted-foreground" />
                  : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </button>
              {instructionsOpen && (
                <div className="px-4 pb-3">
                  <p
                    ref={descRef}
                    className={`text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap ${!showFullInstructions ? 'line-clamp-[10]' : ''}`}
                  >
                    {task.description}
                  </p>
                  {!showFullInstructions && isDescClamped && (
                    <button
                      onClick={() => setShowFullInstructions(true)}
                      className="mt-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Show more
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* History collapsible */}
          <div className="border-b">
            <button
              onClick={() => setHistoryOpen(v => !v)}
              className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors"
            >
              <span className="text-sm font-medium">History</span>
              {historyOpen
                ? <ChevronDown  className="h-4 w-4 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </button>

            {historyOpen && (
              <div className="pb-2">
                {history.length === 0 ? (
                  <p className="px-4 py-2 text-xs text-muted-foreground" data-testid="task-history-empty">No history yet.</p>
                ) : (
                  <>
                    {visibleHistory.map(occ => (
                      <div
                        key={occ.id}
                        className="flex items-start gap-2.5 px-4 py-2 hover:bg-muted/30 transition-colors"
                      >
                        <OccurrenceStatusIcon status={occ.status} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-foreground">
                            {occ.startedAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                            {' · '}
                            {occ.startedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                          </p>
                          {occ.statusText && (
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">{occ.statusText}</p>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {getRelativeTime(occ.startedAt)}
                        </span>
                      </div>
                    ))}
                    {history.length > 5 && !showAllHistory && (
                      <button
                        onClick={() => setShowAllHistory(true)}
                        className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors text-left"
                      >
                        Show {history.length - 5} more…
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
