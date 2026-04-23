import { useState, useRef, useEffect } from 'react'
import {
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  PauseCircle,
  ChevronDown,
  ChevronRight,
  Calendar,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { ChatMessage } from '@/components/compose/ChatMessage'
import { ChatInput } from '@/components/compose/ChatInput'
import { StatusIndicator } from '@/components/compose/StatusIndicator'
import { useMockChat } from '@/hooks/use-mock-chat'
import type { Run, RunOccurrence } from '@/data/mock-data'
import { getRelativeTime } from '@/data/mock-data'

type PanelTab = 'chat' | 'details'

interface RunDetailPanelProps {
  run: Run
  onCollapse: () => void
}

const STATUS_COLORS: Record<Run['status'], string> = {
  active:    'bg-blue-500',
  completed: 'bg-emerald-500',
  paused:    'bg-amber-500',
  failed:    'bg-red-500',
}

const STATUS_LABELS: Record<Run['status'], string> = {
  active:    'Active',
  completed: 'Completed',
  paused:    'Paused',
  failed:    'Failed',
}

function OccurrenceStatusIcon({ status }: { status: RunOccurrence['status'] }) {
  switch (status) {
    case 'active':
      return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
    case 'completed':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
    case 'failed':
      return <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
  }
}

const INITIAL_MESSAGES_BY_RUN: Record<string, Array<{ role: 'user' | 'assistant'; content: string; msOffset: number }>> = {
  'run-1': [
    { role: 'user', content: 'Set up a daily email digest at 8 am that reads my inbox and sorts messages by priority.', msOffset: -3600000 },
    { role: 'assistant', content: "I'll set that up for you. Every weekday at 8 am I'll scan your inbox, categorize emails by urgency, and give you a prioritised summary so you can tackle the most important things first.", msOffset: -3598000 },
    { role: 'assistant', content: "The run is now scheduled and will start tomorrow morning. You can adjust the priority rules anytime by sending me a message here.", msOffset: -3597000 },
  ],
  'run-2': [
    { role: 'user', content: 'Every Thursday morning, summarise all the updates the team posted that week across Slack and Linear.', msOffset: -7200000 },
    { role: 'assistant', content: "Great idea. I'll pull together everything from your connected Slack channels and Linear project, then generate a concise weekly summary every Thursday at 7 am.", msOffset: -7198000 },
    { role: 'user', content: 'Include a section on blockers if any are mentioned.', msOffset: -7100000 },
    { role: 'assistant', content: "Done — I'll add a 'Blockers & risks' section whenever team members mention anything stuck or at risk. The first run is set for this Thursday.", msOffset: -7098000 },
  ],
  'run-3': [
    { role: 'user', content: 'Keep my calendar synced with Google Calendar every day at 6 am.', msOffset: -86400000 },
    { role: 'assistant', content: "I'll run a calendar sync every morning at 6 am, pulling in new events and resolving any conflicts. The first sync will happen tomorrow.", msOffset: -86398000 },
  ],
  'run-4': [
    { role: 'user', content: "Every Wednesday evening, compile my expense report from this week's receipts and flag anything missing.", msOffset: -172800000 },
    { role: 'assistant', content: "I'll check your connected email and cloud storage for receipts, compile them into a report, and flag any transactions without matching receipts. Running every Wednesday at 10 pm.", msOffset: -172798000 },
  ],
  'run-5': [
    { role: 'user', content: 'Deploy the latest changes to the landing page.', msOffset: -10000000 },
    { role: 'assistant', content: "I'll trigger the build and deploy pipeline for the landing page now.", msOffset: -9999000 },
    { role: 'assistant', content: "Deployment complete. All changes are live. Build time was 4 minutes 32 seconds.", msOffset: -9990000 },
  ],
  'run-6': [
    { role: 'user', content: 'Migrate all records from the legacy PostgreSQL database to the new schema. This will take a couple of days.', msOffset: -200000000 },
    { role: 'assistant', content: "Understood. I'll run the migration in batches to avoid downtime, validate each batch before committing, and log any rows that fail validation for manual review.", msOffset: -199998000 },
    { role: 'user', content: 'Pause if the error rate goes above 0.1%', msOffset: -199900000 },
    { role: 'assistant', content: "Set. I'll monitor the error rate continuously and pause automatically if it exceeds 0.1%. You'll get a notification here if that happens.", msOffset: -199898000 },
  ],
}

export function RunDetailPanel({ run, onCollapse }: RunDetailPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeTab, setActiveTab] = useState<PanelTab>('details')
  const [historyOpen, setHistoryOpen] = useState(true)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [isPaused, setIsPaused] = useState(run.status === 'paused')

  const baseMessages = (INITIAL_MESSAGES_BY_RUN[run.id] ?? []).map((m, i) => ({
    id: `${run.id}-init-${i}`,
    role: m.role,
    content: m.content,
    timestamp: new Date(Date.now() + m.msOffset),
  }))

  const { messages, isTyping, sendMessage } = useMockChat({
    initialMessages: baseMessages,
    mode: 'conversation',
  })

  useEffect(() => {
    if (scrollRef.current && activeTab === 'chat') {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, activeTab])

  // Reset paused state when run changes
  useEffect(() => {
    setIsPaused(run.status === 'paused')
    setShowAllHistory(false)
    setActiveTab('details')
  }, [run.id, run.status])

  const history = run.history ?? []
  const visibleHistory = showAllHistory ? history : history.slice(0, 5)

  const canPauseResume = run.status === 'active' || run.status === 'paused'

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

      {/* Chat tab */}
      {activeTab === 'chat' && (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="space-y-6 p-4">
              {messages.map((msg, i) => (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  agentModel={run.agentName}
                  isFirstInGroup={i === 0 || messages[i - 1].role !== msg.role}
                />
              ))}
              <StatusIndicator text={null} isTyping={isTyping} />
            </div>
          </div>
          <div className="border-t p-3 shrink-0">
            <ChatInput
              onSend={(msg) => sendMessage(msg)}
              disabled={isTyping}
              placeholder="Ask about this run..."
              compact={true}
              showGoalPicker={false}
            />
          </div>
        </>
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
                  <Button variant="outline" size="sm" onClick={() => setIsPaused(v => !v)}>Pause</Button>
                  <Button variant="outline" size="sm">Cancel</Button>
                </div>
              </Alert>
            )}
            {run.status === 'completed' && (
              <Alert>
                <CheckCircle2 className="text-emerald-500" />
                <AlertTitle>{STATUS_LABELS['completed']}</AlertTitle>
                {run.statusText && <AlertDescription>{run.statusText}</AlertDescription>}
                <div className="col-start-2 mt-3">
                  <Button variant="outline" size="sm">Cancel</Button>
                </div>
              </Alert>
            )}
            {run.status === 'paused' && (
              <Alert className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
                <PauseCircle className="text-amber-500" />
                <AlertTitle>{STATUS_LABELS['paused']}</AlertTitle>
                {run.statusText && <AlertDescription className="text-amber-700 dark:text-amber-300">{run.statusText}</AlertDescription>}
                <div className="col-start-2 flex gap-2 mt-3">
                  <Button variant="outline" size="sm" onClick={() => setIsPaused(v => !v)}>Resume</Button>
                  <Button variant="outline" size="sm">Cancel</Button>
                </div>
              </Alert>
            )}
            {run.status === 'failed' && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>{STATUS_LABELS['failed']}</AlertTitle>
                {run.statusText && <AlertDescription>{run.statusText}</AlertDescription>}
                <div className="col-start-2 mt-3">
                  <Button variant="outline" size="sm">Cancel</Button>
                </div>
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

            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Last run</span>
              <span className="text-xs text-foreground">{getRelativeTime(run.startedAt)}</span>
            </div>

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
                  <p className="px-4 py-2 text-xs text-muted-foreground">No history yet.</p>
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
