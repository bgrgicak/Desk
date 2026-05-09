import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  TooltipProvider,
  Toaster,
} from '@agent-desk/ui'
import { AppShell } from '@/components/layout/AppShell'
import { LoginScreen } from '@/components/auth/LoginScreen'
import { ContextList } from '@/components/context/ContextList'
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
  useGetMeQuery,
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
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import {
  setArtifactTransitionSource,
  setArtifactBackLabel,
  setTodaySheetOpen,
  setAgentationVisible,
  markArtifactSaved,
  setPendingNewChatAgentId,
  setPendingSettingsSection,
} from '@/store/slices/uiSlice'
import { buildArtifactPrompt } from '@/lib/artifact-prompt'
import { markChatReadQuietly } from '@/store/ws/middleware'
import type { SendOptions } from '@/components/compose/ChatInput'
import { toUiChat } from '@/store/selectors/chats'
import { isTaskListMessageForDeveloperMode, summaryRequestMessageKindsForDeveloperMode, taskMessageKindsForDeveloperMode, toUiTask } from '@/store/selectors/tasks'
import { toContextItem } from '@/store/selectors/library'
import { toArtifactFromFile } from '@/store/selectors/artifacts'
import { buildPath, isRouteView, NEW_CHAT_ID, type RouteView } from '@/router/nav'
import { getSessionToken, logout } from '@/auth/session'
import { usePrefs } from '@/hooks/use-prefs'
import type { PrefsShape } from '@/components/settings/SettingsModal'
import { getLastWorkspaceUrl, saveLastWorkspaceUrl } from '@/lib/workspace-last-url'
import {
  acceptBrowserNotificationPermissionOffer,
  markBrowserNotificationPermissionOffered,
  shouldOfferBrowserNotificationPermissionOnce,
} from '@/lib/account-notifications'

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

function buildDefaultViewPath(wsId: string, defaultView: PrefsShape['defaultView']): string {
  if (defaultView === 'new-chat') return buildPath(wsId, 'pinned', { chat: NEW_CHAT_ID })
  if (defaultView === 'desk') return buildPath(wsId, 'pinned')
  return buildPath(wsId, defaultView)
}

function parseArtifactParams(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => (
      typeof entry[0] === 'string' && typeof entry[1] === 'string'
    ))
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  } catch {
    return undefined
  }
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
  const { defaultView, loaded: prefsLoaded } = usePrefs()
  if (!serverWorkspaces || serverWorkspaces.length === 0 || !prefsLoaded) {
    return (
      <TooltipProvider>
        <Toaster position="bottom-right" />
        <div className="h-dvh" />
      </TooltipProvider>
    )
  }
  return <Navigate to={buildDefaultViewPath(serverWorkspaces[0].id, defaultView)} replace />
}

function AppInner() {
  const { wsId = '', view: viewParam } = useParams<{ wsId: string; view: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const dispatch = useAppDispatch()
  const appStore = useAppStore()
  const [notificationPromptOpen, setNotificationPromptOpen] = useState(false)

  const activeView: RouteView = isRouteView(viewParam) ? viewParam : 'tasks'
  const activeWorkspaceId = wsId
  const { defaultView, developerMode } = usePrefs()
  const selectedChatId = searchParams.get('chat')
  const selectedArtifactPath = searchParams.get('artifact')
  const selectedContextPath = searchParams.get('item')
  const selectedMessageId = searchParams.get('message')
  const selectedArtifactParams = parseArtifactParams(searchParams.get('artifactParams'))

  const artifactTransitionSource = useAppSelector(s => s.ui.artifactTransitionSource)
  const savedArtifactIdList = useAppSelector(s => s.ui.savedArtifactIds)
  const todaySheetOpen = useAppSelector(s => s.ui.todaySheetOpen)
  const agentationVisible = useAppSelector(s => s.ui.agentationVisible)

  const savedArtifactIds = new Set(savedArtifactIdList)

  const { data: serverWorkspaces, isFetching: wsFetching } = useGetWorkspacesQuery()
  const { data: me } = useGetMeQuery()
  const { data: serverAgents } = useGetAgentsQuery(undefined, { skip: !!activeWorkspaceId })
  const { currentData: workspaceServerAgents } = useGetWorkspaceAgentsQuery(
    activeWorkspaceId ?? '',
    { skip: !activeWorkspaceId, refetchOnMountOrArgChange: true },
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

  useEffect(() => {
    if (!activeWorkspaceId) return
    saveLastWorkspaceUrl(activeWorkspaceId, `${location.pathname}${location.search}${location.hash}`)
  }, [activeWorkspaceId, location.pathname, location.search, location.hash])

  useEffect(() => {
    setNotificationPromptOpen(shouldOfferBrowserNotificationPermissionOnce(me?.id))
  }, [me?.id])

  const dismissNotificationPrompt = useCallback(() => {
    markBrowserNotificationPermissionOffered(me?.id)
    setNotificationPromptOpen(false)
  }, [me?.id])

  const enableDesktopNotifications = useCallback(async () => {
    await acceptBrowserNotificationPermissionOffer(me?.id)
    setNotificationPromptOpen(false)
  }, [me?.id])

  // One-shot artifact-open animation hint: cleared once the artifact pane closes.
  useEffect(() => {
    if (!selectedArtifactPath && artifactTransitionSource !== null) {
      dispatch(setArtifactTransitionSource(null))
      dispatch(setArtifactBackLabel(null))
    }
  }, [selectedArtifactPath, artifactTransitionSource, dispatch])

  const {
    currentData: serverChats,
    isFetching: chatsFetching,
    isLoading: chatsLoading,
    isUninitialized: chatsUninitialized,
    isError: chatsError,
  } = useGetChatsQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId, refetchOnMountOrArgChange: true },
  )
  const [locallyCreatedChats, setLocallyCreatedChats] = useState<Chat[]>([])
  const serverUiChats: Chat[] = (serverChats ?? []).map(toUiChat)
  const serverChatIds = new Set(serverUiChats.map(c => c.id))
  const chats: Chat[] = [
    ...locallyCreatedChats.filter(c => c.workspaceId === activeWorkspaceId && !serverChatIds.has(c.id)),
    ...serverUiChats,
  ]
  useEffect(() => {
    if (!serverChats?.length || locallyCreatedChats.length === 0) return
    setLocallyCreatedChats(prev => prev.filter(c => !serverChats.some(sc => sc.id === c.id)))
  }, [serverChats, locallyCreatedChats.length])
  const [createChatMutation] = useCreateChatMutation()
  const [deleteChatMutation] = useDeleteChatMutation()
  const [postMessageMutation] = usePostChatMessageMutation()
  const [pinChatLibraryRefMutation] = usePinChatLibraryRefMutation()
  const [saveChatAttachmentToLibraryMutation] = useSaveChatAttachmentToLibraryMutation()

  const { currentData: tasksResp, isFetching: tasksFetching, isLoading: tasksLoading } = useGetMessagesQuery(
    { workspaceId: activeWorkspaceId, kind: taskMessageKindsForDeveloperMode(developerMode) },
    { skip: !activeWorkspaceId, refetchOnMountOrArgChange: true },
  )
  const { currentData: summaryRequestTasksResp } = useGetMessagesQuery(
    {
      workspaceId: activeWorkspaceId,
      kind: summaryRequestMessageKindsForDeveloperMode(developerMode),
      contentKind: ['summary_request'],
    },
    { skip: !activeWorkspaceId || !developerMode, refetchOnMountOrArgChange: true },
  )
  const tasks = [...(tasksResp?.items ?? []), ...(summaryRequestTasksResp?.items ?? [])]
    .filter(m => isTaskListMessageForDeveloperMode(m, developerMode))
    .map(m => toUiTask(m, workspaceServerAgents ?? serverAgents ?? [], serverChats ?? [], serverWorkspaces ?? []))
  const tasksListLoading = !!activeWorkspaceId && !tasksResp && (tasksLoading || tasksFetching)
  const [patchMessageMutation] = usePatchMessageMutation()
  const [runMessageMutation] = useRunMessageMutation()
  const [pinLibraryItem] = usePinLibraryItemMutation()
  const [unpinLibraryItem] = useUnpinLibraryItemMutation()

  const doCreateAndPost = useCallback(async (opts: {
    agentId: string
    title: string
    content: string
    attachments?: AttachmentRef[]
    files?: File[]
    kind?: 'task'
    taskTitle?: string
    executeAt?: string
    goal?: string | null
    pinPaths?: string[]
  }): Promise<{ chatId: string; messageId: string }> => {
    if (!activeWorkspaceId) throw new Error('No active workspace')
    const chat = await createChatMutation({
      workspaceId: activeWorkspaceId,
      agentId: opts.agentId,
      title: opts.title,
    }).unwrap()
    // Keep the just-created chat selectable even if the chat-list refetch lags
    // or briefly returns a stale list. Without this local bridge, navigating to
    // the new id can render the current default view until the sidebar cache
    // catches up.
    setLocallyCreatedChats(prev => (
      prev.some(c => c.id === chat.id) ? prev : [toUiChat(chat), ...prev]
    ))
    const msg = await postMessageMutation({
      chatId: chat.id,
      content: opts.content,
      attachments: opts.attachments?.length ? opts.attachments : undefined,
      files: opts.files?.length ? opts.files : undefined,
      kind: opts.kind,
      title: opts.taskTitle,
      executeAt: opts.executeAt,
      goal: opts.goal,
    }).unwrap()
    for (const path of opts.pinPaths ?? []) {
      pinChatLibraryRefMutation({ chatId: chat.id, path }).unwrap().catch(() => {})
    }
    return { chatId: chat.id, messageId: msg.id }
  }, [activeWorkspaceId, createChatMutation, postMessageMutation, pinChatLibraryRefMutation])

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
      artifactParams?: string | null
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
    navigate(getLastWorkspaceUrl(id) ?? buildDefaultViewPath(id, defaultView))
  }, [navigate, dispatch, defaultView])

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

  // Library items picked via "Use in chat" — passed to ChatView as
  // `initialStagedItems` to seed the Files sidebar on the new-chat stub.
  // Held in a ref so two `goTo` calls in the same handler don't cause
  // a stale read on the intermediate render before ChatView mounts.
  const composeStagedItemsRef = useRef<ContextItem[]>([])

  const handleComposeWithContext = useCallback((items?: ContextItem[]) => {
    composeStagedItemsRef.current = items ?? []
    enterCompose()
  }, [enterCompose])

  // Clear the ref when leaving the new-chat stub so a later re-mount
  // of the stub doesn't replay stale picks.
  useEffect(() => {
    if (selectedChatId !== NEW_CHAT_ID) {
      composeStagedItemsRef.current = []
    }
  }, [selectedChatId])

  const handleSidebarChatClick = useCallback((chat: { id: string; unread?: boolean }) => {
    if (chat.unread) {
      markChatReadQuietly(chat.id, dispatch, appStore.getState)
    }
    goTo({ chat: chat.id })
  }, [dispatch, appStore, goTo])

  const handleNewChatFirstMessage = useCallback(async (
    message: string,
    agentId?: string,
    attachments?: AttachmentRef[],
    options?: SendOptions,
    files?: File[],
    pinPaths?: string[],
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
    try {
      const { chatId } = await doCreateAndPost({
        agentId: pickedAgentId,
        title,
        content: message,
        attachments,
        files,
        kind: options?.kind,
        taskTitle: options?.title,
        executeAt: options?.executeAt,
        goal: options && 'goal' in options ? options.goal : undefined,
        pinPaths: pinPaths ?? [],
      })
      goTo({ chat: chatId })
    } catch (err) {
      toast.error('Failed to start chat', { description: extractApiError(err) })
    }
  }, [activeWorkspaceId, workspaceServerAgents, doCreateAndPost, goTo])

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
      const { chatId } = await doCreateAndPost({
        agentId: pickedAgentId,
        title,
        content: buildArtifactPrompt(input),
        attachments: input.attachments?.length ? input.attachments : undefined,
      })
      goTo({ chat: chatId })
    } catch (err) {
      toast.error('Failed to create artifact', { description: err instanceof Error ? err.message : undefined })
    }
  }, [activeWorkspaceId, workspaceServerAgents, serverAgents, doCreateAndPost, goTo])

  // Inbox badge count = server-reported awaiting-user messages.
  // Don't filter by workspace — the inbox is global.
  const { data: awaitingResp } = useGetMessagesQuery({ awaitingUser: true })
  const unreadCount = awaitingResp?.items.length ?? 0

  const {
    currentData: libraryResp,
    isLoading: libraryLoading,
    isUninitialized: libraryUninitialized,
    isFetching: libraryFetching,
  } = useGetLibraryQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId, refetchOnMountOrArgChange: true },
  )
  const libraryItems: ContextItem[] = activeWorkspaceId
    ? (libraryResp?.items ?? []).map((f) => toContextItem(f, activeWorkspaceId, workspaceServerAgents ?? serverAgents ?? []))
    : []
  const pinnedItems = libraryItems.filter(i => i.pinned)
  const artifacts: Artifact[] = (libraryResp?.items ?? []).map((f) => toArtifactFromFile(f))

  // Files already in `/library` are by definition in the user's library —
  // mark them as saved so any inline "Save to Library" affordance is
  // correctly disabled. Newly-promoted chat attachments are marked by the
  // mutation handler in `handleSaveArtifact`.
  useEffect(() => {
    if (!libraryResp?.items) return
    for (const f of libraryResp.items) dispatch(markArtifactSaved(f.path))
  }, [libraryResp, dispatch])

  const isNewChat = selectedChatId === NEW_CHAT_ID
  const selectedChat = (!isNewChat && selectedChatId) ? chats.find(c => c.id === selectedChatId) ?? null : null
  const chatsListLoading = !!activeWorkspaceId && !serverChats && !chatsError
  const chatsListResolving = chatsListLoading || chatsLoading || chatsFetching || chatsUninitialized
  const isResolvingSelectedChat = !!selectedChatId && !isNewChat && !selectedChat && chatsListResolving
  const isLoadingChatSurface = isResolvingSelectedChat || (activeView === 'pinned' && chatsListResolving)

  useEffect(() => {
    if (!selectedChat?.unread) return
    markChatReadQuietly(selectedChat.id, dispatch, appStore.getState)
  }, [selectedChat?.id, selectedChat?.unread, dispatch, appStore])

  const activeChat = isNewChat
    ? { ...NEW_CHAT_STUB, workspaceId: activeWorkspaceId || undefined }
    : selectedChat
  const chatArtifacts = (selectedChat?.artifactIds ?? [])
    .map(id => artifacts.find(a => a.id === id))
    .filter(Boolean) as Artifact[]
  const chatShowNewBadge = !!selectedChat?.unread

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
  const { data: fallbackFile, isFetching: fallbackFileFetching } = useGetLibraryFileQuery(
    { workspaceId: activeWorkspaceId ?? '', path: effectiveItemPath ?? '' },
    { skip: !needsMetaFallback },
  )
  const selectedContextItem: ContextItem | null =
    libraryItem ??
    (needsMetaFallback && fallbackFile && activeWorkspaceId
      ? toContextItem(fallbackFile, activeWorkspaceId, workspaceServerAgents ?? serverAgents ?? [])
      : null)
  const isResolvingSelectedContextItem =
    !!effectiveItemPath &&
    !!activeWorkspaceId &&
    !selectedContextItem &&
    (!libraryResp || libraryLoading || libraryFetching || fallbackFileFetching)


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
        onNavigateWorkspace={handleSelectWorkspace}
        onSelectChat={({ id, workspaceId }) => {
          goTo({ wsId: workspaceId || activeWorkspaceId, chat: id })
        }}
        onSelectFile={({ path, workspaceId }) => {
          goTo({ wsId: workspaceId || activeWorkspaceId, view: 'context', item: path })
        }}
      />
      <Dialog open={notificationPromptOpen} onOpenChange={(open) => {
        if (open) setNotificationPromptOpen(true)
        else dismissNotificationPrompt()
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Enable desktop notifications?</DialogTitle>
            <DialogDescription>
              Desk can show browser notifications for the same new chat messages that get the sidebar unread dot.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={dismissNotificationPrompt}>Not now</Button>
            <Button onClick={() => { void enableDesktopNotifications() }}>Enable notifications</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AppShell
        activeView={activeView}
        chats={chats}
        isChatsLoading={chatsListLoading}
        artifacts={artifacts}
        selectedChatId={selectedChatId}
        onChatClick={handleSidebarChatClick}
        onDeleteChat={handleDeleteChat}
        unreadCount={unreadCount}
        isDetailOpen={!!selectedContextItem}
        onArtifactClick={(artifact) => handleArtifactClick(artifact)}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={handleSelectWorkspace}
        getWorkspaceHref={(id) => getLastWorkspaceUrl(id) ?? buildDefaultViewPath(id, defaultView)}
        onGlobalToday={handleGlobalToday}
        todaySheetOpen={todaySheetOpen}
        onTodaySheetClose={() => dispatch(setTodaySheetOpen(false))}
        onSignOut={() => void logout()}
        onChatWithAgent={handleChatWithAgent}
        pinnedItems={pinnedItems}
        isPinnedLoading={!!activeWorkspaceId && !libraryResp && (libraryLoading || libraryFetching || libraryUninitialized)}
        selectedItemId={effectiveItemPath}
        onPinItem={(itemId) => {
          if (activeWorkspaceId) void pinLibraryItem({ workspaceId: activeWorkspaceId, path: itemId })
        }}
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
            onRenameItem={(newPath) => goTo({ item: newPath })}
            previewParams={selectedArtifactParams}
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
                ? goTo({ wsId: att.workspaceId, view: 'context', item: null, folder: att.path })
                : goTo({
                    wsId: att.workspaceId,
                    view: 'context',
                    item: att.path,
                    artifactParams: att.params ? JSON.stringify(att.params) : null,
                  })
            }
            initialStagedItems={isNewChat ? composeStagedItemsRef.current : undefined}
          />
        )}

        {!selectedContextItem && !activeChat && (isLoadingChatSurface || isResolvingSelectedContextItem) && (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{isLoadingChatSurface ? 'Loading chats…' : 'Loading workspace…'}</span>
            </div>
          </div>
        )}

        {!selectedContextItem && !activeChat && !isResolvingSelectedChat && !chatsListResolving && activeView === 'pinned' && (
          <Navigate to={buildPath(activeWorkspaceId, 'context')} replace />
        )}
        {!selectedContextItem && !activeChat && !isResolvingSelectedChat && activeView === 'tasks' && (
          <TasksPage
            tasks={tasks}
            isLoading={tasksListLoading}
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
                const newMessage = await postMessageMutation({
                  chatId: newChat.id,
                  content: input.description?.trim() ? `${input.name}\n\n${input.description}` : input.name,
                  kind: 'task',
                  title: input.name,
                  executeAt: input.status === 'scheduled' && input.scheduledFor
                    ? input.scheduledFor.toISOString()
                    : undefined,
                  cron: input.cron,
                }).unwrap()
                if (input.status === 'active') {
                  await runMessageMutation({ chatId: newMessage.chatId, messageId: newMessage.id }).unwrap()
                }
              } catch (err) {
                toast.error('Failed to create task', {
                  description: err instanceof Error ? err.message : undefined,
                })
              }
            }}
          />
        )}
        {!selectedContextItem && !activeChat && !isResolvingSelectedChat && activeView === 'context' && !effectiveItemPath && (
          <ContextList
            items={libraryItems}
            isLoading={libraryLoading || libraryUninitialized || !libraryResp || (libraryFetching && libraryItems.length === 0)}
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
