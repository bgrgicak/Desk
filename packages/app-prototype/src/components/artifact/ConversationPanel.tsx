import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { PanelRightClose, ChevronDown, ChevronRight, Bot, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChatMessage } from '@/components/compose/ChatMessage'
import { ChatInput } from '@/components/compose/ChatInput'
import { StatusIndicator } from '@/components/compose/StatusIndicator'
import { useLibraryItemChat } from '@/hooks/use-library-item-chat'
import { useServerChat } from '@/hooks/use-server-chat'
import { usePersistedState } from '@/hooks/use-persisted-state'
import type { ChatMessage as ChatMessageType, Artifact, ArtifactUpdate, ContextItem } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'

type PanelTab = 'chat' | 'details'

interface ConversationPanelProps {
  initialMessages: ChatMessageType[]
  agentModel?: string
  onCollapse?: () => void
  collapsed?: boolean
  artifact?: Artifact
  item?: ContextItem
  /** When provided the panel uses a real server-backed chat for the item. */
  workspaceId?: string
  update?: ArtifactUpdate | null
  isUpdateRead?: boolean
  onDismissUpdate?: (id: string) => void
  transitionFrom?: 'compose' | 'chat'
}

export function ConversationPanel({
  initialMessages,
  agentModel = 'Claude Sonnet 4',
  onCollapse,
  collapsed = false,
  artifact,
  item,
  workspaceId,
  update,
  transitionFrom,
}: ConversationPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabKey = artifact ? `desk.artifact.${artifact.id}.tab` : item ? `library.item.${item.id}.tab` : null
  const [activeTab, setActiveTab] = usePersistedState<PanelTab>(tabKey, 'chat')
  const [detailsSectionOpen, setDetailsSectionOpen] = useState(true)
  const [notesSectionOpen, setNotesSectionOpen] = useState(true)
  const [artifactNotes, setArtifactNotes] = useState('')
  const [itemNotes, setItemNotes] = useState('')

  const updateMsg = update ? {
    id: `update-${update.id}`,
    role: 'assistant' as const,
    content: update.message,
    timestamp: update.timestamp,
  } : null

  const libChat = useLibraryItemChat(
    workspaceId && item ? workspaceId : undefined,
    item?.id ?? '',
  )
  const artChat = useServerChat(
    workspaceId && artifact && !item ? workspaceId : undefined,
    workspaceId && artifact ? `desk.artchat.${workspaceId}.${artifact.id}` : '',
    artifact?.name ?? '',
  )
  const chat = workspaceId && item ? libChat : workspaceId && artifact ? artChat : null
  const messages = chat?.messages ?? initialMessages
  const isTyping = chat?.isTyping ?? false
  const sendMessage = chat?.sendMessage ?? (async () => {})
  const displayAgentModel = chat?.agentModel ?? agentModel

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
                  agentModel={displayAgentModel}
                  isFirstInGroup={i === 0 || messages[i - 1].role !== msg.role}
                />
              ))}
              {updateMsg && (
                <ChatMessage
                  message={updateMsg}
                  agentModel={displayAgentModel}
                  isFirstInGroup={true}
                  isNew={true}
                />
              )}
              <StatusIndicator text={null} isTyping={isTyping} />
            </div>
          </div>
          <div className="border-t p-3 shrink-0">
            <ChatInput
              onSend={(msg) => sendMessage(msg)}
              placeholder="Ask to make changes..."
              compact={true}
              showGoalPicker={true}
              draftKey={artifact ? `artifact:${artifact.id}` : item ? `library:${item.id}` : undefined}
            />
          </div>
        </>
      )}

      {/* Details tab */}
      {activeTab === 'details' && (artifact || item) && (
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
                  Extra context the AI will see when working on this file.
                </p>
                <textarea
                  value={item ? itemNotes : artifactNotes}
                  onChange={e => item ? setItemNotes(e.target.value) : setArtifactNotes(e.target.value)}
                  placeholder="e.g., Always keep the tone formal."
                  className="w-full min-h-[80px] rounded-lg border bg-background shadow-xs px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-ring/20 focus:border-ring/40 resize-none transition-all"
                />
              </div>
            )}
          </div>

          {/* About */}
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
                {item ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Created by</span>
                      <div className="flex items-center gap-1.5">
                        {item.uploadedBy === 'user' ? (
                          <>
                            <User className="h-3 w-3 text-muted-foreground" />
                            <span className="text-xs text-foreground">You</span>
                          </>
                        ) : (
                          <>
                            <Bot className="h-3 w-3 text-muted-foreground" />
                            <span className="text-xs text-foreground">{item.agentName ?? 'Claude'}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Added</span>
                      <span className="text-xs text-foreground">
                        {item.addedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    </div>
                    {item.lastAccessed && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Last accessed</span>
                        <span className="text-xs text-foreground">{getRelativeTime(item.lastAccessed)}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Type</span>
                      <span className="text-xs text-foreground capitalize">{item.type}</span>
                    </div>
                    {item.fileSize && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Size</span>
                        <span className="text-xs text-foreground">{item.fileSize}</span>
                      </div>
                    )}
                  </>
                ) : artifact ? (
                  <>
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
                  </>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  )
}
