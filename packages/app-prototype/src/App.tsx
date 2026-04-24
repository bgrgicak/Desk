import { useCallback, useEffect } from 'react'
import {
  Routes,
  Route,
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppShell } from '@/components/layout/AppShell'
import type { WorkspaceNavView } from '@/components/layout/WorkspaceBar'
import { ArtifactDetail } from '@/components/artifact/ArtifactDetail'
import { DeskGrid } from '@/components/desk/DeskGrid'
import { ContextList } from '@/components/context/ContextList'
import { ContextDetail } from '@/components/context/ContextDetail'
import { RunsPage } from '@/components/runs/RunsPage'
import { ChatView } from '@/components/chats/ChatView'
import type { Artifact, Chat, ContextItem } from '@/data/ui-types'
import {
  useGetWorkspacesQuery,
  useGetChatsQuery,
  useGetAgentsQuery,
  useGetMessagesQuery,
  useGetLibraryQuery,
  useCreateChatMutation,
  useDeleteChatMutation,
} from '@/store/api'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  setArtifactTransitionSource,
  setTodaySheetOpen,
  setAgentationVisible,
  markArtifactSaved,
  markUpdateRead,
  markChatRead,
} from '@/store/slices/uiSlice'
import { selectArtifactUpdates } from '@/store/slices/derivedSlice'
import { toUiChat } from '@/store/selectors/chats'
import { toUiRun } from '@/store/selectors/runs'
import { toContextItem } from '@/store/selectors/library'
import { toArtifactFromFile } from '@/store/selectors/artifacts'
import { buildPath, isRouteView, NEW_CHAT_ID, type RouteView } from '@/router/nav'

const NEW_CHAT_STUB: Chat = {
  id: NEW_CHAT_ID,
  title: 'New chat',
  lastMessage: '',
  updatedAt: new Date(),
  createdAt: new Date(),
  artifactIds: [],
  messages: [],
  unread: false,
  referenceIds: [],
}

export default function App() {
  return (
    <Routes>
      <Route path="/w/:wsId/:view" element={<AppInner />} />
      <Route path="*" element={<AppBoot />} />
    </Routes>
  )
}

// Landing route — waits for the workspace list, then redirects into the
// first workspace's Desk. Anything unrecognised also lands here.
function AppBoot() {
  const { data: serverWorkspaces } = useGetWorkspacesQuery()
  if (!serverWorkspaces || serverWorkspaces.length === 0) {
    return (
      <TooltipProvider>
        <Toaster position="bottom-right" />
        <div className="h-dvh" />
      </TooltipProvider>
    )
  }
  return <Navigate to={buildPath(serverWorkspaces[0].id, 'desk')} replace />
}

function AppInner() {
  const { wsId = '', view: viewParam } = useParams<{ wsId: string; view: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()

  const activeView: RouteView = isRouteView(viewParam) ? viewParam : 'desk'
  const activeWorkspaceId = wsId
  const selectedChatId = searchParams.get('chat')
  const selectedArtifactPath = searchParams.get('artifact')
  const selectedContextPath = searchParams.get('item')

  const artifactTransitionSource = useAppSelector(s => s.ui.artifactTransitionSource)
  const savedArtifactIdList = useAppSelector(s => s.ui.savedArtifactIds)
  const readUpdateIdList = useAppSelector(s => s.ui.readUpdateIds)
  const readChatIdList = useAppSelector(s => s.ui.readChatIds)
  const todaySheetOpen = useAppSelector(s => s.ui.todaySheetOpen)
  const agentationVisible = useAppSelector(s => s.ui.agentationVisible)
  const artifactUpdates = useAppSelector(selectArtifactUpdates)

  const savedArtifactIds = new Set(savedArtifactIdList)
  const readUpdateIds = new Set(readUpdateIdList)
  const readChatIds = new Set(readChatIdList)

  const { data: serverWorkspaces } = useGetWorkspacesQuery()
  const { data: serverAgents } = useGetAgentsQuery()

  // If the wsId in the URL isn't one the user has, bounce to the first.
  useEffect(() => {
    if (!serverWorkspaces || serverWorkspaces.length === 0) return
    if (serverWorkspaces.some(w => w.id === activeWorkspaceId)) return
    navigate(buildPath(serverWorkspaces[0].id, activeView), { replace: true })
  }, [serverWorkspaces, activeWorkspaceId, activeView, navigate])

  // One-shot artifact-open animation hint: cleared once the artifact pane closes.
  useEffect(() => {
    if (!selectedArtifactPath && artifactTransitionSource !== null) {
      dispatch(setArtifactTransitionSource(null))
    }
  }, [selectedArtifactPath, artifactTransitionSource, dispatch])

  const { data: serverChats } = useGetChatsQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId },
  )
  const chats: Chat[] = (serverChats ?? []).map(toUiChat)
  const [createChatMutation] = useCreateChatMutation()
  const [deleteChatMutation] = useDeleteChatMutation()

  const { data: runsResp } = useGetMessagesQuery(
    { workspaceId: activeWorkspaceId, scheduled: true },
    { skip: !activeWorkspaceId },
  )
  const runs = (runsResp?.items ?? []).map(m => toUiRun(m, serverAgents ?? []))

  // Agentation widget (Option+A)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'a') {
        e.preventDefault()
        dispatch(setAgentationVisible(!agentationVisible))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [agentationVisible, dispatch])
  useEffect(() => {
    const script = document.createElement('script')
    script.src = 'https://cdn.agentation.dev/agentation.js'
    script.defer = true
    document.head.appendChild(script)
    return () => { try { document.head.removeChild(script) } catch { /* ignore */ } }
  }, [])
  useEffect(() => {
    const t = setTimeout(() => {
      const el = document.querySelector('agentation-widget') as HTMLElement | null
      if (el) el.style.display = agentationVisible ? '' : 'none'
    }, 1000)
    return () => clearTimeout(t)
  }, [agentationVisible])

  // ── Nav actions (URL is the source of truth) ─────────────────────────────
  const goTo = useCallback((
    opts: {
      wsId?: string
      view?: RouteView
      chat?: string | null
      artifact?: string | null
      item?: string | null
    } = {},
  ) => {
    const ws = opts.wsId ?? activeWorkspaceId
    if (!ws) return
    navigate(buildPath(ws, opts.view ?? activeView, opts))
  }, [activeWorkspaceId, activeView, navigate])

  const enterCompose = useCallback(() => {
    goTo({ chat: NEW_CHAT_ID })
  }, [goTo])

  const handleViewChange = useCallback((view: RouteView) => {
    goTo({ view })
  }, [goTo])

  const handleGlobalToday = useCallback(() => {
    dispatch(setTodaySheetOpen(!todaySheetOpen))
  }, [dispatch, todaySheetOpen])

  const handleSelectWorkspace = useCallback((id: string) => {
    dispatch(setTodaySheetOpen(false))
    goTo({ wsId: id })
  }, [goTo, dispatch])

  const handleNavigateWorkspace = useCallback((id: string, view: WorkspaceNavView) => {
    goTo({ wsId: id, view })
  }, [goTo])

  const handleArtifactAdded = useCallback((_artifact: Artifact) => {
    // Compose-generated artifacts land server-side via the message POST;
    // we wait for the library refetch (triggered by cache invalidation or
    // the `artifact.created` WS event) to pick them up. No local cache.
  }, [])

  const handleArtifactClick = useCallback((artifact: Artifact, source?: 'compose' | 'chat') => {
    dispatch(setArtifactTransitionSource(source ?? null))
    goTo({ artifact: artifact.id })
  }, [dispatch, goTo])

  const handleSaveArtifact = useCallback((artifactId: string) => {
    dispatch(markArtifactSaved(artifactId))
  }, [dispatch])

  const handleComposeWithContext = useCallback((_items?: ContextItem[]) => {
    enterCompose()
  }, [enterCompose])

  const handleSidebarChatClick = useCallback((chat: { id: string }) => {
    dispatch(markChatRead(chat.id))
    goTo({ chat: chat.id })
  }, [dispatch, goTo])

  const handleNewChatFirstMessage = useCallback((message: string) => {
    if (!activeWorkspaceId || !serverAgents?.[0]) return
    const title = message.length > 50 ? message.slice(0, 50) + '…' : message
    void createChatMutation({
      workspaceId: activeWorkspaceId,
      agentId: serverAgents[0].id,
      title,
    })
  }, [activeWorkspaceId, serverAgents, createChatMutation])

  const handleDeleteChat = useCallback((chatId: string) => {
    void deleteChatMutation(chatId)
    if (selectedChatId === chatId) goTo({ chat: null })
  }, [deleteChatMutation, selectedChatId, goTo])

  // Inbox badge count = server-reported awaiting-user messages.
  // Don't filter by workspace — the inbox is global.
  const { data: awaitingResp } = useGetMessagesQuery({ awaitingUser: true })
  const unreadCount = awaitingResp?.items.length ?? 0

  const { data: libraryResp } = useGetLibraryQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId },
  )
  const libraryItems: ContextItem[] = (libraryResp?.items ?? []).map(toContextItem)
  const artifacts: Artifact[] = (libraryResp?.items ?? []).map(toArtifactFromFile)

  useEffect(() => {
    if (!libraryResp?.items) return
    for (const f of libraryResp.items) dispatch(markArtifactSaved(f.path))
  }, [libraryResp, dispatch])

  const deskUnreadCount = artifactUpdates.filter(u => !readUpdateIds.has(u.id)).length

  const handleDismissUpdate = useCallback((id: string) => {
    dispatch(markUpdateRead(id))
  }, [dispatch])

  const isNewChat = selectedChatId === NEW_CHAT_ID
  const selectedChat = (!isNewChat && selectedChatId) ? chats.find(c => c.id === selectedChatId) ?? null : null
  const activeChat = isNewChat ? NEW_CHAT_STUB : selectedChat
  const chatArtifacts = (selectedChat?.artifactIds ?? [])
    .map(id => artifacts.find(a => a.id === id))
    .filter(Boolean) as Artifact[]
  const chatShowNewBadge = !!(selectedChat?.unread && readChatIds.has(selectedChat.id))

  const selectedArtifact = selectedArtifactPath
    ? artifacts.find(a => a.id === selectedArtifactPath) ?? null
    : null
  const selectedContextItem = selectedContextPath
    ? libraryItems.find(c => c.id === selectedContextPath) ?? null
    : null

  return (
    <TooltipProvider>
      <Toaster position="bottom-right" />
      <AppShell
        activeView={activeView}
        onViewChange={handleViewChange}
        onCompose={enterCompose}
        chats={chats}
        artifacts={artifacts}
        selectedChatId={selectedChatId}
        onChatClick={handleSidebarChatClick}
        onDeleteChat={handleDeleteChat}
        unreadCount={unreadCount}
        deskUnreadCount={deskUnreadCount}
        readChatIds={readChatIds}
        isDetailOpen={!!(selectedArtifact || selectedContextItem)}
        onArtifactClick={(artifact) => handleArtifactClick(artifact)}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={handleSelectWorkspace}
        onGlobalToday={handleGlobalToday}
        onNavigateWorkspace={handleNavigateWorkspace}
        todaySheetOpen={todaySheetOpen}
        onTodaySheetClose={() => dispatch(setTodaySheetOpen(false))}
      >
        {selectedArtifact && (() => {
          const selectedArtifactUpdate = artifactUpdates.find(u => u.artifactId === selectedArtifact.id) ?? null
          return (
            <ArtifactDetail
              key={selectedArtifact.id}
              artifact={selectedArtifact}
              onBack={() => goTo({ artifact: null })}
              update={selectedArtifactUpdate}
              isUpdateRead={selectedArtifactUpdate ? readUpdateIds.has(selectedArtifactUpdate.id) : true}
              onDismissUpdate={handleDismissUpdate}
              transitionFrom={artifactTransitionSource ?? undefined}
              isSaved={savedArtifactIds.has(selectedArtifact.id)}
              onSave={() => handleSaveArtifact(selectedArtifact.id)}
            />
          )
        })()}

        {!selectedArtifact && selectedContextItem && (
          <ContextDetail
            key={selectedContextItem.id}
            item={selectedContextItem}
            onBack={() => goTo({ item: null })}
            onCompose={(items) => { goTo({ item: null }); handleComposeWithContext(items) }}
            onArtifactClick={(artifact) => {
              goTo({ view: 'desk', artifact: artifact.id })
            }}
          />
        )}

        {!selectedArtifact && !selectedContextItem && activeChat && (
          <ChatView
            key={activeChat.id}
            chat={activeChat}
            artifacts={isNewChat ? [] : chatArtifacts}
            onArtifactClick={(artifact) => handleArtifactClick(artifact, 'chat')}
            onDeleteChat={isNewChat ? () => goTo({ chat: null }) : handleDeleteChat}
            onFirstMessage={isNewChat ? handleNewChatFirstMessage : undefined}
            onArtifactAdded={isNewChat ? handleArtifactAdded : undefined}
            showNewBadge={!isNewChat && chatShowNewBadge}
            savedArtifactIds={savedArtifactIds}
            onSaveArtifact={handleSaveArtifact}
          />
        )}

        {!selectedArtifact && !selectedContextItem && !activeChat && activeView === 'desk' && (
          <DeskGrid
            artifacts={artifacts.filter(a => savedArtifactIds.has(a.id))}
            onArtifactClick={(artifact) => goTo({ artifact: artifact.id })}
            onCompose={enterCompose}
            updates={artifactUpdates}
            readUpdateIds={readUpdateIds}
            onDismissUpdate={handleDismissUpdate}
          />
        )}
        {!selectedArtifact && !selectedContextItem && !activeChat && activeView === 'runs' && (
          <RunsPage runs={runs} onCompose={enterCompose} />
        )}
        {!selectedArtifact && !selectedContextItem && !activeChat && activeView === 'context' && (
          <ContextList
            items={libraryItems}
            onItemClick={(item) => goTo({ item: item.id })}
            onCompose={handleComposeWithContext}
          />
        )}
      </AppShell>
    </TooltipProvider>
  )
}
