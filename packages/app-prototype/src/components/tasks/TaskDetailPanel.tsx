import { useState, useEffect } from 'react'
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
  Clock,
  PauseCircle,
  Calendar,
  MessageSquare,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import type { Task, TaskOccurrence } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { useGetAgentsQuery, usePatchMessageMutation } from '@/store/api'
import { buildPath } from '@/router/nav'
import { StatusBadge, PriorityIcon, PRIORITY_LABELS, PRIORITY_CONFIG } from './task-badges'
import type { Priority } from './task-badges'

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
  const [activeTab, setActiveTab]             = useState<PanelTab>('details')
  const [historyOpen, setHistoryOpen]         = useState(true)
  const [showAllHistory, setShowAllHistory]   = useState(false)
  const [instructionsOpen, setInstructionsOpen] = useState(true)
  const navigate = useNavigate()
  const { wsId = '' } = useParams<{ wsId: string }>()

  const { data: agents } = useGetAgentsQuery()
  const [patchMessage, patchState] = usePatchMessageMutation()

  useEffect(() => {
    setShowAllHistory(false)
    setActiveTab('details')
  }, [task.id])

  // "History" is past-only — filter the synthesized upcoming preview
  // occurrences (id ends with `-upcoming`) that the calendar uses to
  // place scheduled tasks on their future date. Ordered old → new.
  const history = (task.history ?? [])
    .filter(occ => !occ.id.endsWith('-upcoming'))
    .slice()
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  const visibleHistory = showAllHistory ? history : history.slice(-5)

  async function transition(nextState: 'paused' | 'pending' | 'cancelled') {
    if (!task.chatId || !task.messageId) {
      toast.error('This task is not wired to a server message yet')
      return
    }
    try {
      await patchMessage({
        chatId: task.chatId,
        messageId: task.messageId,
        patch: { state: nextState },
      }).unwrap()
    } catch (err) {
      toast.error('Action failed', { description: describeApiError(err) })
    }
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

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-background">
      {/* Header */}
      <div className="h-[52px] flex items-center justify-between px-4 border-b shrink-0">
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
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onCollapse}>
          <X className="h-4 w-4" />
        </Button>
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

          {/* Name + lifecycle */}
          <div className="px-4 py-4 border-b space-y-3">
            <h2 className="text-sm font-semibold text-foreground">{task.name}</h2>

            {(() => {
              // Pick exactly one alert based on the underlying lifecycle
              // state. `task.statusText` carrying "Paused" wins because
              // server-side `paused` collapses into our `scheduled` UI
              // status — the Paused alert is the right action surface.
              const isPaused = task.statusText.toLowerCase().includes('paused')
              if (isPaused) {
                return (
                  <Alert className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                    <PauseCircle className="text-amber-500" />
                    <AlertTitle>Paused</AlertTitle>
                    {task.statusText && <AlertDescription className="text-amber-700 dark:text-amber-300">{task.statusText}</AlertDescription>}
                    <div className="col-start-2 flex gap-2 mt-3">
                      <Button variant="outline" size="sm" data-testid="task-resume" disabled={busy} onClick={() => transition('pending')}>Resume</Button>
                      <Button variant="outline" size="sm" data-testid="task-cancel" disabled={busy} onClick={() => transition('cancelled')}>Cancel</Button>
                    </div>
                  </Alert>
                )
              }
              if (task.status === 'active') {
                return (
                  <Alert>
                    <Loader2 className="animate-spin text-blue-500" />
                    <AlertTitle>Active</AlertTitle>
                    {task.statusText && <AlertDescription>{task.statusText}</AlertDescription>}
                    <div className="col-start-2 flex gap-2 mt-3">
                      <Button variant="outline" size="sm" data-testid="task-pause" disabled={busy} onClick={() => transition('paused')}>Pause</Button>
                      <Button variant="outline" size="sm" data-testid="task-cancel" disabled={busy} onClick={() => transition('cancelled')}>Cancel</Button>
                    </div>
                  </Alert>
                )
              }
              if (task.status === 'scheduled') {
                return (
                  <Alert>
                    <Clock className="text-muted-foreground" />
                    <AlertTitle>Scheduled</AlertTitle>
                    {task.statusText && <AlertDescription>{task.statusText}</AlertDescription>}
                    <div className="col-start-2 flex gap-2 mt-3">
                      <Button variant="outline" size="sm" data-testid="task-pause" disabled={busy} onClick={() => transition('paused')}>Pause</Button>
                      <Button variant="outline" size="sm" data-testid="task-cancel" disabled={busy} onClick={() => transition('cancelled')}>Cancel</Button>
                    </div>
                  </Alert>
                )
              }
              if (task.status === 'complete') {
                return (
                  <Alert>
                    <CheckCircle2 className="text-emerald-500" />
                    <AlertTitle>Complete</AlertTitle>
                    {task.statusText && <AlertDescription>{task.statusText}</AlertDescription>}
                  </Alert>
                )
              }
              return (
                <Alert>
                  <Clock className="text-muted-foreground" />
                  <AlertTitle>To do</AlertTitle>
                  {task.statusText && <AlertDescription>{task.statusText}</AlertDescription>}
                </Alert>
              )
            })()}
          </div>

          {/* Meta rows */}
          <div className="px-4 py-3 border-b space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Status</span>
              <StatusBadge status={task.status} small />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Assignee</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-px text-[11px] font-medium text-foreground">
                {!task.assigneeId || task.assigneeId === 'user'
                  ? <User className="h-3 w-3 text-muted-foreground shrink-0" />
                  : <Bot className="h-3 w-3 text-muted-foreground shrink-0" />}
                {assigneeLabel}
              </span>
            </div>

            {task.priority && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Priority</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="hover:opacity-70 transition-opacity">
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-px text-[11px] font-medium text-foreground">
                        <PriorityIcon priority={task.priority} className="!h-3 !w-3" />
                        {PRIORITY_LABELS[task.priority]}
                      </span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-36">
                    {(['highest', 'high', 'medium', 'low'] as Priority[]).map(p => {
                      const { icon: Icon, iconClass } = PRIORITY_CONFIG[p]
                      return (
                        <DropdownMenuItem key={p} className="gap-2">
                          <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
                          {PRIORITY_LABELS[p]}
                        </DropdownMenuItem>
                      )
                    })}
                    <DropdownMenuSeparator />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}

            {task.schedule && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Schedule</span>
                <div className="flex items-center gap-1.5">
                  <Calendar className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs text-foreground">{task.schedule}</span>
                </div>
              </div>
            )}

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

            {task.hasRealStartedAt && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Last run</span>
                <span className="text-xs text-foreground">{getRelativeTime(task.startedAt)}</span>
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Agent</span>
              <span className="text-xs text-foreground">{task.agentName}</span>
            </div>
          </div>

          {/* Instructions */}
          {task.description && (
            <div className="border-b">
              <button
                onClick={() => setInstructionsOpen(v => !v)}
                className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors"
              >
                <span className="text-sm font-medium">Instructions</span>
                {instructionsOpen
                  ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </button>
              {instructionsOpen && (
                <div className="px-4 pb-3">
                  <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                    {task.description}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* History */}
          <div className="border-b">
            <button
              onClick={() => setHistoryOpen(v => !v)}
              className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors"
            >
              <span className="text-sm font-medium">History</span>
              {historyOpen
                ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </button>

            {historyOpen && (
              <div className="pb-2">
                {history.length === 0 ? (
                  <p className="px-4 py-2 text-xs text-muted-foreground" data-testid="task-history-empty">No history yet.</p>
                ) : (
                  <>
                    {history.length > 5 && !showAllHistory && (
                      <button
                        onClick={() => setShowAllHistory(true)}
                        className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors text-left"
                      >
                        Show {history.length - 5} earlier…
                      </button>
                    )}
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
