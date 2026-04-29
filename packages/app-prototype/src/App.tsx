import { useCallback, useEffect, useRef } from 'react'
import {
  Routes,
  Route,
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import { toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { AppShell } from '@/components/layout/AppShell'
import { LoginScreen } from '@/components/auth/LoginScreen'
import { DeskGrid } from '@/components/desk/DeskGrid'
import { ContextList } from '@/components/context/ContextList'
import { PinnedView } from '@/components/library/PinnedView'
import { ContextDetail } from '@/components/context/ContextDetail'
import { TasksPage } from '@/components/tasks/TasksPage'
import { ChatView } from '@/components/chats/ChatView'
import { GlobalPaletteProvider } from '@/components/global-palette/GlobalPaletteProvider'
import { GlobalPalette } from '@/components/global-palette/GlobalPalette'
import type { Artifact, Chat, ContextItem } from '@/data/ui-types'
import type { AttachmentRef } from '@/store/types'
import {
  useGetWorkspacesQuery,
  useGetChatsQuery,
  useGetAgentsQuery,
  useGetWorkspaceAgentsQuery,
  useGetMessagesQuery,
  useGetLibraryQuery,
  useGetLibraryFileQuery,
  useCreateChatMutation,
  useDeleteChatMutation,
  usePinChatLibraryRefMutation,
  useSaveChatAttachmentToLibraryMutation,
  usePostChatMessageMutation,
  usePatchMessageMutation,
  useRunMessageMutation,
  usePinLibraryItemMutation,
  useUnpinLibraryItemMutation,
} from '@/store/api'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  setArtifactTransitionSource,
  setArtifactBackLabel,
  setTodaySheetOpen,
  setAgentationVisible,
  markArtifactSaved,
  markUpdateRead,
  markChatRead,
  setPendingNewChatAgentId,
  setPendingSettingsSection,
} from '@/store/slices/uiSlice'
import { buildArtifactPrompt } from '@/lib/artifact-prompt'
import { selectArtifactUpdates } from '@/store/slices/derivedSlice'
import { toUiChat } from '@/store/selectors/chats'
import { toUiTask } from '@/store/selectors/tasks'
import { toContextItem } from '@/store/selectors/library'
import { toArtifactFromFile } from '@/store/selectors/artifacts'
import { buildPath, isRouteView, NEW_CHAT_ID, type RouteView } from '@/router/nav'
import { getSessionToken, logout } from '@/auth/session'
import { usePrefs } from '@/hooks/use-prefs'

// RTK Query rejects with `{ status, data: { code, message } }` from the
// server, not Error instances — so the common `err instanceof Error ?
// err.message : undefined` pattern silently drops the only useful detail.
// Pull the server's `data.message` when present, falling back to Error.
function extractApiError(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'data' in err) {
    const data = (err as { data?: unknown }).data
    if (data && typeof data === 'object' && 'message' in data) {
      const m = (data as { message?: unknown }).message
      if (typeof m === 'string') return m
    }
  }
  if (err instanceof Error) return err.message
  return undefined
}

const NEW_CHAT_STUB: Chat = {
  id: NEW_CHAT_ID,
  title: 'New chat',
  lastMessage: '',
  updatedAt: new Date(),
  createdAt: new Date(),
  artifactIds: [],
  messages: [],
  unread: false,
}

export default function App() {
  // No token → render the LoginScreen at the App root so AppInner's data
  // hooks don't fire 401-storms during the logged-out state.
  if (!getSessionToken()) {
    return (
      <TooltipProvider>
        <Toaster position="bottom-right" />
        <LoginScreen />
      </TooltipProvider>
    )
  }
  return (
    <Routes>
      <Route path="/w/:wsId/:view" element={<AppInner />} />
      <Route path="*" element={<AppBoot />} />
    </Routes>
  )
}

// Landing route — waits for the workspace list, then redirects into the
// first workspace's default view. Anything unrecognised also lands here.
function AppBoot() {
  const { data: serverWorkspaces } = useGetWorkspacesQuery()
  const { defaultView } = usePrefs()
  if (!serverWorkspaces || serverWorkspaces.length === 0) {
    return (
      <TooltipProvider>
        <Toaster position="bottom-right" />
        <div className="h-dvh" />
      </TooltipProvider>
    )
  }
  return <Navigate to={buildPath(serverWorkspaces[0].id, defaultView)} replace />
}

function AppInner() {
  const { wsId = '', view: viewParam } = useParams<{ wsId: string; view: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()

  const activeView: RouteView = isRouteView(viewParam) ? viewParam : 'tasks'
  const activeWorkspaceId = wsId
  const { defaultView } = usePrefs()
  const selectedChatId = searchParams.get('chat')
  const selectedArtifactPath = searchParams.get('artifact')
  const selectedContextPath = searchParams.get('item')
  const selectedMessageId = searchParams.get('message')

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

  const { data: serverWorkspaces, isFetching: wsFetching } = useGetWorkspacesQuery()
  const { data: serverAgents } = useGetAgentsQuery()
  const { data: workspaceServerAgents } = useGetWorkspaceAgentsQuery(
    activeWorkspaceId ?? '',
    { skip: !activeWorkspaceId },
  )

  // If the wsId in the URL isn't one the user has, bounce to the first.
  // Skip while the list is refetching — otherwise navigating to a
  // just-created workspace races the invalidation refetch and we'd bounce
  // back to workspaces[0] before the new id lands in the cache.
  useEffect(() => {
    if (wsFetching) return
    if (!serverWorkspaces || serverWorkspaces.length === 0) return
    if (serverWorkspaces.some(w => w.id === activeWorkspaceId)) return
    navigate(buildPath(serverWorkspaces[0].id, activeView), { replace: true })
  }, [serverWorkspaces, wsFetching, activeWorkspaceId, activeView, navigate])

  // One-shot artifact-open animation hint: cleared once the artifact pane closes.
  useEffect(() => {
    if (!selectedArtifactPath && artifactTransitionSource !== null) {
      dispatch(setArtifactTransitionSource(null))
      dispatch(setArtifactBackLabel(null))
    }
  }, [selectedArtifactPath, artifactTransitionSource, dispatch])

  const { data: serverChats } = useGetChatsQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId },
  )
  const chats: Chat[] = (serverChats ?? []).map(toUiChat)
  const [createChatMutation] = useCreateChatMutation()
  const [deleteChatMutation] = useDeleteChatMutation()
  const [postMessageMutation] = usePostChatMessageMutation()
  const [pinChatLibraryRefMutation] = usePinChatLibraryRefMutation()
  const [saveChatAttachmentToLibraryMutation] = useSaveChatAttachmentToLibraryMutation()

  const { data: tasksResp } = useGetMessagesQuery(
    { workspaceId: activeWorkspaceId, kind: ['task'] },
    { skip: !activeWorkspaceId },
  )
  const tasks = (tasksResp?.items ?? []).map(m => toUiTask(m, serverAgents ?? []))
  const [patchMessageMutation] = usePatchMessageMutation()
  const [runMessageMutation] = useRunMessageMutation()
  const [pinLibraryItem] = usePinLibraryItemMutation()
  const [unpinLibraryItem] = useUnpinLibraryItemMutation()

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
      folder?: string | null
      message?: string | null
    } = {},
  ) => {
    const ws = opts.wsId ?? activeWorkspaceId
    if (!ws) return
    navigate(buildPath(ws, opts.view ?? activeView, opts))
  }, [activeWorkspaceId, activeView, navigate])

  const enterCompose = useCallback(() => {
    goTo({ chat: NEW_CHAT_ID })
  }, [goTo])

  const handleChatWithAgent = useCallback((agentId: string) => {
    dispatch(setPendingNewChatAgentId(agentId))
    goTo({ chat: NEW_CHAT_ID })
  }, [dispatch, goTo])

  const handleViewChange = useCallback((view: RouteView) => {
    goTo({ view })
  }, [goTo])

  const handleGlobalToday = useCallback(() => {
    dispatch(setTodaySheetOpen(!todaySheetOpen))
  }, [dispatch, todaySheetOpen])

  // Workspace switch lands on the user's default view rather than carrying
  // over the current one — the avatar click is a "go home in workspace X"
  // action, not "navigate within this view to workspace X". `goTo` falls
  // back to the activeView when no view is passed, so we explicitly pass
  // the pref here.
  const handleSelectWorkspace = useCallback((id: string) => {
    dispatch(setTodaySheetOpen(false))
    goTo({ wsId: id, view: defaultView })
  }, [goTo, dispatch, defaultView])

  const handleArtifactClick = useCallback((artifact: Artifact, source?: 'compose' | 'chat', backLabel?: string) => {
    dispatch(setArtifactTransitionSource(source ?? null))
    dispatch(setArtifactBackLabel(backLabel ?? null))
    goTo({ artifact: artifact.id })
  }, [dispatch, goTo])

  // Promotes a chat-scoped attachment to the primary workspace library.
  // The `artifactId` is the artifact's workspace-relative path; for chat
  // attachments it has the shape `.chats/{chatId}/attachments/{name}`.
  // For files already in the library this is a no-op — they're already there.
  const handleSaveArtifact = useCallback(async (artifactId: string) => {
    const match = artifactId.match(/^\.chats\/([^/]+)\/attachments\/(.+)$/)
    if (!match) {
      // Already in primary library — just mark UI state.
      dispatch(markArtifactSaved(artifactId))
      return
    }
    const [, chatId, name] = match
    try {
      await saveChatAttachmentToLibraryMutation({ chatId, name }).unwrap()
      dispatch(markArtifactSaved(artifactId))
    } catch (err) {
      toast.error('Failed to save to Library', { description: extractApiError(err) })
    }
  }, [dispatch, saveChatAttachmentToLibraryMutation])

  // Library items the user picked via "Use in chat" — seeded into the
  // new-chat input tray so they ride the first message as attachments,
  // then pinned via library-refs once the chat exists so they show up in
  // the right-sidebar "In this chat" list (mirrors the `+` picker).
  //
  // Held in a ref, not state, because two `goTo` calls in the same handler
  // can produce an intermediate render that mounts ChatView with
  // half-committed state. Refs are stable across renders, so ChatView's
  // mount-time `useState` initializer always reads the current value.
  const composeStagedItemsRef = useRef<ContextItem[]>([])

  const handleComposeWithContext = useCallback((items?: ContextItem[]) => {
    composeStagedItemsRef.current = items ?? []
    enterCompose()
  }, [enterCompose])

  // Drop staged items once the user is no longer on the new-chat stub.
  // After the first message is sent, `handleNewChatFirstMessage` clears
  // the ref directly; this effect just covers the navigate-away-without-
  // sending case so a later re-mount doesn't replay stale picks.
  useEffect(() => {
    if (selectedChatId !== NEW_CHAT_ID) {
      composeStagedItemsRef.current = []
    }
  }, [selectedChatId])

  const handleSidebarChatClick = useCallback((chat: { id: string }) => {
    dispatch(markChatRead(chat.id))
    goTo({ chat: chat.id })
  }, [dispatch, goTo])

  const handleNewChatFirstMessage = useCallback(async (
    message: string,
    agentId?: string,
    attachments?: AttachmentRef[],
    options?: { kind?: 'task'; title?: string; executeAt?: string; goal?: string },
  ) => {
    if (!activeWorkspaceId) return
    // The workspace-agents query may not have resolved yet on first paint
    // or right after a workspace switch. Distinguish "still loading" from
    // "truly empty" so we don't tell the user to open Settings when the
    // real problem is a not-yet-arrived response.
    if (workspaceServerAgents === undefined) {
      toast.error('Still loading workspace — try again in a moment')
      return
    }
    // Default to an agent that's actually enrolled in this workspace —
    // the global agents list can include agents the user disabled here,
    // and POST /chats 400s if the agent isn't a workspace member.
    const pickedAgentId = agentId ?? workspaceServerAgents[0]?.id
    if (!pickedAgentId) {
      toast.error('No agent enabled in this workspace', {
        description: 'Open Settings → Agents to enable one.',
      })
      return
    }
    const title = message.length > 50 ? message.slice(0, 50) + '…' : message
    // Capture the staged library items now and clear the ref immediately so
    // a same-tick re-render of the new-chat stub can't re-seed stale picks.
    const itemsToPin = composeStagedItemsRef.current
    composeStagedItemsRef.current = []
    try {
      const newChat = await createChatMutation({
        workspaceId: activeWorkspaceId,
        agentId: pickedAgentId,
        title,
      }).unwrap()
      goTo({ chat: newChat.id })
      await postMessageMutation({
        chatId: newChat.id,
        content: message,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        kind: options?.kind,
        title: options?.title,
        executeAt: options?.executeAt,
        goal: options?.goal,
      }).unwrap()
      // Best-effort pin: failure leaves the file usable as a message
      // attachment, just absent from the right-sidebar "In this chat" list.
      for (const item of itemsToPin) {
        pinChatLibraryRefMutation({ chatId: newChat.id, path: item.id })
          .unwrap()
          .catch(() => {})
      }
    } catch (err) {
      toast.error('Failed to start chat', { description: extractApiError(err) })
    }
  }, [activeWorkspaceId, workspaceServerAgents, createChatMutation, postMessageMutation, pinChatLibraryRefMutation, goTo])

  const handleDeleteChat = useCallback((chatId: string) => {
    void deleteChatMutation(chatId)
    if (selectedChatId === chatId) goTo({ chat: null })
  }, [deleteChatMutation, selectedChatId, goTo])

  const handleCreateArtifact = useCallback(async (input: Parameters<typeof buildArtifactPrompt>[0]) => {
    if (!activeWorkspaceId) return
    const pickedAgentId = input.agentId ?? workspaceServerAgents?.[0]?.id ?? serverAgents?.[0]?.id
    if (!pickedAgentId) {
      toast.error('No agent enabled in this workspace', { description: 'Open Settings → Agents to enable one.' })
      return
    }
    try {
      const raw = input.name?.trim() || input.instructions || 'New artifact'
      const title = raw.length > 50 ? raw.slice(0, 50) + '…' : raw
      const newChat = await createChatMutation({ workspaceId: activeWorkspaceId, agentId: pickedAgentId, title }).unwrap()
      await postMessageMutation({
        chatId: newChat.id,
        content: buildArtifactPrompt(input),
        attachments: input.attachments?.length ? input.attachments : undefined,
      }).unwrap()
      goTo({ chat: newChat.id })
    } catch (err) {
      toast.error('Failed to create artifact', { description: err instanceof Error ? err.message : undefined })
    }
  }, [activeWorkspaceId, workspaceServerAgents, serverAgents, createChatMutation, postMessageMutation, goTo])

  // Inbox badge count = server-reported awaiting-user messages.
  // Don't filter by workspace — the inbox is global.
  const { data: awaitingResp } = useGetMessagesQuery({ awaitingUser: true })
  const unreadCount = awaitingResp?.items.length ?? 0

  const { data: libraryResp } = useGetLibraryQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId },
  )
  const libraryItems: ContextItem[] = activeWorkspaceId
    ? (libraryResp?.items ?? []).map((f) => toContextItem(f, activeWorkspaceId, serverAgents ?? []))
    : []
  const pinnedItems = libraryItems.filter(i => i.pinned)
  const artifacts: Artifact[] = (libraryResp?.items ?? []).map((f) => toArtifactFromFile(f, serverAgents ?? []))

  // Files already in `/library` are by definition in the user's library —
  // mark them as saved so any inline "Save to Library" affordance is
  // correctly disabled. Newly-promoted chat attachments are marked by the
  // mutation handler in `handleSaveArtifact`.
  useEffect(() => {
    if (!libraryResp?.items) return
    for (const f of libraryResp.items) dispatch(markArtifactSaved(f.path))
  }, [libraryResp, dispatch])

  const handleDismissUpdate = useCallback((id: string) => {
    dispatch(markUpdateRead(id))
  }, [dispatch])

  const isNewChat = selectedChatId === NEW_CHAT_ID
  const selectedChat = (!isNewChat && selectedChatId) ? chats.find(c => c.id === selectedChatId) ?? null : null
  const activeChat = isNewChat
    ? { ...NEW_CHAT_STUB, workspaceId: activeWorkspaceId || undefined }
    : selectedChat
  const chatArtifacts = (selectedChat?.artifactIds ?? [])
    .map(id => artifacts.find(a => a.id === id))
    .filter(Boolean) as Artifact[]
  const chatShowNewBadge = !!(selectedChat?.unread && readChatIds.has(selectedChat.id))

  // Both `?artifact=<path>` and `?item=<path>` route to the same unified
  // detail view. `?artifact` is kept as a deprecation alias — phase 4 of
  // the Desk → Library consolidation removes it.
  const effectiveItemPath = selectedContextPath ?? selectedArtifactPath
  const libraryItem = effectiveItemPath
    ? libraryItems.find(c => c.id === effectiveItemPath) ?? null
    : null
  // Fallback path: chat attachments live under `.chats/{id}/attachments/`
  // and don't appear in the default library listing. Fetch their metadata
  // by path so we can render the same ContextDetail view for them.
  const needsMetaFallback =
    !!effectiveItemPath && !libraryItem && !!activeWorkspaceId
  const { data: fallbackFile } = useGetLibraryFileQuery(
    { workspaceId: activeWorkspaceId ?? '', path: effectiveItemPath ?? '' },
    { skip: !needsMetaFallback },
  )
  const selectedContextItem: ContextItem | null =
    libraryItem ??
    (needsMetaFallback && fallbackFile && activeWorkspaceId
      ? toContextItem(fallbackFile, activeWorkspaceId, serverAgents ?? [])
      : null)


  return (
    <TooltipProvider>
      <Toaster position="bottom-right" />
      <GlobalPaletteProvider>
      <GlobalPalette
        activeWorkspaceId={activeWorkspaceId}
        onNavigatePage={(t) => {
          if (t.opensToday) {
            dispatch(setTodaySheetOpen(true))
            return
          }
          if (t.view) goTo({ view: t.view })
        }}
        onNavigateSettings={(t) => {
          dispatch(setPendingSettingsSection(t.section))
        }}
        onNavigateWorkspace={(id) => goTo({ wsId: id, view: defaultView })}
        onSelectChat={({ id, workspaceId }) => {
          goTo({ wsId: workspaceId || activeWorkspaceId, chat: id })
        }}
        onSelectFile={({ path, workspaceId }) => {
          goTo({ wsId: workspaceId || activeWorkspaceId, view: 'context', item: path })
        }}
      />
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
        readChatIds={readChatIds}
        isDetailOpen={!!selectedContextItem}
        onArtifactClick={(artifact) => handleArtifactClick(artifact)}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={handleSelectWorkspace}
        onGlobalToday={handleGlobalToday}
        todaySheetOpen={todaySheetOpen}
        onTodaySheetClose={() => dispatch(setTodaySheetOpen(false))}
        onSignOut={() => void logout()}
        onChatWithAgent={handleChatWithAgent}
        pinnedItems={pinnedItems}
        selectedItemId={effectiveItemPath}
        onPinnedItemClick={(item) => goTo({ view: 'context', item: item.id })}
        onUnpinItem={(item) => {
          if (activeWorkspaceId) void unpinLibraryItem({ workspaceId: activeWorkspaceId, path: item.id })
        }}
      >
        {selectedContextItem && (
          <ContextDetail
            key={selectedContextItem.id}
            item={selectedContextItem}
            onBack={() => {
              // Clear whichever param routed us here.
              goTo({ item: null, artifact: null })
              dispatch(setArtifactBackLabel(null))
            }}
            onCompose={(items) => {
              goTo({ item: null, artifact: null })
              handleComposeWithContext(items)
            }}
            onArtifactClick={(artifact) => {
              goTo({ item: artifact.id })
            }}
            onNavigateToFolder={(folderId) => goTo({ view: 'context', item: null, folder: folderId })}
          />
        )}

        {!selectedContextItem && activeChat && (
          <ChatView
            key={activeChat.id}
            chat={activeChat}
            artifacts={isNewChat ? [] : chatArtifacts}
            onArtifactClick={(artifact) => handleArtifactClick(artifact, 'chat', activeChat?.title)}
            onDeleteChat={isNewChat ? () => goTo({ chat: null }) : handleDeleteChat}
            onFirstMessage={isNewChat ? handleNewChatFirstMessage : undefined}
            showNewBadge={!isNewChat && chatShowNewBadge}
            savedArtifactIds={savedArtifactIds}
            onSaveArtifact={handleSaveArtifact}
            highlightMessageId={selectedMessageId ?? undefined}
            onAttachmentClick={(att) =>
              att.kind === 'directory'
                ? goTo({ view: 'context', item: null, folder: att.path })
                : goTo({ item: att.path })
            }
            initialStagedItems={isNewChat ? composeStagedItemsRef.current : undefined}
          />
        )}

        {!selectedContextItem && !activeChat && activeView === 'pinned' && (
          <Navigate to={buildPath(activeWorkspaceId, 'context')} replace />
        )}
        {!selectedContextItem && !activeChat && activeView === 'desk' && (
          <DeskGrid
            artifacts={artifacts.filter(a => savedArtifactIds.has(a.id))}
            workspaceId={activeWorkspaceId || undefined}
            onArtifactClick={(artifact) => goTo({ artifact: artifact.id })}
            onCreateArtifact={handleCreateArtifact}
            onSkipToChat={(agentId) => {
              if (agentId) dispatch(setPendingNewChatAgentId(agentId))
              goTo({ chat: NEW_CHAT_ID })
            }}
            updates={artifactUpdates}
            readUpdateIds={readUpdateIds}
            onDismissUpdate={handleDismissUpdate}
          />
        )}
        {!selectedContextItem && !activeChat && activeView === 'tasks' && (
          <TasksPage
            tasks={tasks}
            onTaskMove={async (task, newStatus) => {
              if (!task.chatId || !task.messageId) return
              // UI column → server action:
              //   active    → POST .../run (fires the agent now; server
              //               flips state pending→running and back).
              //   complete  → PATCH state:'cancelled' (terminal, allowed
              //               from any non-running state).
              //   todo      → PATCH executeAt+cron cleared and state:'pending'
              //               so terminal rows (succeeded/failed/cancelled)
              //               restore to the Todo column.
              //   scheduled → PATCH state:'pending' + a default executeAt
              //               (24h out) when the row has no schedule yet,
              //               so the drop doesn't require a separate
              //               "set a time" step. The user can edit the
              //               time from the task detail panel.
              if (newStatus === 'active') {
                try {
                  await runMessageMutation({
                    chatId: task.chatId,
                    messageId: task.messageId,
                  }).unwrap()
                } catch (err) {
                  toast.error('Run failed', { description: extractApiError(err) })
                }
                return
              }

              const hasSchedule = !!task.scheduledFor || !!task.schedule

              const patch: {
                state?: 'pending' | 'cancelled'
                executeAt?: string | null
                cron?: string | null
              } = {}

              if (newStatus === 'complete') {
                patch.state = 'cancelled'
              } else if (newStatus === 'todo') {
                patch.executeAt = null
                patch.cron = null
                patch.state = 'pending'
              } else if (newStatus === 'scheduled') {
                patch.state = 'pending'
                if (!hasSchedule) {
                  // Default to 24 hours out so the drop succeeds without a
                  // separate "set a time" prompt. The user can fine-tune
                  // from the task detail panel.
                  patch.executeAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
                }
              }

              try {
                await patchMessageMutation({
                  chatId: task.chatId,
                  messageId: task.messageId,
                  patch,
                }).unwrap()
              } catch (err) {
                toast.error('Move failed', { description: extractApiError(err) })
              }
            }}
            onCreateTask={async (input) => {
              if (!activeWorkspaceId) return
              const pickedAgentId = workspaceServerAgents?.[0]?.id ?? serverAgents?.[0]?.id
              if (!pickedAgentId) {
                toast.error('No agent enabled in this workspace', {
                  description: 'Open Settings → Agents to enable one.',
                })
                return
              }
              try {
                const newChat = await createChatMutation({
                  workspaceId: activeWorkspaceId,
                  agentId: pickedAgentId,
                  title: input.name.length > 50 ? input.name.slice(0, 50) + '…' : input.name,
                }).unwrap()
                // Self-firing task message — server inserts one row with kind=task,
                // schedules it via at-job if executeAt is set, fires immediately
                // otherwise.
                await postMessageMutation({
                  chatId: newChat.id,
                  content: input.description?.trim() ? `${input.name}\n\n${input.description}` : input.name,
                  kind: 'task',
                  title: input.name,
                  executeAt: input.status === 'scheduled' && input.scheduledFor
                    ? input.scheduledFor.toISOString()
                    : undefined,
                  cron: input.cron,
                }).unwrap()
              } catch (err) {
                toast.error('Failed to create task', {
                  description: err instanceof Error ? err.message : undefined,
                })
              }
            }}
          />
        )}
        {!selectedContextItem && !activeChat && activeView === 'context' && (
          <ContextList
            items={libraryItems}
            onItemClick={(item) => goTo({ item: item.id })}
            onCompose={handleComposeWithContext}
            onPinItem={(item) => {
              if (activeWorkspaceId) void pinLibraryItem({ workspaceId: activeWorkspaceId, path: item.id })
            }}
            onUnpinItem={(item) => {
              if (activeWorkspaceId) void unpinLibraryItem({ workspaceId: activeWorkspaceId, path: item.id })
            }}
            onCreateArtifact={handleCreateArtifact}
            onSkipToChat={async (agentId) => {
              if (agentId) dispatch(setPendingNewChatAgentId(agentId))
              enterCompose()
            }}
          />
        )}
      </AppShell>
      </GlobalPaletteProvider>
    </TooltipProvider>
  )
}
