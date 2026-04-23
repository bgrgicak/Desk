import { useState, useCallback, useEffect } from 'react'
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
import {
  MOCK_ARTIFACTS,
  MOCK_ARTIFACT_UPDATES,
  type Artifact,
  type Chat,
  type ContextItem,
} from '@/data/mock-data'
import {
  useGetWorkspacesQuery,
  useGetChatsQuery,
  useGetAgentsQuery,
  useGetMessagesQuery,
  useGetLibraryQuery,
  useCreateChatMutation,
  useDeleteChatMutation,
} from '@/store/api'
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
  const { data: serverWorkspaces } = useGetWorkspacesQuery()
  const { data: serverAgents }     = useGetAgentsQuery()
  const [activeView, setActiveView]               = useState<View>('desk')
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>('')

  // Once workspaces arrive, default to the first one. Re-runs only if the
  // active id isn't present (user deleted it, etc.).
  useEffect(() => {
    if (!serverWorkspaces || serverWorkspaces.length === 0) return
    const exists = serverWorkspaces.some(w => w.id === activeWorkspaceId)
    if (!exists) setActiveWorkspaceId(serverWorkspaces[0].id)
  }, [serverWorkspaces, activeWorkspaceId])
  const [selectedChatId, setSelectedChatId]       = useState<string | null>(null)
  const [selectedArtifact, setSelectedArtifact]   = useState<Artifact | null>(null)
  const [artifactTransitionSource, setArtifactTransitionSource] = useState<'compose' | 'chat' | null>(null)
  // IDs of artifacts that have been explicitly saved to the Desk. Server-
  // persisted artifacts from the library are considered saved by default
  // (they're already on disk). Local compose-session artifacts start
  // unsaved — the user must explicitly save them via handleSaveArtifact.
  const [savedArtifactIds, setSavedArtifactIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [selectedContextItem, setSelectedContextItem] = useState<ContextItem | null>(null)
  // Local additions from the compose flow (optimistic — the chat's
  // server-side artifact appears via the library query once it's
  // persisted). We keep them merged in until the library refetch
  // catches up.
  const [localArtifacts, setLocalArtifacts] = useState<Artifact[]>([])

  // Server-backed chats for the active workspace. Sidebar + selectors
  // consume the same Chat shape they did with MOCK_CHATS; the mapper
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
  const [readUpdateIds, setReadUpdateIds]          = useState<Set<string>>(new Set())
  const [readChatIds, setReadChatIds]              = useState<Set<string>>(new Set())
  const [todaySheetOpen, setTodaySheetOpen]        = useState(false)

  // Agentation widget (Option+A)
  const [agentationVisible, setAgentationVisible] = useState(true)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'a') { e.preventDefault(); setAgentationVisible(v => !v) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
  useEffect(() => {
    const script = document.createElement('script')
    script.src = 'https://cdn.agentation.dev/agentation.js'
    script.defer = true
    document.head.appendChild(script)
    return () => { try { document.head.removeChild(script) } catch {} }
  }, [])
  useEffect(() => {
    const t = setTimeout(() => {
      const el = document.querySelector('agentation-widget') as HTMLElement | null
      if (el) el.style.display = agentationVisible ? '' : 'none'
    }, 1000)
    return () => clearTimeout(t)
  }, [agentationVisible])

  const enterCompose = useCallback(() => {
    setSelectedChatId('__new__')
    if (activeView === 'today') setActiveView('desk')
  }, [activeView])

  const exitCompose = useCallback(() => {
    setSelectedChatId(null)
  }, [])

  // Clear detail views (artifact + context) when navigating away
  const clearDetailViews = useCallback(() => {
    setSelectedArtifact(null)
    setArtifactTransitionSource(null)
    setSelectedContextItem(null)
  }, [])

  // When switching nav views, clear the selected chat and any open detail view
  const handleViewChange = useCallback((view: View) => {
    setActiveView(view)
    setSelectedChatId(null)
    clearDetailViews()
  }, [clearDetailViews])

  // Global Today (from workspace bar) — toggles the left sheet
  const handleGlobalToday = useCallback(() => {
    setTodaySheetOpen(prev => !prev)
  }, [])

  // Switch workspace, preserving current view unless it's unavailable
  const handleSelectWorkspace = useCallback((id: string) => {
    setActiveWorkspaceId(id)
    setTodaySheetOpen(false)
    clearDetailViews()
    // chats are unavailable per-workspace → fall back to Desk
    if (selectedChatId) {
      setActiveView('desk')
      setSelectedChatId(null)
    }
  }, [selectedChatId, clearDetailViews])

  // Navigate to a specific area within a workspace (from hover dropdown)
  const handleNavigateWorkspace = useCallback((id: string, view: WorkspaceNavView) => {
    setActiveWorkspaceId(id)
    setActiveView(view)
    setSelectedChatId(null)
    clearDetailViews()
  }, [clearDetailViews])

  const handleArtifactAdded = useCallback((artifact: Artifact) => {
    // Keep compose-generated artifacts locally until the server's
    // library refetch picks them up. Not added to savedArtifactIds —
    // user must explicitly save to desk.
    setLocalArtifacts(prev => [artifact, ...prev])
  }, [])

  const handleArtifactClick = useCallback((artifact: Artifact, source?: 'compose' | 'chat') => {
    setSelectedArtifact(artifact)
    setArtifactTransitionSource(source ?? null)
  }, [])

  const handleSaveArtifact = useCallback((artifactId: string) => {
    setSavedArtifactIds(prev => new Set([...prev, artifactId]))
  }, [])

  const handleComposeWithContext = useCallback((_items?: ContextItem[]) => {
    enterCompose()
  }, [enterCompose])

  // Sidebar chat click → open as full-page chat view; mark as read so dot disappears
  const handleSidebarChatClick = useCallback((chat: { id: string }) => {
    setSelectedChatId(chat.id)
    setReadChatIds(prev => new Set([...prev, chat.id]))
    setSelectedArtifact(null)
    setArtifactTransitionSource(null)
    setSelectedContextItem(null)
  }, [])

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
    setSelectedChatId(prev => prev === chatId ? null : prev)
  }, [deleteChatMutation])

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
  // (which is where the server persists artifact files). We merge
  // compose-generated local artifacts on top until the refetch arrives.
  const artifacts: Artifact[] = [
    ...localArtifacts,
    ...(libraryResp?.items ?? []).map(toArtifactFromFile),
  ]

  // Auto-register server-backed artifacts as "saved to desk" once they
  // arrive. User-created compose artifacts stay unsaved until the user
  // explicitly saves them via the detail view.
  useEffect(() => {
    if (!libraryResp?.items) return
    setSavedArtifactIds(prev => {
      const next = new Set(prev)
      for (const f of libraryResp.items) next.add(f.path)
      return next
    })
  }, [libraryResp])
  const deskUnreadCount  = MOCK_ARTIFACT_UPDATES.filter(u => !readUpdateIds.has(u.id)).length

  const handleDismissUpdate = useCallback((id: string) => {
    setReadUpdateIds(prev => new Set([...prev, id]))
  }, [])

  // ── Main shell ────────────────────────────────────────────────────────────
  const isNewChat     = selectedChatId === '__new__'
  const selectedChat  = (!isNewChat && selectedChatId) ? chats.find(c => c.id === selectedChatId) ?? null : null
  const activeChat    = isNewChat ? NEW_CHAT_STUB : selectedChat
  const chatArtifacts = (selectedChat?.artifactIds ?? []).map(id => artifacts.find(a => a.id === id)).filter(Boolean) as typeof artifacts
  const chatShowNewBadge = !!(selectedChat?.unread && readChatIds.has(selectedChat.id))

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
        onTodaySheetClose={() => setTodaySheetOpen(false)}
      >
        {/* Artifact detail — takes over main area when an artifact is open */}
        {selectedArtifact && (() => {
          const selectedArtifactUpdate = MOCK_ARTIFACT_UPDATES.find(u => u.artifactId === selectedArtifact.id) ?? null
          return (
            <ArtifactDetail
              key={selectedArtifact.id}
              artifact={selectedArtifact}
              onBack={() => { setSelectedArtifact(null); setArtifactTransitionSource(null) }}
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
            onBack={() => setSelectedContextItem(null)}
            onCompose={(items) => { setSelectedContextItem(null); handleComposeWithContext(items) }}
            onArtifactClick={(artifact) => {
              setSelectedContextItem(null)
              setSelectedArtifact(artifact)
              setActiveView('desk')
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
            onDeleteChat={isNewChat ? () => setSelectedChatId(null) : handleDeleteChat}
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
            onArtifactClick={(artifact) => setSelectedArtifact(artifact)}
            onCompose={enterCompose}
            updates={MOCK_ARTIFACT_UPDATES}
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
            onItemClick={(item) => setSelectedContextItem(item)}
            onCompose={handleComposeWithContext}
          />
        )}
      </AppShell>
    </TooltipProvider>
  )
}

export default App
