import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { Folder as FolderIcon, Loader2 } from 'lucide-react'
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
import { SignupScreen } from '@/components/auth/SignupScreen'
import { ForcedPasswordChangeScreen } from '@/components/auth/ForcedPasswordChangeScreen'
import { useDispatch } from 'react-redux'
import { wsConnect } from '@/store/ws/middleware'
import { ContextList } from '@/components/context/ContextList'
import { ContextDetail } from '@/components/context/ContextDetail'
import { appAttachmentToPreview } from '@/components/context/AppPreview'
import { TasksRoute } from '@/components/tasks/TasksRoute'
import { HomePage } from '@/components/home/HomePage'
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
  useGetLibraryQuery,
  useGetLibraryFileQuery,
  useGetChatQuery,
  useGetMeQuery,
  useCreateChatMutation,
  useDeleteChatMutation,
  usePinChatLibraryRefMutation,
  useSaveChatAttachmentToLibraryMutation,
  usePostChatMessageMutation,
  usePinLibraryItemMutation,
  useUnpinLibraryItemMutation,
  usePinChatMutation,
  useUnpinChatMutation,
  useCreateThreadMutation,
} from '@/store/api'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import {
  setArtifactTransitionSource,
  setArtifactBackLabel,
  setTodaySheetOpen,
  markArtifactSaved,
  setPendingNewChatAgentId,
  setPendingSettingsSection,
} from '@/store/slices/uiSlice'
import { buildArtifactPrompt } from '@/lib/artifact-prompt'
import { markChatReadQuietly } from '@/store/ws/middleware'
import type { SendOptions } from '@/components/compose/ChatInput'
import { toUiChat } from '@/store/selectors/chats'
import { toContextItem, toFolderList } from '@/store/selectors/library'
import { iconForItem } from '@/data/file-kind'
import { getChatIcon } from '@/data/chat-icons'
import type { PinnedSidebarEntry } from '@/components/layout/RoomSidebar'
import { buildPath, NEW_CHAT_ID, resolveRouteView, type RouteView } from '@/router/nav'
import { getSessionToken, logout } from '@/auth/session'
import { usePrefs } from '@/hooks/use-prefs'
import type { PrefsShape } from '@/components/settings/SettingsModal'
import { getLastWorkspaceUrl, saveLastWorkspaceUrl } from '@/lib/workspace-last-url'
import {
  acceptBrowserNotificationPermissionOffer,
  markBrowserNotificationPermissionOffered,
  shouldOfferBrowserNotificationPermissionOnce,
} from '@/lib/account-notifications'
import { extractApiError } from '@/lib/api-error'

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

function UnauthenticatedRoot() {
  const [view, setView] = useState<'login' | 'signup'>('login')
  return view === 'signup' ? (
    <SignupScreen
      onSignIn={() => setView('login')}
      onComplete={() => window.location.reload()}
    />
  ) : (
    <LoginScreen onSignUp={() => setView('signup')} />
  )
}

export default function App() {
  // No token → render the unauthenticated root at the App root so
  // AppInner's data hooks don't fire 401-storms during the logged-out
  // state.
  if (!getSessionToken()) {
    return (
      <TooltipProvider>
        <Toaster position="bottom-right" />
        <UnauthenticatedRoot />
      </TooltipProvider>
    )
  }
  return (
    <Routes>
      <Route path="/w/:wsId/:view" element={<MustChangeGate><AppInner /></MustChangeGate>} />
      <Route path="*" element={<MustChangeGate><AppBoot /></MustChangeGate>} />
    </Routes>
  )
}

/**
 * Renders the forced-password-change screen while
 * `me.mustChangePassword` is true; otherwise renders children
 * unchanged.  Sits BETWEEN the authenticated-token check and the
 * routed UI, because:
 *
 *  - The server's must-change middleware refuses GET /workspaces in
 *    that state, so AppBoot's `useGetWorkspacesQuery` would 403 and
 *    leave the user on a spinner forever.
 *  - The flag itself comes from GET /me, which the server allows
 *    while gated — we read it before any other data hook fires.
 *  - getMe is invalidated by the change-password mutation, so on
 *    success the flag flips and this gate falls through to the real
 *    UI without a manual reload.
 */
function MustChangeGate({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch()
  const { data: me, isLoading } = useGetMeQuery()
  const wsArmed = me && !me.mustChangePassword

  // Open the WS only after we know the user isn't gated.  Connecting
  // earlier would 403 at the upgrade (the server's
  // enforceMustChangePassword check on /ws), which browsers surface
  // as close code 1006; the WS middleware would then exponentially
  // back off and retry indefinitely while the user sits on the
  // password-change screen.  Once the password is changed, getMe
  // refetches and wsArmed flips true, dispatching wsConnect for the
  // first time.
  useEffect(() => {
    if (wsArmed) dispatch(wsConnect())
  }, [dispatch, wsArmed])

  if (isLoading) {
    return (
      <TooltipProvider>
        <Toaster position="bottom-right" />
        <div className="h-dvh w-full flex items-center justify-center bg-muted/40">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
        </div>
      </TooltipProvider>
    )
  }
  if (me?.mustChangePassword) {
    return <ForcedPasswordChangeScreen />
  }
  return <>{children}</>
}

// Landing route — waits for the workspace list, then shows the Home
// page (room picker). Anything unrecognised also lands here.
function AppBoot() {
  const { data: serverWorkspaces } = useGetWorkspacesQuery()
  const { loaded: prefsLoaded } = usePrefs()
  // Loading state: queries still in flight. Render a centered spinner
  // instead of an empty div — an empty <div className="h-dvh"/> looks
  // identical to a crashed app, and any tab-switch / WS-reconnect that
  // briefly invalidates the cache flashes a full-screen white panel.
  if (!serverWorkspaces || !prefsLoaded) {
    return (
      <TooltipProvider>
        <Toaster position="bottom-right" />
        <div className="h-dvh w-full flex items-center justify-center bg-muted/40">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
        </div>
      </TooltipProvider>
    )
  }
  // Home handles the zero-workspace case itself (empty rooms list +
  // the "Rooms +" create modal), so there's no dead-end state.
  return (
    <TooltipProvider>
      <Toaster position="bottom-right" />
      <HomePage />
    </TooltipProvider>
  )
}

function AppInner() {
  const { wsId = '', view: viewParam } = useParams<{ wsId: string; view: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const dispatch = useAppDispatch()
  const appStore = useAppStore()
  const [notificationPromptOpen, setNotificationPromptOpen] = useState(false)

  // Resolve the URL's `:view` segment to a canonical RouteView. Both
  // the canonical names (`tasks`, `context`, `pinned`) and known
  // aliases (e.g. `library` → `context`) resolve here so deep links
  // and bookmarks survive. Unknown segments fall back to `tasks`.
  const activeView: RouteView = resolveRouteView(viewParam) ?? 'tasks'
  const activeWorkspaceId = wsId

  // `/w/<id>/settings` is a deep link to the Settings modal pre-opened
  // at the workspace section. The view itself behaves as `tasks` (the
  // sidebar's active row matches whichever view is rendered behind the
  // modal), but the modal opens automatically via the shared pending-
  // section channel and the URL replaces to `/tasks` so a back/forward
  // doesn't reopen it.
  useEffect(() => {
    if (viewParam !== 'settings') return
    dispatch(setPendingSettingsSection('workspace'))
    navigate(buildPath(wsId || activeWorkspaceId, 'tasks'), { replace: true })
  }, [viewParam, wsId, activeWorkspaceId, dispatch, navigate])
  const { defaultView } = usePrefs()
  const selectedChatId = searchParams.get('chat')
  const selectedArtifactPath = searchParams.get('artifact')
  const selectedContextPath = searchParams.get('item')
  const selectedMessageId = searchParams.get('message')
  const selectedArtifactParams = parseArtifactParams(searchParams.get('artifactParams'))
  const startThreadParam = searchParams.get('startThread') // chatId:messageId
  const selectedTaskId = searchParams.get('task')

  const artifactTransitionSource = useAppSelector(s => s.ui.artifactTransitionSource)
  const savedArtifactIdList = useAppSelector(s => s.ui.savedArtifactIds)
  const todaySheetOpen = useAppSelector(s => s.ui.todaySheetOpen)

  const savedArtifactIds = useMemo(() => new Set(savedArtifactIdList), [savedArtifactIdList])

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

  // Persisted "last URL per workspace" — written on navigation so the
  // workspace tab can resume on revisit. Debounced + guarded against
  // no-op writes so a noisy in-app navigation flurry (route → modal →
  // back; the profile shows ~6 BrowserRouter commits/sec during heavy
  // use) doesn't pay a localStorage write per step.
  const lastSavedUrlRef = useRef<string>('')
  useEffect(() => {
    if (!activeWorkspaceId) return
    const url = `${location.pathname}${location.search}${location.hash}`
    if (url === lastSavedUrlRef.current) return
    lastSavedUrlRef.current = url
    const handle = window.setTimeout(() => {
      saveLastWorkspaceUrl(activeWorkspaceId, url)
    }, 250)
    return () => window.clearTimeout(handle)
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

  // Use `currentData` for workspace-scoped queries. RTK Query's `data` keeps
  // the previous arg's fulfilled value while the new arg loads, which makes a
  // freshly selected workspace briefly render the old workspace's sidebar and
  // views. `currentData` still uses the cache for this exact workspace when it
  // exists; otherwise the UI shows a loader instead of stale cross-workspace
  // content.
  const {
    currentData: serverChats,
    isLoading: chatsLoading,
    isUninitialized: chatsUninitialized,
    isError: chatsError,
  } = useGetChatsQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    { skip: !activeWorkspaceId, refetchOnMountOrArgChange: true },
  )
  const chats: Chat[] = useMemo(() => (serverChats ?? []).map(toUiChat), [serverChats])
  const selectedChatFromList = useMemo(() => (
    selectedChatId && selectedChatId !== NEW_CHAT_ID
      ? chats.find(c => c.id === selectedChatId) ?? null
      : null
  ), [chats, selectedChatId])
  // Fetch the selected chat independently of the sidebar list. The list can be
  // relatively expensive on large workspaces; a direct chat URL should not wait
  // for sidebar hydration before rendering the conversation surface.
  const shouldFetchSelectedChatById = !!(
    activeWorkspaceId &&
    selectedChatId &&
    selectedChatId !== NEW_CHAT_ID
  )
  const {
    currentData: selectedServerChatById,
    isLoading: selectedChatByIdLoading,
    isFetching: selectedChatByIdFetching,
  } = useGetChatQuery(selectedChatId ?? '', { skip: !shouldFetchSelectedChatById })
  const selectedChatById = selectedServerChatById?.workspaceId === activeWorkspaceId
    ? toUiChat(selectedServerChatById)
    : null
  const [createChatMutation] = useCreateChatMutation()
  const [deleteChatMutation] = useDeleteChatMutation()
  const [postMessageMutation] = usePostChatMessageMutation()
  const [createThreadMutation] = useCreateThreadMutation()
  const [pinChatLibraryRefMutation] = usePinChatLibraryRefMutation()
  const [saveChatAttachmentToLibraryMutation] = useSaveChatAttachmentToLibraryMutation()

  // Tasks queries (4 useGetMessagesQuery calls + derived `tasks` memo)
  // were lifted into TasksRoute so a WS-driven task refresh re-renders
  // only the tasks subtree instead of the entire AppInner shell.
  const [pinLibraryItem] = usePinLibraryItemMutation()
  const [unpinLibraryItem] = useUnpinLibraryItemMutation()
  const [pinChat] = usePinChatMutation()
  const [unpinChat] = useUnpinChatMutation()

  const doCreateAndPost = useCallback(async (opts: {
    agentId: string
    title: string
    content: string
    attachments?: AttachmentRef[]
    files?: File[]
    kind?: 'task'
    taskTitle?: string
    executeAt?: string
    cron?: string
    goal?: string | null
    pinPaths?: string[]
  }): Promise<{ chatId: string; messageId: string }> => {
    if (!activeWorkspaceId) throw new Error('No active workspace')
    const chat = await createChatMutation({
      workspaceId: activeWorkspaceId,
      agentId: opts.agentId,
      title: opts.title,
    }).unwrap()
    const msg = await postMessageMutation({
      chatId: chat.id,
      content: opts.content,
      attachments: opts.attachments?.length ? opts.attachments : undefined,
      files: opts.files?.length ? opts.files : undefined,
      kind: opts.kind,
      title: opts.taskTitle,
      executeAt: opts.executeAt,
      cron: opts.cron,
      goal: opts.goal,
    }).unwrap()
    for (const path of opts.pinPaths ?? []) {
      pinChatLibraryRefMutation({ chatId: chat.id, path }).unwrap().catch(() => {})
    }
    return { chatId: chat.id, messageId: msg.id }
  }, [activeWorkspaceId, createChatMutation, postMessageMutation, pinChatLibraryRefMutation])

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
      task?: string | null
      startThread?: string | null
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

  // Click on the *current* workspace tab is "go home in this workspace" —
  // always lands on the default view. Click on a *different* workspace tab
  // is "switch and resume" — lands on whatever URL that workspace was last
  // viewed at, falling back to its default view on first visit.
  const handleSelectWorkspace = useCallback((id: string) => {
    dispatch(setTodaySheetOpen(false))
    const target = id === activeWorkspaceId
      ? buildDefaultViewPath(id, defaultView)
      : (getLastWorkspaceUrl(id) ?? buildDefaultViewPath(id, defaultView))
    navigate(target)
  }, [activeWorkspaceId, navigate, dispatch, defaultView])

  const handleArtifactClick = useCallback((artifact: Artifact, source?: 'compose' | 'chat', backLabel?: string) => {
    dispatch(setArtifactTransitionSource(source ?? null))
    dispatch(setArtifactBackLabel(backLabel ?? null))
    goTo({ artifact: artifact.id })
  }, [dispatch, goTo])

  // Stable callback fed into ChatView → MessageBubble (memoized).  AppInner
  // re-renders frequently (the profile pinned ~155 commits over an 85 s
  // session); without useCallback every MessageBubble in the visible
  // window would re-render alongside, defeating the memo.
  const handleAttachmentClick = useCallback((att: AttachmentRef) => {
    if (att.kind === 'directory' && !appAttachmentToPreview(att.path)) {
      goTo({ wsId: att.workspaceId, view: 'context', item: null, folder: att.path })
      return
    }
    goTo({
      wsId: att.workspaceId,
      view: 'context',
      item: att.path,
      artifactParams: att.params ? JSON.stringify(att.params) : null,
    })
  }, [goTo])

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
        cron: options?.cron,
        goal: options && 'goal' in options ? options.goal : undefined,
        pinPaths: pinPaths ?? [],
      })
      goTo({ chat: chatId })
    } catch (err) {
      toast.error('Failed to start chat', { description: extractApiError(err) })
    }
  }, [activeWorkspaceId, workspaceServerAgents, doCreateAndPost, goTo])

  const handleStartThreadFirstMessage = useCallback(async (content: string) => {
    if (!startThreadParam) return
    const colonIdx = startThreadParam.indexOf(':')
    if (colonIdx === -1) return
    const sourceChatId = startThreadParam.slice(0, colonIdx)
    const anchorMessageId = startThreadParam.slice(colonIdx + 1)
    try {
      const result = await createThreadMutation({ chatId: sourceChatId, messageId: anchorMessageId, content }).unwrap()
      goTo({ chat: result.chat.id, startThread: null })
    } catch (err) {
      toast.error('Failed to create thread', { description: extractApiError(err) })
    }
  }, [startThreadParam, createThreadMutation, goTo])

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

  // Pinned-sidebar listing. The server returns only entries the user
  // has explicitly pinned (files + folders, anywhere in the tree), so
  // the previous "fetch the whole library and filter for pinned" pattern
  // is gone — that was the call producing 300+ MB JSON on home-dir-sized
  // workspaces.
  const {
    currentData: pinnedResp,
    isLoading: pinnedLoading,
    isUninitialized: pinnedUninitialized,
    isFetching: pinnedFetching,
  } = useGetLibraryQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId, pinned: true } : undefined,
    { skip: !activeWorkspaceId, refetchOnMountOrArgChange: true },
  )
  const pinnedItems: ContextItem[] = useMemo(() => (
    activeWorkspaceId
      ? (pinnedResp?.items ?? []).map((f) => toContextItem(f, activeWorkspaceId))
      : []
  ), [activeWorkspaceId, pinnedResp?.items])
  const pinnedFolders = useMemo(() => (
    activeWorkspaceId
      ? toFolderList(pinnedResp?.folders ?? [], activeWorkspaceId)
      : []
  ), [activeWorkspaceId, pinnedResp?.folders])

  const isNewChat = selectedChatId === NEW_CHAT_ID
  const selectedChat = (!isNewChat && selectedChatId) ? selectedChatFromList ?? selectedChatById : null
  const chatsListLoading = !!activeWorkspaceId && !serverChats && !chatsError
  // `chatsFetching` flips true on every background refetch (WS reconnect,
  // tag invalidation, refetchOnMountOrArgChange). RTK Query keeps the
  // cached data on screen during that window, so flagging it as
  // "resolving" only causes the sidebar/main pane to flash a loader
  // when we already have data — exactly the dev-server tab-switch
  // flicker. Keep this signal scoped to the genuinely-no-data case.
  const chatsListResolving = chatsListLoading || chatsLoading || chatsUninitialized
  const selectedChatByIdResolving = shouldFetchSelectedChatById && (selectedChatByIdLoading || selectedChatByIdFetching)
  const isResolvingSelectedChat = !!selectedChatId && !isNewChat && !selectedChat && selectedChatByIdResolving
  const isLoadingChatSurface = isResolvingSelectedChat || (activeView === 'pinned' && chatsListResolving)

  useEffect(() => {
    if (!selectedChat?.unread) return
    markChatReadQuietly(selectedChat.id, dispatch, appStore.getState)
  }, [selectedChat?.id, selectedChat?.unread, dispatch, appStore])

  const activeChat = isNewChat
    ? { ...NEW_CHAT_STUB, workspaceId: activeWorkspaceId || undefined }
    : selectedChat
  // `chat.artifactIds` is currently a stub (always []) — populated by a
  // server-side slice that doesn't ship yet — so the lookup against the
  // root listing was already returning nothing in practice. Keep the
  // shape so ChatView's contract is preserved; population can move to a
  // chat-scoped query (`useGetChatArtifactsQuery`) when artifact-pinning
  // ships.
  const chatArtifacts: Artifact[] = useMemo(() => [], [])
  const chatShowNewBadge = !!selectedChat?.unread

  // Both `?artifact=<path>` and `?item=<path>` route to the same unified
  // detail view. `?artifact` is kept as a deprecation alias — phase 4 of
  // the Desk → Library consolidation removes it.
  //
  // Selected-item metadata always comes from `getLibraryFile?path=` — the
  // workspace-wide recursive listing that previously short-circuited this
  // lookup is gone, so the per-path query is the only source.
  const effectiveItemPath = selectedContextPath ?? selectedArtifactPath
  const needsMetaFallback = !!effectiveItemPath && !!activeWorkspaceId
  const { currentData: fallbackFile, isFetching: fallbackFileFetching } = useGetLibraryFileQuery(
    { workspaceId: activeWorkspaceId ?? '', path: effectiveItemPath ?? '' },
    { skip: !needsMetaFallback },
  )
  const selectedContextItem: ContextItem | null =
    needsMetaFallback && fallbackFile && activeWorkspaceId
      ? toContextItem(fallbackFile, activeWorkspaceId)
      : null
  const isResolvingSelectedContextItem =
    !!effectiveItemPath &&
    !!activeWorkspaceId &&
    !selectedContextItem &&
    fallbackFileFetching

  // ── Unified sidebar pinned list ─────────────────────────────────────
  // Files, directories, and chats land in one ordered list. Library
  // entries lead (files-before-folders is what the user typically pins
  // first), chats follow. Each entry carries its render-time icon and
  // navigation href so the sidebar doesn't have to know about kinds.
  const pinnedEntries: PinnedSidebarEntry[] = useMemo(() => {
    if (!activeWorkspaceId) return []
    const entries: PinnedSidebarEntry[] = []
    for (const item of pinnedItems) {
      entries.push({
        id: `library:${item.id}`,
        kind: 'library',
        ref: item.id,
        name: item.name,
        icon: iconForItem(item),
        href: buildPath(activeWorkspaceId, 'context', { item: item.id }),
        isActive: item.id === effectiveItemPath,
      })
    }
    for (const folder of pinnedFolders) {
      entries.push({
        id: `folder:${folder.id}`,
        kind: 'folder',
        ref: folder.id,
        name: folder.name,
        icon: FolderIcon,
        // Folders navigate to the Library list scoped to that folder.
        // `?folder=<path>` is the existing in-library navigation param.
        href: buildPath(activeWorkspaceId, 'context', { folder: folder.id }),
        isActive: false,
      })
    }
    for (const chat of chats) {
      if (!chat.pinned) continue
      // Chat icon + status (spinner/red/blue dot) is rendered by the
      // sidebar's shared ChatSidebarRow, which reads runningChatIds /
      // failedChatIds itself. The entry only needs the routing fields.
      entries.push({
        id: `chat:${chat.id}`,
        kind: 'chat',
        ref: chat.id,
        name: chat.title,
        icon: getChatIcon(chat),
        href: buildPath(activeWorkspaceId, activeView, { chat: chat.id }),
        isActive: chat.id === selectedChatId,
      })
    }
    return entries
  }, [activeWorkspaceId, activeView, pinnedItems, pinnedFolders, chats, effectiveItemPath, selectedChatId])



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
        artifacts={[]}
        selectedChatId={selectedChatId}
        onChatClick={handleSidebarChatClick}
        onDeleteChat={handleDeleteChat}
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
        pinnedEntries={pinnedEntries}
        isPinnedLoading={!!activeWorkspaceId && !pinnedResp && (pinnedLoading || pinnedFetching || pinnedUninitialized)}
        selectedItemId={effectiveItemPath}
        libraryFileName={selectedContextItem?.name ?? null}
        onPinItem={(path) => {
          if (activeWorkspaceId) void pinLibraryItem({ workspaceId: activeWorkspaceId, path })
        }}
        onPinChat={(chatId) => {
          if (activeWorkspaceId) void pinChat({ workspaceId: activeWorkspaceId, chatId })
        }}
        onUnpinEntry={(entry) => {
          if (!activeWorkspaceId) return
          // Library files AND directories share one endpoint — they're
          // path-keyed in library_pins. Chats go through chat-pins.
          if (entry.kind === 'chat') {
            void unpinChat({ workspaceId: activeWorkspaceId, chatId: entry.ref })
          } else {
            void unpinLibraryItem({ workspaceId: activeWorkspaceId, path: entry.ref })
          }
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
            isPinned={selectedContextItem.pinned}
            onPin={() => {
              if (activeWorkspaceId) void pinLibraryItem({ workspaceId: activeWorkspaceId, path: selectedContextItem.id })
            }}
            onUnpin={() => {
              if (activeWorkspaceId) void unpinLibraryItem({ workspaceId: activeWorkspaceId, path: selectedContextItem.id })
            }}
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
            onFirstMessage={isNewChat ? (startThreadParam ? handleStartThreadFirstMessage : handleNewChatFirstMessage) : undefined}
            startThread={startThreadParam}
            showNewBadge={!isNewChat && chatShowNewBadge}
            savedArtifactIds={savedArtifactIds}
            onSaveArtifact={handleSaveArtifact}
            highlightMessageId={selectedMessageId ?? undefined}
            onAttachmentClick={handleAttachmentClick}
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
          <TasksRoute
            workspaceId={activeWorkspaceId}
            selectedTaskId={selectedTaskId}
            onSelectTask={(id) => goTo({ task: id })}
          />
        )}
        {!selectedContextItem && !activeChat && !isResolvingSelectedChat && activeView === 'context' && !effectiveItemPath && (
          <ContextList
            onItemClick={(item) => goTo({ item: item.id })}
            onCompose={handleComposeWithContext}
            onPinItem={(item) => {
              if (activeWorkspaceId) void pinLibraryItem({ workspaceId: activeWorkspaceId, path: item.id })
            }}
            onUnpinItem={(item) => {
              if (activeWorkspaceId) void unpinLibraryItem({ workspaceId: activeWorkspaceId, path: item.id })
            }}
            onPinFolder={(folder) => {
              if (activeWorkspaceId) void pinLibraryItem({ workspaceId: activeWorkspaceId, path: folder.id })
            }}
            onUnpinFolder={(folder) => {
              if (activeWorkspaceId) void unpinLibraryItem({ workspaceId: activeWorkspaceId, path: folder.id })
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
