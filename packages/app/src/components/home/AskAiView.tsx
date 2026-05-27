import { useCallback, useMemo } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ChatView } from '@/components/chats/ChatView'
import { useGetAskAiChatQuery, useGetChatQuery, useCreateThreadMutation, usePatchChatMutation } from '@/store/api'
import { toUiChat } from '@/store/selectors/chats'
import { generateThreadTitle } from '@/lib/thread-title'
import { buildPath, NEW_CHAT_ID } from '@/router/nav'

/**
 * The Home "Ask AI" surface. Supports the same thread navigation as room
 * chats — threads open in-place via `?chat=<id>` URL params, and the right
 * panel (Files / Tasks / Threads) is visible just as it is in any room chat.
 */
export function AskAiView() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const chatParam = searchParams.get('chat')
  const startThreadParam = searchParams.get('startThread')

  const { data: askAiServerChat } = useGetAskAiChatQuery()
  const askAiChat = useMemo(
    () => (askAiServerChat ? toUiChat(askAiServerChat) : null),
    [askAiServerChat],
  )

  // When `?chat=<id>` is set (and it's not 'new'), show that specific chat
  // (a thread). Otherwise show the default Ask AI chat.
  const threadChatId = chatParam && chatParam !== NEW_CHAT_ID ? chatParam : null
  const { data: threadServerChat } = useGetChatQuery(threadChatId ?? '', {
    skip: !threadChatId,
  })
  const threadChat = useMemo(
    () => (threadServerChat ? toUiChat(threadServerChat) : null),
    [threadServerChat],
  )

  // Gate on threadChatId (URL state, always current) not threadChat alone — RTK
  // Query's skip→undefined transition can lag one render, keeping chatForView on
  // the old thread ID and preventing ChatView from remounting after navigation back.
  const activeChat = (threadChatId ? threadChat : null) ?? askAiChat

  const [createThreadMutation] = useCreateThreadMutation()
  const [patchChatMutation] = usePatchChatMutation()

  const goToChat = useCallback((chatId: string | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (chatId) {
        next.set('chat', chatId)
      } else {
        next.delete('chat')
      }
      next.delete('startThread')
      return next
    }, { replace: false })
  }, [setSearchParams])

  const handleStartThreadFirstMessage = useCallback(async (content: string) => {
    if (!startThreadParam) return
    const colonIdx = startThreadParam.indexOf(':')
    const sourceChatId = startThreadParam.slice(0, colonIdx)
    const anchorMessageId = startThreadParam.slice(colonIdx + 1)
    try {
      const result = await createThreadMutation({ chatId: sourceChatId, messageId: anchorMessageId, content }).unwrap()
      goToChat(result.chat.id)
      void generateThreadTitle(content).then(title => {
        if (!title || title === result.chat.title) return
        patchChatMutation({ id: result.chat.id, patch: { title } })
      })
    } catch (err) {
      const data = (err as { data?: { message?: string } } | undefined)?.data
      toast.error('Failed to create thread', { description: data?.message })
    }
  }, [startThreadParam, createThreadMutation, patchChatMutation, goToChat])

  // Build navigation hrefs that stay on the home screen (`?view=askai&chat=...`)
  // rather than navigating into a room workspace.
  const chatNavValue = useMemo(() => {
    const pathname = location.pathname
    const currentSearch = location.search
    const buildHomeHref = (overrides: Record<string, string | null>) => {
      const sp = new URLSearchParams(currentSearch)
      for (const [k, v] of Object.entries(overrides)) {
        if (v === null) sp.delete(k)
        else sp.set(k, v)
      }
      return `${pathname}?${sp.toString()}`
    }
    return {
      buildThreadHref: (chatId: string) =>
        buildHomeHref({ chat: chatId, startThread: null }),
      buildNewThreadHref: (sourceChatId: string, messageId: string) =>
        buildHomeHref({ chat: NEW_CHAT_ID, startThread: `${sourceChatId}:${messageId}` }),
      buildParentHref: (parentChatId: string, anchorMessageId: string | undefined, parentWorkspaceId: string) => {
        // If the parent is the Ask AI chat, go back to the default Ask AI view.
        if (askAiChat && parentChatId === askAiChat.id) {
          return buildHomeHref({ chat: null, startThread: null })
        }
        return buildPath(parentWorkspaceId, 'pinned', { chat: parentChatId, message: anchorMessageId })
      },
    }
  }, [location.pathname, location.search, askAiChat])

  const isNewThread = chatParam === NEW_CHAT_ID

  if (!askAiChat) {
    return <div className="flex h-full min-h-0 w-full flex-col" />
  }

  // For a new thread (`?chat=new&startThread=...`) we render against the Ask
  // AI chat shell with `startThread` set so ChatView shows the anchor preview.
  const chatForView = isNewThread ? { ...askAiChat, id: NEW_CHAT_ID } : (activeChat ?? askAiChat)

  return (
    <ChatView
      key={chatForView.id}
      chat={chatForView}
      startThread={isNewThread ? startThreadParam : undefined}
      onFirstMessage={isNewThread ? handleStartThreadFirstMessage : undefined}
      chatNav={chatNavValue}
      hideKebab
    />
  )
}
