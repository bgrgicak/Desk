import { useState, useCallback, useEffect } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppShell, type View } from '@/components/layout/AppShell'
import type { WorkspaceNavView } from '@/components/layout/WorkspaceBar'
import { LoginScreen } from '@/components/auth/LoginScreen'
import { ArtifactDetail } from '@/components/artifact/ArtifactDetail'
import { DeskGrid } from '@/components/desk/DeskGrid'
import { ContextList } from '@/components/context/ContextList'
import { ContextDetail } from '@/components/context/ContextDetail'
import { TasksPage } from '@/components/tasks/TasksPage'
import { ChatView } from '@/components/chats/ChatView'
import {
  MOCK_ARTIFACTS,
  MOCK_INBOX,
  MOCK_CONTEXT,
  MOCK_TASKS,
  MOCK_CHATS,
  MOCK_ARTIFACT_UPDATES,
  type Artifact,
  type Chat,
  type ContextItem,
  type Task,
} from '@/data/mock-data'

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
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [activeView, setActiveView]               = useState<View>('desk')
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('general')
  const [selectedChatId, setSelectedChatId]       = useState<string | null>(null)
  const [selectedArtifact, setSelectedArtifact]   = useState<Artifact | null>(null)
  const [artifactTransitionSource, setArtifactTransitionSource] = useState<'compose' | 'chat' | null>(null)
  // IDs of artifacts that have been explicitly saved to the Desk. All pre-existing mock artifacts start saved.
  const [savedArtifactIds, setSavedArtifactIds] = useState<Set<string>>(
    () => new Set(MOCK_ARTIFACTS.map(a => a.id))
  )
  const [selectedContextItem, setSelectedContextItem] = useState<ContextItem | null>(null)
  const [artifacts, setArtifacts]                 = useState<Artifact[]>(MOCK_ARTIFACTS)
  const [chats, setChats]                         = useState(MOCK_CHATS)
  const [readUpdateIds, setReadUpdateIds]          = useState<Set<string>>(new Set())
  const [readChatIds, setReadChatIds]              = useState<Set<string>>(new Set())
  const [todaySheetOpen, setTodaySheetOpen]        = useState(false)
  const [tasks, setTasks]                          = useState<Task[]>(MOCK_TASKS)
  const [createTaskSheetOpen, setCreateTaskSheetOpen] = useState(false)

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
    // Add to the artifact pool but NOT to savedArtifactIds — user must explicitly save to desk
    setArtifacts(prev => [artifact, ...prev])
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

  // First message sent in a new chat → add a sidebar entry without remounting ChatView
  const handleNewChatFirstMessage = useCallback((message: string) => {
    const title = message.length > 50 ? message.slice(0, 50) + '…' : message
    const newEntry: Chat = {
      id: `chat-new-${Date.now()}`,
      title,
      lastMessage: message,
      updatedAt: new Date(),
      createdAt: new Date(),
      artifactIds: [],
      messages: [],
      unread: false,
      referenceIds: [],
    }
    setChats(prev => [newEntry, ...prev])
  }, [])

  // Delete a chat — remove from list, deselect if it was open
  const handleDeleteChat = useCallback((chatId: string) => {
    setChats(prev => prev.filter(c => c.id !== chatId))
    setSelectedChatId(prev => prev === chatId ? null : prev)
  }, [])

  const unreadCount      = MOCK_INBOX.filter(i => !i.read).length
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

  if (!isLoggedIn) {
    return (
      <TooltipProvider>
        <Toaster position="bottom-right" />
        <LoginScreen onLogin={() => setIsLoggedIn(true)} />
      </TooltipProvider>
    )
  }

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
        onSignOut={() => setIsLoggedIn(false)}
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
          <TasksPage
            tasks={tasks}
            onTasksChange={setTasks}
            createSheetOpen={createTaskSheetOpen}
            onOpenCreateSheet={() => setCreateTaskSheetOpen(true)}
            onCloseCreateSheet={() => setCreateTaskSheetOpen(false)}
          />
        )}
        {!selectedArtifact && !selectedContextItem && !activeChat && activeView === 'context' && (
          <ContextList
            items={MOCK_CONTEXT}
            onItemClick={(item) => setSelectedContextItem(item)}
            onCompose={handleComposeWithContext}
          />
        )}
      </AppShell>
    </TooltipProvider>
  )
}

export default App
