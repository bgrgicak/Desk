import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MoreHorizontal, Zap, CheckCircle2, Sparkles } from 'lucide-react'
import { ChatMessage } from '@/components/compose/ChatMessage'
import { ChatInput } from '@/components/compose/ChatInput'
import { StatusIndicator } from '@/components/compose/StatusIndicator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useServerChat } from '@/hooks/use-server-chat'
import { InboxUICard } from './InboxUICard'
import {
  getArtifactIcon,
  type Artifact,
  type ChatMessage,
  type InboxItem,
  type Run,
} from '@/data/ui-types'

interface TodayDetailPanelProps {
  item: InboxItem
  onClose: () => void
  onOpenArtifact?: (artifactId: string) => void
  onOpenRun?: (runId: string) => void
  focusInput?: boolean
  onFocusConsumed?: () => void
  /** Optional artifact associated with this item (looked up by parent). */
  artifact?: Artifact | null
  /** Optional run associated with this item (looked up by parent). */
  run?: Run | null
  /** When provided, backs the chat with a real server chat for this item. */
  workspaceId?: string
}

export function TodayDetailPanel({
  item,
  onClose,
  onOpenArtifact,
  onOpenRun,
  focusInput,
  onFocusConsumed,
  artifact = null,
  run = null,
  workspaceId,
}: TodayDetailPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputFocusRef = useRef<(() => void) | null>(null)

  // Seed the conversation with the item's context as the first assistant message
  // so users see what the agent said before they reply.
  const seedMessage: ChatMessage = {
    id: `${item.id}-ctx`,
    role: 'assistant',
    content: item.message,
    timestamp: item.timestamp,
  }
  const serverChat = useServerChat(
    workspaceId,
    workspaceId ? `desk.todaychat.${workspaceId}.${item.id}` : '',
    item.agentName,
    undefined,
    seedMessage,
  )
  const messages = serverChat.messages
  const isTyping = workspaceId ? serverChat.isTyping : false
  const sendMessage = workspaceId ? serverChat.sendMessage : async () => {}

  const hasUserReplied = messages.some(m => m.role === 'user')

  useEffect(() => {
    if (focusInput) {
      // Small delay so the panel animation has started before we focus
      const t = setTimeout(() => {
        inputFocusRef.current?.()
        onFocusConsumed?.()
      }, 150)
      return () => clearTimeout(t)
    }
  }, [focusInput, onFocusConsumed])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isTyping])

  const ArtifactIcon = artifact ? getArtifactIcon(artifact.type) : null
  const hasReference = !!(artifact || run)

  const handleNavigate = artifact
    ? () => onOpenArtifact?.(artifact.id)
    : run
      ? () => onOpenRun?.(run.id)
      : undefined

  return (
    <motion.div
      className="absolute inset-0 flex flex-col bg-background"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      {/* Header */}
      <div className="h-[52px] flex items-center gap-2.5 border-b px-4 shrink-0">

        {hasReference ? (
          <>
            {/* Gray icon box */}
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
              {ArtifactIcon
                ? <ArtifactIcon className="h-3.5 w-3.5 text-foreground/60" />
                : <Zap className="h-3.5 w-3.5 text-foreground/60" />
              }
            </div>

            {/* Name + status badge */}
            <div className="flex-1 min-w-0 flex items-center gap-1.5">
              {handleNavigate ? (
                <button
                  onClick={handleNavigate}
                  className="text-sm font-medium truncate text-foreground hover:underline underline-offset-2 transition-colors"
                >
                  {artifact?.name ?? run?.name}
                </button>
              ) : (
                <span className="text-sm font-medium truncate text-foreground">
                  {artifact?.name ?? run?.name}
                </span>
              )}
              {run && (
                <span className="shrink-0 text-xs text-muted-foreground bg-muted rounded px-1.5 py-0.5 capitalize">
                  {run.status}
                </span>
              )}
            </div>
          </>
        ) : (
          <span className="flex-1 min-w-0 text-sm font-medium truncate text-foreground">
            {item.agentName}
          </span>
        )}

        {/* Right controls: kebab only */}
        <div className="flex items-center shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                aria-label="More options"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                Mark as
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onClose} className="gap-2 cursor-pointer">
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                Complete
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onClose} className="gap-2 cursor-pointer">
                <Sparkles className="h-4 w-4 text-muted-foreground" />
                Not relevant
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="px-5 py-4 space-y-4">
          <div className="space-y-1">
            {messages.map((msg, i) => (
              <div key={msg.id}>
                <ChatMessage
                  message={msg}
                  isFirstInGroup={i === 0 || messages[i - 1]?.role !== msg.role}
                />
                {/* Render the UI card below the first (context) assistant message */}
                {i === 0 && msg.role === 'assistant' && item.uiCard && (
                  <InboxUICard card={item.uiCard} />
                )}
              </div>
            ))}
          </div>
          <StatusIndicator text={null} isTyping={isTyping} />
        </div>
      </div>

      {/* Input area — chips sit directly above the input, same container */}
      <div className="border-t shrink-0 px-5 pt-3 pb-4">
        <AnimatePresence>
          {item.quickReplies && item.quickReplies.length > 0 && !hasUserReplied && (
            <motion.div
              className="flex flex-wrap gap-2 mb-3"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.15 }}
            >
              {item.quickReplies.map(reply => (
                <button
                  key={reply}
                  onClick={() => sendMessage(reply)}
                  className="rounded-full border bg-background px-3.5 py-1 text-sm text-foreground hover:bg-muted transition-colors"
                >
                  {reply}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <ChatInput
          onSend={sendMessage}
          placeholder="Reply or ask a follow-up…"
          compact
          showGoalPicker={false}
          focusRef={inputFocusRef}
          draftKey={`today-detail:${item.id}`}
        />
      </div>
    </motion.div>
  )
}
