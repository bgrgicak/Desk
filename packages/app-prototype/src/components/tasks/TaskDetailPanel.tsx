import { useState, useRef, useEffect } from 'react'
import {
  X,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  User,
  Bot,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Loader2, CheckCircle2, Clock } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { ChatMessage } from '@/components/compose/ChatMessage'
import { ChatInput } from '@/components/compose/ChatInput'
import { StatusIndicator } from '@/components/compose/StatusIndicator'
import { useMockChat } from '@/hooks/use-mock-chat'
import { MOCK_AGENTS, getRelativeTime } from '@/data/mock-data'
import type { Task, TaskOccurrence } from '@/data/mock-data'
import { StatusBadge, PriorityIcon, STATUS_LABELS, PRIORITY_LABELS, PRIORITY_CONFIG } from './task-badges'
import type { Priority } from './task-badges'

type PanelTab = 'details' | 'chat'

interface TaskDetailPanelProps {
  task: Task
  onCollapse: () => void
  onTaskChange: (updated: Task) => void
}

// ── Occurrence icon ───────────────────────────────────────────────────────────

function OccurrenceStatusIcon({ status }: { status: TaskOccurrence['status'] }) {
  switch (status) {
    case 'active':    return <Loader2     className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
    case 'completed': return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
    case 'failed':    return <AlertCircle  className="h-3.5 w-3.5 text-red-500 shrink-0" />
  }
}

// ── Mock chat seeds (keyed by task id) ────────────────────────────────────────

const INITIAL_MESSAGES_BY_TASK: Record<string, Array<{ role: 'user' | 'assistant'; content: string; msOffset: number }>> = {
  'run-1': [
    { role: 'user',      content: 'Set up a daily email digest at 8 am that reads my inbox and sorts messages by priority.', msOffset: -3600000 },
    { role: 'assistant', content: "I'll set that up for you. Every weekday at 8 am I'll scan your inbox, categorize emails by urgency, and give you a prioritised summary so you can tackle the most important things first.", msOffset: -3598000 },
    { role: 'assistant', content: "The task is now scheduled and will start tomorrow morning. You can adjust the priority rules anytime by sending me a message here.", msOffset: -3597000 },
  ],
  'run-2': [
    { role: 'user',      content: 'Every Thursday morning, summarise all the updates the team posted that week across Slack and Linear.', msOffset: -7200000 },
    { role: 'assistant', content: "Great idea. I'll pull together everything from your connected Slack channels and Linear project, then generate a concise weekly summary every Thursday at 7 am.", msOffset: -7198000 },
    { role: 'user',      content: 'Include a section on blockers if any are mentioned.', msOffset: -7100000 },
    { role: 'assistant', content: "Done — I'll add a 'Blockers & risks' section whenever team members mention anything stuck or at risk. The first run is set for this Thursday.", msOffset: -7098000 },
  ],
  'run-3': [
    { role: 'user',      content: 'Keep my calendar synced with Google Calendar every day at 6 am.', msOffset: -86400000 },
    { role: 'assistant', content: "I'll run a calendar sync every morning at 6 am, pulling in new events and resolving any conflicts. The first sync will happen tomorrow.", msOffset: -86398000 },
  ],
  'run-4': [
    { role: 'user',      content: "Every Wednesday evening, compile my expense report from this week's receipts and flag anything missing.", msOffset: -172800000 },
    { role: 'assistant', content: "I'll check your connected email and cloud storage for receipts, compile them into a report, and flag any transactions without matching receipts. Running every Wednesday at 10 pm.", msOffset: -172798000 },
  ],
  'run-5': [
    { role: 'user',      content: 'Deploy the latest changes to the landing page.', msOffset: -10000000 },
    { role: 'assistant', content: "I'll trigger the build and deploy pipeline for the landing page now.", msOffset: -9999000 },
    { role: 'assistant', content: "Deployment complete. All changes are live. Build time was 4 minutes 32 seconds.", msOffset: -9990000 },
  ],
  'run-6': [
    { role: 'user',      content: 'Migrate all records from the legacy PostgreSQL database to the new schema. This will take a couple of days.', msOffset: -200000000 },
    { role: 'assistant', content: "Understood. I'll run the migration in batches to avoid downtime, validate each batch before committing, and log any rows that fail validation for manual review.", msOffset: -199998000 },
    { role: 'user',      content: 'Pause if the error rate goes above 0.1%', msOffset: -199900000 },
    { role: 'assistant', content: "Set. I'll monitor the error rate continuously and pause automatically if it exceeds 0.1%. You'll get a notification here if that happens.", msOffset: -199898000 },
  ],
}

// ── Main component ────────────────────────────────────────────────────────────

export function TaskDetailPanel({ task, onCollapse, onTaskChange }: TaskDetailPanelProps) {
  const scrollRef  = useRef<HTMLDivElement>(null)
  const descRef    = useRef<HTMLParagraphElement>(null)
  const [activeTab, setActiveTab]             = useState<PanelTab>('details')
  const [historyOpen, setHistoryOpen]         = useState(true)
  const [showAllHistory, setShowAllHistory]   = useState(false)
  const [instructionsOpen, setInstructionsOpen] = useState(true)
  const [showFullInstructions, setShowFullInstructions] = useState(false)
  const [isDescClamped, setIsDescClamped]     = useState(false)

  const baseMessages = (INITIAL_MESSAGES_BY_TASK[task.id] ?? []).map((m, i) => ({
    id: `${task.id}-init-${i}`,
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

  useEffect(() => {
    if (!instructionsOpen || !descRef.current) return
    setIsDescClamped(descRef.current.scrollHeight > descRef.current.clientHeight)
  }, [task.description, instructionsOpen])

  useEffect(() => {
    setShowAllHistory(false)
    setShowFullInstructions(false)
    setIsDescClamped(false)
    setActiveTab('details')
  }, [task.id])

  const history = task.history ?? []
  const visibleHistory = showAllHistory ? history : history.slice(0, 5)

  const assigneeLabel = !task.assigneeId || task.assigneeId === 'user' ? 'You' : task.assigneeId

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
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="space-y-6 p-4">
              {messages.map((msg, i) => (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  agentModel={task.agentName}
                  isFirstInGroup={i === 0 || messages[i - 1].role !== msg.role}
                />
              ))}
              <StatusIndicator text={null} isTyping={isTyping} />
            </div>
          </div>
          <div className="border-t p-3 shrink-0">
            <ChatInput
              onSend={msg => sendMessage(msg)}
              disabled={isTyping}
              placeholder="Ask about this task..."
              compact={true}
              showGoalPicker={false}
            />
          </div>
        </>
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
                <DropdownMenuTrigger asChild>
                  <button className="hover:opacity-70 transition-opacity">
                    <StatusBadge status={task.status} small />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {(['todo', 'active', 'complete', 'scheduled'] as Task['status'][]).map(s => (
                    <DropdownMenuItem key={s} onSelect={() => onTaskChange({ ...task, status: s })} className="gap-2">
                      <StatusBadge status={s} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Assignee */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Assignee</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="hover:opacity-70 transition-opacity">
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-px text-[11px] font-medium text-foreground">
                      {!task.assigneeId || task.assigneeId === 'user'
                        ? <User className="h-3 w-3 text-muted-foreground shrink-0" />
                        : <Bot  className="h-3 w-3 text-muted-foreground shrink-0" />
                      }
                      {assigneeLabel}
                    </span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onTaskChange({ ...task, assigneeId: 'user' })}>
                    <User className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                    You
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {MOCK_AGENTS.map(agent => (
                    <DropdownMenuItem
                      key={agent.name}
                      onSelect={() => onTaskChange({ ...task, assigneeId: agent.name, agentName: agent.name })}
                    >
                      <Bot className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                      {agent.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Priority */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Priority</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="hover:opacity-70 transition-opacity">
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-px text-[11px] font-medium text-foreground">
                      {task.priority && <PriorityIcon priority={task.priority} className="!h-3 !w-3" />}
                      {task.priority ? PRIORITY_LABELS[task.priority] : 'None'}
                    </span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                  {(['highest', 'high', 'medium', 'low'] as Priority[]).map(p => {
                    const { icon: Icon, iconClass } = PRIORITY_CONFIG[p]
                    return (
                      <DropdownMenuItem
                        key={p}
                        onSelect={() => onTaskChange({ ...task, priority: p })}
                        className="gap-2"
                      >
                        <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
                        {PRIORITY_LABELS[p]}
                      </DropdownMenuItem>
                    )
                  })}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onTaskChange({ ...task, priority: undefined })}>
                    None
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Last run */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Last run</span>
              <span className="text-xs text-foreground">{getRelativeTime(task.startedAt)}</span>
            </div>

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
                  : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                }
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
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />
              }
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
