import { useCallback, useEffect } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppShell, type View } from '@/components/layout/AppShell'
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
  setActiveView,
  setActiveWorkspaceId,
  setSelectedChatId,
  setSelectedArtifact,
  setSelectedContext,
  setTodaySheetOpen,
  setAgentationVisible,
  markArtifactSaved,
  markUpdateRead,
  markChatRead,
  clearDetailViews,
} from '@/store/slices/uiSlice'
import { selectArtifactUpdates } from '@/store/slices/derivedSlice'
import { toUiChat } from '@/store/selectors/chats'
import { toUiRun } from '@/store/selectors/runs'
import { toContextItem } from '@/store/selectors/library'
import { toArtifactFromFile } from '@/store/selectors/artifacts'

const NEW_CHAT_STUB: Chat = {
  id: '__new__',
  title: 'New chat',
  lastMessage: '',
  updatedAt: new Date(),
  createdAt: new Date(),
  artifactIds: [],
  messages: [],
  unread: false,
  referenceIds: [],
}

function App() {
  const dispatch = useAppDispatch()
  const activeView = useAppSelector(s => s.ui.activeView)
  const activeWorkspaceId = useAppSelector(s => s.ui.activeWorkspaceId) ?? ''
  const selectedChatId = useAppSelector(s => s.ui.selectedChatId)
  const selectedArtifactPath = useAppSelector(s => s.ui.selectedArtifactPath)
  const artifactTransitionSource = useAppSelector(s => s.ui.artifactTransitionSource)
  const selectedContextPath = useAppSelector(s => s.ui.selectedContextPath)
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

  // Once workspaces arrive, default to the first one. Re-runs only if the
  // active id isn't present (user deleted it, etc.).
  useEffect(() => {
    if (!serverWorkspaces || serverWorkspaces.length === 0) return
    const exists = serverWorkspaces.some(w => w.id === activeWorkspaceId)
    if (!exists) dispatch(setActiveWorkspaceId(serverWorkspaces[0].id))
  }, [serverWorkspaces, activeWorkspaceId, dispatch])

  // Server-backed chats for the active workspace. Sidebar + selectors
  // consume the same Chat shape the UI expected before; the mapper
  // preserves that so no downstream component changes are needed.
  const { data: serverChats } = useGetChatsQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId },
  )
  const chats: Chat[] = (serverChats ?? []).map(toUiChat)
  const [createChatMutation] = useCreateChatMutation()
  const [deleteChatMutation] = useDeleteChatMutation()

  // Scheduled / executing messages, scoped to the active workspace.
  // Drives the Runs page.
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

  const enterCompose = useCallback(() => {
    dispatch(setSelectedChatId('__new__'))
    if (activeView === 'today') dispatch(setActiveView('desk'))
  }, [activeView, dispatch])

  // When switching nav views, clear the selected chat and any open detail view
  const handleViewChange = useCallback((view: View) => {
    dispatch(setActiveView(view))
    dispatch(setSelectedChatId(null))
    dispatch(clearDetailViews())
  }, [dispatch])

  // Global Today (from workspace bar) — toggles the left sheet
  const handleGlobalToday = useCallback(() => {
    dispatch(setTodaySheetOpen(!todaySheetOpen))
  }, [dispatch, todaySheetOpen])

  // Switch workspace, preserving current view unless it's unavailable
  const handleSelectWorkspace = useCallback((id: string) => {
    dispatch(setActiveWorkspaceId(id))
    dispatch(setTodaySheetOpen(false))
    dispatch(clearDetailViews())
    // chats are scoped per-workspace → drop the selected chat
    if (selectedChatId) {
      dispatch(setActiveView('desk'))
      dispatch(setSelectedChatId(null))
    }
  }, [selectedChatId, dispatch])

  // Navigate to a specific area within a workspace (from hover dropdown)
  const handleNavigateWorkspace = useCallback((id: string, view: WorkspaceNavView) => {
    dispatch(setActiveWorkspaceId(id))
    dispatch(setActiveView(view))
    dispatch(setSelectedChatId(null))
    dispatch(clearDetailViews())
  }, [dispatch])

  const handleArtifactAdded = useCallback((_artifact: Artifact) => {
    // Compose-generated artifacts land server-side via the message POST;
    // we wait for the library refetch (triggered by cache invalidation or
    // the `artifact.created` WS event) to pick them up. No local cache.
  }, [])

  const handleArtifactClick = useCallback((artifact: Artifact, source?: 'compose' | 'chat') => {
    dispatch(setSelectedArtifact({ path: artifact.id, source: source ?? null }))
  }, [dispatch])

  const handleSaveArtifact = useCallback((artifactId: string) => {
    dispatch(markArtifactSaved(artifactId))
  }, [dispatch])

  const handleComposeWithContext = useCallback((_items?: ContextItem[]) => {
    enterCompose()
  }, [enterCompose])

  // Sidebar chat click → open as full-page chat view; mark as read so dot disappears
  const handleSidebarChatClick = useCallback((chat: { id: string }) => {
    dispatch(setSelectedChatId(chat.id))
    dispatch(markChatRead(chat.id))
    dispatch(clearDetailViews())
  }, [dispatch])

  // First message sent in a new chat → create it server-side. The
  // chat list is cache-tagged so it re-renders as soon as the mutation
  // resolves; no local append needed.
  const handleNewChatFirstMessage = useCallback((message: string) => {
    if (!activeWorkspaceId || !serverAgents?.[0]) return
    const title = message.length > 50 ? message.slice(0, 50) + '…' : message
    void createChatMutation({
      workspaceId: activeWorkspaceId,
      agentId: serverAgents[0].id,
      title,
    })
  }, [activeWorkspaceId, serverAgents, createChatMutation])

  // Delete a chat — delete server-side; cache invalidation removes it
  // from the list. Deselect if it was open.
  const handleDeleteChat = useCallback((chatId: string) => {
    void deleteChatMutation(chatId)
    if (selectedChatId === chatId) dispatch(setSelectedChatId(null))
  }, [deleteChatMutation, selectedChatId, dispatch])

  // Inbox badge count = server-reported awaiting-user messages.
  // Don't filter by workspace — the inbox is global.
  const { data: awaitingResp } = useGetMessagesQuery({ awaitingUser: true })
  const unreadCount = awaitingResp?.items.length ?? 0

  // Library (aka Context) — files stored under the workspace's
  // library/ tree. Folders/links/notes stay client-derived.
  const { data: libraryResp } = useGetLibraryQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId },
  )
  const libraryItems: ContextItem[] = (libraryResp?.items ?? []).map(toContextItem)

  // Desk grid / chat artifact lookups read from the same library query
  // (which is where the server persists artifact files).
  const artifacts: Artifact[] = (libraryResp?.items ?? []).map(toArtifactFromFile)

  // Auto-register server-backed artifacts as "saved to desk" once they
  // arrive. User-created compose artifacts stay unsaved until the user
  // explicitly saves them via the detail view.
  useEffect(() => {
    if (!libraryResp?.items) return
    for (const f of libraryResp.items) dispatch(markArtifactSaved(f.path))
  }, [libraryResp, dispatch])

  const deskUnreadCount = artifactUpdates.filter(u => !readUpdateIds.has(u.id)).length

  const handleDismissUpdate = useCallback((id: string) => {
    dispatch(markUpdateRead(id))
  }, [dispatch])

  // ── Main shell ────────────────────────────────────────────────────────────
  const isNewChat = selectedChatId === '__new__'
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
        {/* Artifact detail — takes over main area when an artifact is open */}
        {selectedArtifact && (() => {
          const selectedArtifactUpdate = artifactUpdates.find(u => u.artifactId === selectedArtifact.id) ?? null
          return (
            <ArtifactDetail
              key={selectedArtifact.id}
              artifact={selectedArtifact}
              onBack={() => dispatch(setSelectedArtifact({ path: null, source: null }))}
              update={selectedArtifactUpdate}
              isUpdateRead={selectedArtifactUpdate ? readUpdateIds.has(selectedArtifactUpdate.id) : true}
              onDismissUpdate={handleDismissUpdate}
              transitionFrom={artifactTransitionSource ?? undefined}
              isSaved={savedArtifactIds.has(selectedArtifact.id)}
              onSave={() => handleSaveArtifact(selectedArtifact.id)}
            />
          )
        })()}

        {/* Context (library) detail — takes over when a context item is open */}
        {!selectedArtifact && selectedContextItem && (
          <ContextDetail
            key={selectedContextItem.id}
            item={selectedContextItem}
            onBack={() => dispatch(setSelectedContext(null))}
            onCompose={(items) => { dispatch(setSelectedContext(null)); handleComposeWithContext(items) }}
            onArtifactClick={(artifact) => {
              dispatch(setSelectedContext(null))
              dispatch(setSelectedArtifact({ path: artifact.id, source: null }))
              dispatch(setActiveView('desk'))
            }}
          />
        )}

        {/* Chat view — takes over main area when a chat is selected or composing */}
        {!selectedArtifact && !selectedContextItem && activeChat && (
          <ChatView
            key={activeChat.id}
            chat={activeChat}
            artifacts={isNewChat ? [] : chatArtifacts}
            onArtifactClick={(artifact) => handleArtifactClick(artifact, 'chat')}
            onDeleteChat={isNewChat ? () => dispatch(setSelectedChatId(null)) : handleDeleteChat}
            onFirstMessage={isNewChat ? handleNewChatFirstMessage : undefined}
            onArtifactAdded={isNewChat ? handleArtifactAdded : undefined}
            showNewBadge={!isNewChat && chatShowNewBadge}
            savedArtifactIds={savedArtifactIds}
            onSaveArtifact={handleSaveArtifact}
          />
        )}

        {/* Normal page views */}
        {!selectedArtifact && !selectedContextItem && !activeChat && activeView === 'desk' && (
          <DeskGrid
            artifacts={artifacts.filter(a => savedArtifactIds.has(a.id))}
            onArtifactClick={(artifact) => dispatch(setSelectedArtifact({ path: artifact.id, source: null }))}
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
            onItemClick={(item) => dispatch(setSelectedContext(item.id))}
            onCompose={handleComposeWithContext}
          />
        )}
      </AppShell>
    </TooltipProvider>
  )
}

export default App
