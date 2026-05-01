import { useState, useRef, useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  X,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  User,
  Bot,
  Loader2,
  CheckCircle2,
  Check,
  Clock,
  Repeat,
  Pause,
  Play,
  Trash2,
  ExternalLink,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import type { Task, TaskOccurrence } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { buildPath } from '@/router/nav'
import {
  useGetAgentsQuery,
  usePatchMessageMutation,
  useRunMessageMutation,
  usePostChatMessageMutation,
  useDeleteChatMutation,
} from '@/store/api'
import { ChatThread } from '@/components/compose/ChatThread'
import { ChatInput } from '@/components/compose/ChatInput'
import type { ServerMessage } from '@/store/types'
import { StatusBadge, PriorityIcon, PRIORITY_LABELS } from './task-badges'
import { usePersistedState } from '@/hooks/use-persisted-state'
import { usePrefs } from '@/hooks/use-prefs'
import { ScheduleEditor, type SchedulePatch } from './ScheduleEditor'
import { describeCron } from './schedule-utils'

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

// Task-panel chat shows only follow-up conversation messages, not the task
// definition row itself. This filter is stable (module-level) so useMemo
// inside ChatThread does not recompute on every render.
const hidePanelTaskRows = (m: ServerMessage) => m.kind !== 'task'

function ChatInPanel({ chatId, agentName, messageId }: { chatId: string; agentName?: string; messageId?: string }) {
  const { wsId } = useParams<{ wsId: string }>()
  const { developerMode } = usePrefs()
  const [postMessage] = usePostChatMessageMutation()
  const [isSending, setIsSending] = useState(false)

  const chatUrl = wsId ? buildPath(wsId, 'pinned', { chat: chatId, message: messageId ?? null }) : null

  async function handleSend(text: string) {
    if (!text.trim() || isSending) return
    setIsSending(true)
    try {
      await postMessage({ chatId, content: text.trim() }).unwrap()
    } catch (err) {
      toast.error('Failed to send', { description: describeApiError(err) })
    } finally {
      setIsSending(false)
    }
  }

  return (
    <ChatThread
      chatId={chatId}
      agentName={agentName}
      developerMode={developerMode}
      isSending={isSending}
      filterMessage={hidePanelTaskRows}
      headerSlot={chatUrl && (
        <div className="px-3 pt-2 pb-1 shrink-0 flex justify-end border-b">
          <Link
            to={chatUrl}
            className="inline-flex items-center gap-1.5 h-7 px-2 rounded text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="open-in-chat"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in chat
          </Link>
        </div>
      )}
      footerSlot={
        <div className="border-t p-3 shrink-0">
          <ChatInput
            onSend={(msg) => void handleSend(msg)}
            placeholder="Ask a question or request changes…"
            compact={true}
            showGoalPicker={false}
            draftKey={`task-chat:${chatId}`}
          />
        </div>
      }
    />
  )
}

export function TaskDetailPanel({ task, onCollapse }: TaskDetailPanelProps) {
  const descRef = useRef<HTMLParagraphElement>(null)
  const [activeTab, setActiveTab]             = usePersistedState<PanelTab>(`desk.task.${task.id}.tab`, 'details')
  const [historyOpen, setHistoryOpen]         = useState(false)
  const [showAllHistory, setShowAllHistory]   = useState(false)
  const [instructionsOpen, setInstructionsOpen] = useState(true)
  const [showFullInstructions, setShowFullInstructions] = useState(false)
  const [isDescClamped, setIsDescClamped]     = useState(false)

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const { data: agents } = useGetAgentsQuery()
  const [patchMessage, patchState] = usePatchMessageMutation()
  const [runMessage, runState] = useRunMessageMutation()
  const [deleteChat] = useDeleteChatMutation()

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
      if (!task.chatId || !task.messageId) {
        toast.error('This task is not wired to a server message yet')
        return
      }
      void runMessage({ chatId: task.chatId, messageId: task.messageId })
        .unwrap()
        .catch(err => toast.error('Action failed', { description: describeApiError(err) }))
      return
    }
    if (next === 'todo')      void transition('pending', { executeAt: null })
    if (next === 'complete')  void transition('cancelled')
    if (next === 'scheduled') void transition('pending')
  }

  const busy = patchState.isLoading || runState.isLoading
  const assigneeAgent = agents?.find(a => a.id === task.assigneeId)
  const assigneeLabel = !task.assigneeId || task.assigneeId === 'user'
    ? 'You'
    : assigneeAgent?.name ?? task.agentName ?? 'Agent'

  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false)

  async function applySchedulePatch(patch: SchedulePatch) {
    if (!task.chatId || !task.messageId) {
      toast.error('This task is not wired to a server message yet')
      return
    }
    const hasSchedule = patch.executeAt !== null || patch.cron !== null
    try {
      await patchMessage({
        chatId: task.chatId,
        messageId: task.messageId,
        // When adding a schedule, also transition to pending so the server
        // moves the task into the Scheduled column immediately.
        patch: hasSchedule ? { ...patch, state: 'pending' } : patch,
      }).unwrap()
    } catch (err) {
      toast.error("Couldn't update schedule", { description: describeApiError(err) })
    }
  }

  async function changeAssignee(newAssigneeId: string) {
    setAssigneePickerOpen(false)
    if (!task.chatId || !task.messageId) {
      toast.error('This task is not wired to a server message yet')
      return
    }
    try {
      await patchMessage({
        chatId: task.chatId,
        messageId: task.messageId,
        patch: { assigneeId: newAssigneeId },
      }).unwrap()
    } catch (err) {
      toast.error('Could not update assignee', { description: describeApiError(err) })
    }
  }

  // What the Schedule row shows when not editing.
  const scheduleLabel = task.schedule
    ? describeCron(task.schedule)
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
              className="h-8 w-8 shrink-0"
              data-testid="task-cancel"
              title="Complete"
              disabled={busy}
              onClick={() => void transition('cancelled')}
            >
              <Check className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            title="Delete task"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onCollapse}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Chat tab */}
      {activeTab === 'chat' && (
        task.chatId
          ? <ChatInPanel chatId={task.chatId} agentName={task.agentName} messageId={task.messageId} />
          : <div className="flex-1 flex items-center justify-center p-4">
              <p className="text-xs text-muted-foreground text-center">No chat linked to this task yet.</p>
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
                    <button data-testid="task-status-trigger" className="inline-flex items-center gap-1.5 hover:opacity-70 transition-opacity disabled:opacity-50" disabled={busy}>
                      <StatusBadge status={effectiveStatus} small />
                      {isPaused && (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2 py-px text-[11px] font-medium text-red-700">
                          <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-red-500" />
                          Paused
                        </span>
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    {(['todo', 'active', 'scheduled', 'complete'] as Task['status'][]).map(s => (
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
                <Popover open={assigneePickerOpen} onOpenChange={setAssigneePickerOpen}>
                  <PopoverTrigger asChild disabled={busy}>
                    <button
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-px text-[11px] font-medium text-foreground hover:opacity-70 transition-opacity disabled:opacity-50"
                      disabled={busy}
                    >
                      {!task.assigneeId || task.assigneeId === 'user'
                        ? <User className="h-3 w-3 text-muted-foreground shrink-0" />
                        : <Bot className="h-3 w-3 text-muted-foreground shrink-0" />}
                      {assigneeLabel}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="p-0 w-[180px]">
                    <Command>
                      <CommandInput placeholder="Search…" />
                      <CommandList>
                        <CommandEmpty>No results.</CommandEmpty>
                        <CommandGroup>
                          <CommandItem
                            value="user"
                            keywords={['You', 'me']}
                            onSelect={() => changeAssignee('user')}
                          >
                            <User className="h-3.5 w-3.5 mr-2 text-muted-foreground shrink-0" />
                            You
                          </CommandItem>
                          {(agents ?? []).map(a => (
                            <CommandItem
                              key={a.id}
                              value={a.id}
                              keywords={[a.name]}
                              onSelect={() => changeAssignee(a.id)}
                            >
                              <Bot className="h-3.5 w-3.5 mr-2 text-muted-foreground shrink-0" />
                              {a.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
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
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-px text-[11px] font-medium text-foreground hover:opacity-70 transition-opacity disabled:opacity-50"
                      disabled={busy}
                    >
                      {task.schedule
                        ? <Repeat className="h-3 w-3 text-muted-foreground shrink-0" />
                        : <Clock className="h-3 w-3 text-muted-foreground shrink-0" />}
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

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{task.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Deleting this task will cancel any scheduled runs and permanently
              clear the conversation history with the AI. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (task.chatId) await deleteChat(task.chatId)
                onCollapse()
              }}
            >
              Delete task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
