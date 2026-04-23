import { useState, useCallback, useRef, useEffect } from 'react'
import type { ChatMessage } from '@/data/ui-types'
import { matchComposeScenario } from '@/data/ui-types'

interface UseMockChatOptions {
  initialMessages?: ChatMessage[]
  onArtifactCreated?: (scenario: ReturnType<typeof matchComposeScenario>) => void
  mode?: 'compose' | 'conversation'
}

export function useMockChat({ initialMessages = [], onArtifactCreated, mode = 'conversation' }: UseMockChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages)
  const [isTyping, setIsTyping] = useState(false)
  const [statusText, setStatusText] = useState<string | null>(null)
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([])

  // If the caller's initialMessages arrives after mount (e.g. RTK Query
  // resolved /chats/:id/messages), reconcile into the local state. User-
  // sent messages added via sendMessage stay; server rows are appended
  // where they aren't already present.
  const lastInitialKeyRef = useRef<string>('')
  useEffect(() => {
    const key = initialMessages.map(m => m.id).join('|')
    if (key === lastInitialKeyRef.current) return
    lastInitialKeyRef.current = key
    setMessages(prev => {
      const have = new Set(prev.map(m => m.id))
      const additions = initialMessages.filter(m => !have.has(m.id))
      if (additions.length === 0) return prev
      return prev.length === 0 ? [...initialMessages] : [...additions, ...prev]
    })
  }, [initialMessages])

  const clearTimeouts = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout)
    timeoutsRef.current = []
  }, [])

  const sendMessage = useCallback((content: string) => {
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date(),
    }

    setMessages(prev => [...prev, userMsg])
    setIsTyping(true)

    if (mode === 'compose') {
      const scenario = matchComposeScenario(content)

      // Show status messages in sequence
      scenario.statusMessages.forEach((status, i) => {
        const t = setTimeout(() => {
          setStatusText(status)
        }, (i + 1) * 1200)
        timeoutsRef.current.push(t)
      })

      // After all status messages, add final response and create artifact
      const totalDelay = (scenario.statusMessages.length + 1) * 1200

      const t1 = setTimeout(() => {
        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now()}-response`,
          role: 'assistant',
          content: scenario.finalResponse,
          timestamp: new Date(),
        }
        setMessages(prev => [...prev, assistantMsg])
        setIsTyping(false)
        setStatusText(null)
      }, totalDelay)
      timeoutsRef.current.push(t1)

      const t2 = setTimeout(() => {
        onArtifactCreated?.(scenario)
      }, totalDelay + 800)
      timeoutsRef.current.push(t2)
    } else {
      // Conversation mode — simple mock response
      const t = setTimeout(() => {
        const responses = [
          "Done! I've updated the document with your changes.",
          "I've made those adjustments. Take a look and let me know if it's what you had in mind.",
          "Updated. The changes are reflected in the document above.",
          "Got it. I've reworked that section based on your feedback.",
          "All set. I've incorporated your suggestions throughout.",
        ]
        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now()}-response`,
          role: 'assistant',
          content: responses[Math.floor(Math.random() * responses.length)],
          timestamp: new Date(),
        }
        setMessages(prev => [...prev, assistantMsg])
        setIsTyping(false)
      }, 1500 + Math.random() * 1000)
      timeoutsRef.current.push(t)
    }
  }, [mode, onArtifactCreated])

  return {
    messages,
    isTyping,
    statusText,
    sendMessage,
    clearTimeouts,
  }
}
