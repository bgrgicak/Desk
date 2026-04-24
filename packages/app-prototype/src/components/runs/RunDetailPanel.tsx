import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  PauseCircle,
  ChevronDown,
  ChevronRight,
  Calendar,
  Clock,
  MessageSquare,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import type { Run, RunOccurrence } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { usePatchMessageMutation } from '@/store/api'
import { buildPath } from '@/router/nav'

type PanelTab = 'chat' | 'details'

interface RunDetailPanelProps {
  run: Run
  onCollapse: () => void
}

// RTK Query rejects with `{ status, data }`, not an Error. The server
// writes `{ code, message }` into `data` (see app.ts sendJson), so pull
// the readable message out of there first.
function describeApiError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { data?: { message?: unknown }; error?: unknown }
    if (typeof e.data?.message === 'string') return e.data.message
    if (typeof e.error === 'string') return e.error
  }
  if (err instanceof Error) return err.message
  return 'Unknown error'
}

const STATUS_LABELS: Record<Run['status'], string> = {
  active:    'Active',
  scheduled: 'Scheduled',
  completed: 'Completed',
  paused:    'Paused',
  failed:    'Failed',
}

function OccurrenceStatusIcon({ status }: { status: RunOccurrence['status'] }) {
  switch (status) {
    case 'active':
      return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
    case 'scheduled':
      return <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    case 'completed':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
    case 'failed':
      return <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
    case 'paused':
      return <PauseCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
  }
}

export function RunDetailPanel({ run, onCollapse }: RunDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('details')
  const [historyOpen, setHistoryOpen] = useState(true)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const navigate = useNavigate()
  const { wsId = '' } = useParams<{ wsId: string }>()

  const [patchMessage, patchState] = usePatchMessageMutation()

  useEffect(() => {
    setShowAllHistory(false)
    setActiveTab('details')
  }, [run.id])

  // "History" is past-only — filter out the synthesized upcoming/paused
  // preview occurrences that the calendar uses to place scheduled runs
  // on their future date. Ordered old → new.
  const history = (run.history ?? [])
    .filter(occ => occ.status !== 'scheduled' && occ.status !== 'paused')
    .slice()
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  const visibleHistory = showAllHistory ? history : history.slice(-5)

  async function transition(nextState: 'paused' | 'pending' | 'cancelled') {
    if (!run.chatId || !run.messageId) {
      toast.error('This run is not wired to a server message yet')
      return
    }
    try {
      await patchMessage({
        chatId: run.chatId,
        messageId: run.messageId,
        patch: { state: nextState },
      }).unwrap()
    } catch (err) {
      toast.error('Action failed', { description: describeApiError(err) })
    }
  }

  const openInChat = () => {
    if (!run.chatId || !wsId) return
    navigate(buildPath(wsId, 'desk', { chat: run.chatId, message: run.messageId ?? null }))
  }

  const busy = patchState.isLoading

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-background">
      {/* Panel header */}
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

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onCollapse}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Chat tab — deep-link to originating conversation. The scheduled
          trigger message is usually filtered from the chat timeline, so
          the tab doesn't try to render its own transcript. */}
      {activeTab === 'chat' && (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="text-sm text-foreground font-medium">Originating chat</p>
            <p className="text-xs text-muted-foreground mt-1">
              This run was created in a chat. Open it to see the full conversation and jump to the scheduled message.
            </p>
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              data-testid="open-in-chat"
              disabled={!run.chatId}
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
          {/* Run name + status + actions */}
          <div className="px-4 py-4 border-b space-y-3">
            <h2 className="text-sm font-semibold text-foreground">{run.name}</h2>

            {run.status === 'active' && (
              <Alert>
                <Loader2 className="animate-spin text-blue-500" />
                <AlertTitle>{STATUS_LABELS['active']}</AlertTitle>
                {run.statusText && <AlertDescription>{run.statusText}</AlertDescription>}
                <div className="col-start-2 flex gap-2 mt-3">
                  <Button variant="outline" size="sm" data-testid="run-pause" disabled={busy} onClick={() => transition('paused')}>Pause</Button>
                  <Button variant="outline" size="sm" data-testid="run-cancel" disabled={busy} onClick={() => transition('cancelled')}>Cancel</Button>
                </div>
              </Alert>
            )}
            {run.status === 'scheduled' && (
              <Alert>
                <Clock className="text-muted-foreground" />
                <AlertTitle>{STATUS_LABELS['scheduled']}</AlertTitle>
                {run.statusText && <AlertDescription>{run.statusText}</AlertDescription>}
                <div className="col-start-2 flex gap-2 mt-3">
                  <Button variant="outline" size="sm" data-testid="run-pause" disabled={busy} onClick={() => transition('paused')}>Pause</Button>
                  <Button variant="outline" size="sm" data-testid="run-cancel" disabled={busy} onClick={() => transition('cancelled')}>Cancel</Button>
                </div>
              </Alert>
            )}
            {run.status === 'completed' && (
              <Alert>
                <CheckCircle2 className="text-emerald-500" />
                <AlertTitle>{STATUS_LABELS['completed']}</AlertTitle>
                {run.statusText && <AlertDescription>{run.statusText}</AlertDescription>}
              </Alert>
            )}
            {run.status === 'paused' && (
              <Alert className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                <PauseCircle className="text-amber-500" />
                <AlertTitle>{STATUS_LABELS['paused']}</AlertTitle>
                {run.statusText && <AlertDescription className="text-amber-700 dark:text-amber-300">{run.statusText}</AlertDescription>}
                <div className="col-start-2 flex gap-2 mt-3">
                  <Button variant="outline" size="sm" data-testid="run-resume" disabled={busy} onClick={() => transition('pending')}>Resume</Button>
                  <Button variant="outline" size="sm" data-testid="run-cancel" disabled={busy} onClick={() => transition('cancelled')}>Cancel</Button>
                </div>
              </Alert>
            )}
            {run.status === 'failed' && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>{STATUS_LABELS['failed']}</AlertTitle>
                {run.statusText && <AlertDescription>{run.statusText}</AlertDescription>}
              </Alert>
            )}
          </div>

          {/* Meta rows */}
          <div className="px-4 py-3 border-b space-y-2.5">
            {run.schedule && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Schedule</span>
                <div className="flex items-center gap-1.5">
                  <Calendar className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs text-foreground">{run.schedule}</span>
                </div>
              </div>
            )}

            {run.nextRun && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Next run</span>
                <span className="text-xs text-foreground">
                  {run.nextRun.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  {' at '}
                  {run.nextRun.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
              </div>
            )}

            {run.hasRealStartedAt && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Last run</span>
                <span className="text-xs text-foreground">{getRelativeTime(run.startedAt)}</span>
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Agent</span>
              <span className="text-xs text-foreground">{run.agentName}</span>
            </div>
          </div>

          {/* History collapsible */}
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
                  <p className="px-4 py-2 text-xs text-muted-foreground" data-testid="run-history-empty">No history yet.</p>
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
