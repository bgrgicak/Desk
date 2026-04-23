import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { MessageSquare, PanelRightClose, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChatMessage } from '@/components/compose/ChatMessage'
import { ChatInput } from '@/components/compose/ChatInput'
import { StatusIndicator } from '@/components/compose/StatusIndicator'
import { useMockChat } from '@/hooks/use-mock-chat'
import type { ChatMessage as ChatMessageType, Artifact, ArtifactUpdate } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'

type PanelTab = 'chat' | 'details'

interface ConversationPanelProps {
  initialMessages: ChatMessageType[]
  agentModel?: string
  onCollapse?: () => void
  collapsed?: boolean
  artifact?: Artifact
  update?: ArtifactUpdate | null
  isUpdateRead?: boolean
  onDismissUpdate?: (id: string) => void
  transitionFrom?: 'compose'
}

export function ConversationPanel({
  initialMessages,
  agentModel = 'Claude Sonnet 4',
  onCollapse,
  collapsed = false,
  artifact,
  update,
  isUpdateRead,
  onDismissUpdate,
  transitionFrom,
}: ConversationPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeTab, setActiveTab] = useState<PanelTab>('chat')
  const [detailsSectionOpen, setDetailsSectionOpen] = useState(true)
  const [notesSectionOpen, setNotesSectionOpen] = useState(true)
  const [artifactNotes, setArtifactNotes] = useState('')

  const updateMsg = update ? {
    id: `update-${update.id}`,
    role: 'assistant' as const,
    content: update.message,
    timestamp: update.timestamp,
  } : null

  const { messages, isTyping, sendMessage } = useMockChat({
    initialMessages,
    mode: 'conversation',
  })

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  if (collapsed) {
    return null
  }

  return (
    <motion.div
      initial={transitionFrom === 'compose' ? { opacity: 0 } : { opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      transition={transitionFrom === 'compose'
        ? { duration: 0.25, ease: 'easeOut' }
        : { type: 'spring', damping: 25, stiffness: 200 }}
      className="flex h-full w-full flex-col border-l bg-background"
    >
      {/* Panel header */}
      <div className="h-[52px] flex items-center justify-between px-4 border-b shrink-0">
        {/* Tab pills */}
        <div className="flex items-center h-8 bg-muted rounded-full p-0.5">
          {(['chat', 'details'] as PanelTab[]).map(tab => (
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
          <PanelRightClose className="h-4 w-4" />
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
                  agentModel={agentModel}
                  isFirstInGroup={i === 0 || messages[i - 1].role !== msg.role}
                />
              ))}
              {updateMsg && (
                <ChatMessage
                  message={updateMsg}
                  agentModel={agentModel}
                  isFirstInGroup={true}
                  isNew={true}
                />
              )}
              <StatusIndicator text={null} isTyping={isTyping} />
            </div>
          </div>
          <div className="border-t p-3 shrink-0">
            <p className="text-[10px] text-muted-foreground/60 mb-2 leading-none">Changes in this conversation won't affect other chats.</p>
            <ChatInput
              onSend={(msg) => sendMessage(msg)}
              disabled={isTyping}
              placeholder="Ask to make changes..."
              compact={true}
              showGoalPicker={true}
            />
          </div>
        </>
      )}

      {/* Details tab */}
      {activeTab === 'details' && artifact && (
        <div className="flex-1 overflow-y-auto">
          {/* Notes for AI */}
          <div className="border-b">
            <button
              onClick={() => setNotesSectionOpen(v => !v)}
              className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors"
            >
              <span className="text-sm font-medium">Notes for AI</span>
              {notesSectionOpen
                ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </button>
            {notesSectionOpen && (
              <div className="px-4 pb-4">
                <p className="text-xs text-muted-foreground mb-2">
                  Extra context the AI will see when working on this artifact.
                </p>
                <textarea
                  value={artifactNotes}
                  onChange={e => setArtifactNotes(e.target.value)}
                  placeholder="e.g., Always keep the tone formal."
                  className="w-full min-h-[80px] rounded-lg border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-ring/20 focus:border-ring/40 resize-none transition-all"
                />
              </div>
            )}
          </div>

          {/* Details */}
          <div className="border-b">
            <button
              onClick={() => setDetailsSectionOpen(v => !v)}
              className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors"
            >
              <span className="text-sm font-medium">About</span>
              {detailsSectionOpen
                ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </button>
            {detailsSectionOpen && (
              <div className="px-4 pb-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Type</span>
                  <span className="text-xs text-foreground capitalize">{artifact.type}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Agent</span>
                  <span className="text-xs text-foreground">{artifact.agentName}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Model</span>
                  <span className="text-xs text-foreground">{artifact.agentModel}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Created</span>
                  <span className="text-xs text-foreground">
                    {artifact.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Updated</span>
                  <span className="text-xs text-foreground">{getRelativeTime(artifact.updatedAt)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  )
}
