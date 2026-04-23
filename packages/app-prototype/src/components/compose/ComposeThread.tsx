import { useState, useEffect, useRef, useCallback } from 'react'
import { Sparkles } from 'lucide-react'
import { ChatMessage } from './ChatMessage'
import { ChatInput } from './ChatInput'
import { StatusIndicator } from './StatusIndicator'
import { useMockChat } from '@/hooks/use-mock-chat'
import type { Artifact, ComposeScenario } from '@/data/mock-data'
import { ArtifactInlineCard } from '@/components/shared/ArtifactInlineCard'

interface ComposeThreadProps {
  isActive: boolean
  onArtifactAdded: (artifact: Artifact) => void
  onArtifactClick: (artifact: Artifact) => void
  onFirstMessage?: (message: string) => void
  onSaveArtifact?: (artifact: Artifact) => void
}

const STARTER_CHIPS = [
  'Draft a project brief',
  'Build an expense tracker',
  'Summarise my notes',
  'Design a color palette',
]

export function ComposeThread({
  isActive, onArtifactAdded, onArtifactClick, onFirstMessage, onSaveArtifact,
}: ComposeThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<ReturnType<typeof useMockChat>['messages']>([])
  const firstMessageSent = useRef(false)
  const [createdArtifact, setCreatedArtifact] = useState<Artifact | null>(null)
  const [artifactSaved, setArtifactSaved] = useState(false)

  const handleArtifactCreated = useCallback((scenario: ComposeScenario) => {
    const artifact: Artifact = {
      id: `art-new-${Date.now()}`,
      ...scenario.resultArtifact,
      createdAt: new Date(),
      updatedAt: new Date(),
      conversation: messagesRef.current.map(m => ({ ...m })),
    }
    setCreatedArtifact(artifact)
    onArtifactAdded(artifact)
  }, [onArtifactAdded])

  const { messages, isTyping, statusText, sendMessage, clearTimeouts } = useMockChat({
    mode: 'compose',
    onArtifactCreated: handleArtifactCreated,
  })

  messagesRef.current = messages

  const wrappedSend = useCallback((content: string, _uploads?: unknown) => {
    if (!firstMessageSent.current && messages.length === 0) {
      firstMessageSent.current = true
      onFirstMessage?.(content)
    }
    sendMessage(content)
  }, [messages.length, sendMessage, onFirstMessage])

  useEffect(() => {
    if (isActive && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, statusText, createdArtifact, isActive])

  useEffect(() => () => clearTimeouts(), [clearTimeouts])

  const isEmpty = messages.length === 0 && !createdArtifact

  return (
    <div className={`flex flex-col flex-1 min-h-0 ${isActive ? '' : 'hidden'}`}>

      {/* ── Messages ────────────────────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-6">

          {isEmpty && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <Sparkles className="mb-6 h-16 w-16 text-muted-foreground/20" strokeWidth={1} />
              <h2 className="mb-2 text-xl font-semibold text-foreground">What would you like to create?</h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                Describe what you need and I'll build it for you. A document, an app, a design — just ask.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {STARTER_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    onClick={() => wrappedSend(chip)}
                    className="rounded-full border bg-background px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-6">
            {messages.map((msg, i) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                isFirstInGroup={i === 0 || messages[i - 1].role !== msg.role}
              />
            ))}
          </div>

          <StatusIndicator text={statusText} isTyping={isTyping && !statusText} />

          {createdArtifact && (
            <div className="mt-6">
              <ArtifactInlineCard
                artifact={createdArtifact}
                isSaved={artifactSaved}
                onOpen={() => onArtifactClick(createdArtifact)}
                onSave={() => {
                  setArtifactSaved(true)
                  onSaveArtifact?.(createdArtifact)
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Input ───────────────────────────────────────────────────────────── */}
      <div className="border-t bg-background">
        <div className="mx-auto max-w-2xl px-4 py-4">
          <ChatInput
            onSend={wrappedSend}
            disabled={isTyping}
            autoFocus={isActive}
          />
        </div>
      </div>
    </div>
  )
}

