import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { UploadedFile, SendOptions } from '@/components/compose/ChatInput'
import { ArtifactInlineCard } from '@/components/shared/ArtifactInlineCard'
import { RoomTopBarActions } from '@/components/layout/RoomTopBarActions'
import { ChatRightPanel } from '@/components/chats/ChatRightPanel'
import { ALL_TASK_STATUSES, type TasksFilterValues } from '@/components/chats/TasksFilterPopover'
import { closeArtifact, selectPreviewArtifact, selectPreviewSplitRatio } from '@/store/slices/previewPanelSlice'
import { ChatThread } from '@/components/compose/ChatThread'
import { MessageBubble } from '@/components/compose/MessageBubble'
import { ChatInput } from '@/components/compose/ChatInput'
import type { Chat, Artifact, ContextItem } from '@/data/ui-types'
import {
  useDeleteChatAttachmentMutation,
  useGetAgentsQuery,
  useGetChatArtifactsQuery,
  useGetWorkspacesQuery,
  usePatchChatMutation,
  usePostChatMessageMutation,
} from '@/store/api'
import { useContentAreaInsets } from '@/components/shared/splitPane'
import { isAppArtifactFile } from '@/store/selectors/artifacts'
import { NEW_CHAT_ID } from '@/router/nav'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { setPendingNewChatAgentId } from '@/store/slices/uiSlice'
import { setViewingChat } from '@/store/slices/derivedSlice'
import { markChatReadQuietly } from '@/store/ws/middleware'
import type { AttachmentRef, ServerFile, ServerMessage } from '@/store/types'
import { FileDropZone, type UploadEntry } from '@/components/upload/FileDropZone'
import { usePersistedState } from '@/hooks/use-persisted-state'
import { usePrefs } from '@/hooks/use-prefs'
import { DESKTOP_SIDEBAR_BREAKPOINT, isSmallChatViewport, shouldOpenChatSidebarsByDefault } from './chatViewUtils'

const STARTER_CHIPS = [
  'Draft a project brief',
  'Build an expense tracker',
  'Summarise my notes',
  'Design a color palette',
]

// max-w-4xl (896 px) gives the message column ~33 % more horizontal room than
// the previous max-w-2xl (672 px) cap — comfortably over the 20 % minimum
// the design asked for, and a standard Tailwind size token so it stays in
// the design system.
const CHAT_COLUMN_CLASS = 'w-full max-w-4xl min-w-0 mx-auto'
// The composer is 48 px wider than the message column (still centred)
// so the input card reads as a distinct, slightly broader surface.
const CHAT_COMPOSER_CLASS = 'w-full max-w-[calc(56rem_+_48px)] min-w-0 mx-auto'
// Gutter widths around the centred conversation column. The panel open
// state pushes the chat content, so the outer gutter shrinks from 128 → 80
// px on desktop when the panel is open (mobile keeps a small 16/24 gutter).
const CHAT_GUTTER_CLOSED = 'px-4 sm:px-6 md:px-32'
const CHAT_GUTTER_OPEN   = 'px-4 sm:px-6 md:px-20'
// When the preview panel is open the chat column compresses to ~35 %
// of the viewport, so the previous comfortable gutters become wasted
// space. Hard-pin to a single `px-6` (24 px) on every breakpoint to
// maximise usable width for messages and the composer.
const CHAT_GUTTER_PREVIEW = 'px-6'

function isSmallScreen() {
  return isSmallChatViewport()
}

function useIsSmallScreen() {
  const [smallScreen, setSmallScreen] = useState(isSmallScreen)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const query = window.matchMedia(`(max-width: ${DESKTOP_SIDEBAR_BREAKPOINT - 1}px)`)
    const update = () => setSmallScreen(isSmallScreen())

    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return smallScreen
}

// ── Types ──────────────────────────────────────────────────────────────────────


interface ChatViewProps {
  chat: Chat
  artifacts?: Artifact[]
  onArtifactClick?: (artifact: Artifact) => void
  onDeleteChat?: (chatId: string) => void
  showNewBadge?: boolean
  savedArtifactIds?: Set<string>
  onSaveArtifact?: (artifactId: string) => void
  onDeleteArtifact?: (artifact: Artifact) => void
  onFirstMessage?: (
    message: string,
    agentId?: string,
    attachments?: AttachmentRef[],
    options?: SendOptions,
    files?: File[],
    /** Library paths to pin as chat attachments when the chat is created. */
    pinPaths?: string[],
  ) => void
  highlightMessageId?: string
  onAttachmentClick?: (attachment: AttachmentRef) => void
  /** Library items to show in the Files sidebar for the new-chat stub.
   * They are pinned via library-refs once the first message creates the chat. */
  initialStagedItems?: ContextItem[]
  /** When set, the new-chat stub renders this message as the thread anchor. */
  startThread?: string | null
}

/**
 * "In this chat" panel — user uploads sitting under
 * `.chats/{chatId}/attachments/`. Summary mirrors (`.chats/{id}/notes/`) are
 * Desk-managed memory and are not listed here; summary messages are visible in
 * the chat stream only when developer mode is enabled.
 *
 * Sidebar uploads land in `.chats/{chatId}/attachments/` (not the workspace
 * library) so the file is scoped to this chat. Files queued for the next
 * outgoing message live in the chat input's staging tray, not here.
 */

// ── Main ChatView ──────────────────────────────────────────────────────────────

export function ChatView({
  chat,
  artifacts = [],
  onArtifactClick,
  onDeleteChat,
  showNewBadge = false,
  savedArtifactIds = new Set(),
  onSaveArtifact,
  onFirstMessage,
  highlightMessageId,
  onAttachmentClick,
  initialStagedItems,
  startThread,
}: ChatViewProps) {
  const focusInputRef = useRef<(() => void) | null>(null)
  const location = useLocation()
  const anchorMessage = startThread
    ? (location.state as { anchorMessage?: ServerMessage } | null)?.anchorMessage ?? null
    : null
  const rightPanelOpenKey = chat.id && chat.id !== NEW_CHAT_ID ? `desk.chat.${chat.id}.rightPanelOpen` : null
  const [panelOpen, setPanelOpen] = usePersistedState<boolean>(rightPanelOpenKey, shouldOpenChatSidebarsByDefault())
  const isSmallViewport = useIsSmallScreen()
  const [prefillText, setPrefillText] = useState<string | undefined>(undefined)

  // Search + filter for the right panel (Files + Tasks). Owned here so the
  // chat TopBar's icon-popovers and the panel's list views read from the
  // same source — matches the TasksPage pattern. Scoped per-chat: switching
  // chats remounts ChatView, which resets both.
  const [panelSearchQuery, setPanelSearchQuery] = useState('')
  const [tasksFilter, setTasksFilter] = useState<TasksFilterValues>(ALL_TASK_STATUSES)

  const setPanelOpenFromUser = useCallback((open: boolean) => {
    setPanelOpen(open)
  }, [setPanelOpen])

  // Preview-panel state — when an artifact is open the layout shifts:
  // the left sidebar collapses, the chat right panel is replaced by
  // the PreviewPanel at a fixed 35/65 split (Phase 2b adds resize),
  // and the breadcrumb hides via a Redux flag.
  const previewArtifact = useAppSelector(selectPreviewArtifact)
  const previewSplitRatio = useAppSelector(selectPreviewSplitRatio)
  const isPreviewOpen = previewArtifact !== null

  // Publish the chat-area insets so the global avatar overlay
  // (AppShell, top-bar row) stays centred over the chat column.
  // 290 px = AppShell's hardcoded sidebar width on desktop; on small
  // viewports the sidebar/panel are overlays so insets collapse to 0.
  // Preview-open: sidebar hidden (left 0), preview takes
  // `1 - splitRatio` (right). The overlay doesn't transition
  // horizontally, so these update in place without sliding.
  const chatAreaLeft = isPreviewOpen || isSmallViewport ? '0px' : '290px'
  const chatAreaRight = isPreviewOpen
    ? (isSmallViewport ? '0px' : `${Math.round((1 - previewSplitRatio) * 100)}vw`)
    : isSmallViewport
      ? '0px'
      : panelOpen
        ? '290px'
        : '0px'
  useContentAreaInsets(chatAreaLeft, chatAreaRight)

  const isNewChat = chat.id === NEW_CHAT_ID

  const dispatch = useAppDispatch()

  // The preview panel is scoped to the chat the artifact was opened
  // from: close it on chat switch AND on unmount, so leaving the chat
  // surface entirely (e.g. to a library item) doesn't leave
  // `isPreviewOpen` stuck true in the slice — which would keep the
  // AppShell sidebar hidden after the user navigates back via the
  // breadcrumb.
  useEffect(() => {
    dispatch(closeArtifact())
    return () => { dispatch(closeArtifact()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id])
  const store = useAppStore()
  const [postMessageMutation, postMessageState] = usePostChatMessageMutation()
  const [patchChatMutation] = usePatchChatMutation()

  // Track which chat the user is viewing so the WS middleware can suppress
  // unread-dot flashes for messages arriving in the active chat.
  // useLayoutEffect ensures viewingChatId is set synchronously before the
  // browser paints, closing the window where a WS event could arrive
  // between mount and viewingChatId being set (useEffect fires after
  // paint, leaving a gap where the middleware treats the viewed chat as
  // non-viewed and flashes the unread dot).
  useLayoutEffect(() => {
    if (!isNewChat) {
      dispatch(setViewingChat(chat.id))
      return () => { dispatch(setViewingChat(null)) }
    }
  }, [isNewChat, chat.id, dispatch])

  // Mark the chat as read on the server whenever the user is viewing it
  // and the server-side unread flag is true (initial open or agent reply).
  // Uses markChatReadQuietly (raw PATCH + cache patch) instead of the RTK
  // Query mutation to avoid Chat tag invalidation which races with the
  // unread update and causes a visible dot flash.
  useEffect(() => {
    if (!isNewChat && chat.unread) {
      markChatReadQuietly(chat.id, dispatch, store.getState)
    }
  }, [isNewChat, chat.id, chat.unread, dispatch, store])

  // Pre-creation agent pick for the "new chat" case. Once the chat
  // exists, re-binding flows through PATCH /chats/:id instead. The
  // initial value is seeded from any pending agent id stashed by the
  // artifact-creation sheet's "Skip to chat" path; ChatView is keyed by
  // chat.id, so remounting on navigation refreshes the seed.
  const pendingNewChatAgentId = useAppSelector(s => s.ui.pendingNewChatAgentId)
  const [newChatAgentId, setNewChatAgentId] = useState<string | null>(
    isNewChat ? pendingNewChatAgentId : null,
  )
  useEffect(() => {
    if (isNewChat && pendingNewChatAgentId) {
      dispatch(setPendingNewChatAgentId(null))
    }
  }, [isNewChat, pendingNewChatAgentId, dispatch])

  const handleAgentChange = useCallback(
    (agentId: string) => {
      if (isNewChat) {
        setNewChatAgentId(agentId)
        return
      }
      if (agentId === chat.agentId) return
      patchChatMutation({ id: chat.id, patch: { agentId } })
        .unwrap()
        .catch(err => {
          toast.error('Could not switch agent', {
            description: err instanceof Error ? err.message : undefined,
          })
        })
    },
    [isNewChat, chat.id, chat.agentId, patchChatMutation],
  )

  // Upload ownership lives at ChatView so the entire chat screen (not
  // just the small input strip) can be a drop target. Drops are held in
  // browser memory until the user sends — the file rides on the next
  // outgoing message as a multipart part, so there is no upload-then-
  // attach two-step and no chat-id requirement. New-chat drops work the
  // same way; the file goes out with the first message.
  const hasRealChatId = !isNewChat
  const [pendingFiles, setPendingFiles] = useState<Array<{ id: string; file: File }>>([])
  // Library-mention tray. Refs only (no File body) — these point at
  // workspace-library files the agent should read in place.
  const [stagedFiles, setStagedFiles] = useState<UploadedFile[]>([])
  // Library items to be pinned as chat attachments when the first message
  // creates the chat. Shown in the Files sidebar (not the message input tray).
  const [pendingChatItems, setPendingChatItems] = useState<ContextItem[]>(
    () => initialStagedItems ?? [],
  )

  const handleUpload = useCallback(async (entries: UploadEntry[]) => {
    setPendingFiles(prev => [
      ...prev,
      ...entries.map(({ file }, i) => ({
        id: `pending-${Date.now()}-${i}-${file.name}`,
        file,
      })),
    ])
  }, [])

  const removePendingFile = useCallback((id: string) => {
    setPendingFiles(prev => prev.filter(p => p.id !== id))
  }, [])

  const [deleteChatAttachment] = useDeleteChatAttachmentMutation()

  const removeStaged = useCallback((id: string) => {
    setStagedFiles(prev => prev.filter(s => s.id !== id))
  }, [])

  // Stages a chat-scoped server file (`.chats/{id}/attachments/...` or
  // `.chats/{id}/artifacts/...`). Unlike `addStagedFromLibrary`, no pin is
  // attempted — the file already lives under the chat's directory so
  // there's no library path to symlink in.
  const addStagedChatFile = useCallback((file: ServerFile) => {
    const displayName = file.label ?? file.name
    setStagedFiles(prev =>
      prev.some(s => s.id === file.path)
        ? prev
        : [...prev, { id: file.path, name: displayName, path: file.path, mime: file.mime, size: file.size }],
    )
  }, [])

  // Removes a chat attachment (kebab → "Remove" in the Files panel).
  // Symlinks: only the link in `.chats/{chatId}/attachments/` goes away
  // — the source library file is untouched. Direct uploads are gone for
  // good. Also drops the row from the staging tray if it was queued.
  const removeChatFile = useCallback((file: ServerFile) => {
    if (!hasRealChatId) return
    const name = file.label ?? file.name
    setStagedFiles(prev => prev.filter(s => s.id !== file.path))
    deleteChatAttachment({ chatId: chat.id, name: file.name })
      .unwrap()
      .then(() => {
        toast.success(`Removed "${name}" from chat`)
      })
      .catch(err => {
        const data = (err as { data?: { message?: string } } | undefined)?.data
        const status = (err as { status?: number | string } | undefined)?.status
        const description = data?.message ?? (status !== undefined ? `HTTP ${status}` : undefined)
        toast.error(`Could not remove ${name}`, { description })
      })
  }, [hasRealChatId, chat.id, deleteChatAttachment])

  // Resolve the workspace filesystem path so the anchor-message preview
  // below can rewrite sandbox paths in markdown the same way the main
  // thread does. MessageBubble no longer subscribes on its own.
  const { data: workspacesForBubble } = useGetWorkspacesQuery()
  const workspacePathForAnchor = workspacesForBubble?.find(w => w.id === chat.workspaceId)?.path

  // Files actually parked in `.chats/{chatId}/`: user uploads + agent
  // artifact files/dirs. Uploads drive the Files-tab "In this chat" list;
  // artifact entries drive the Artifacts-tab "Chat files" section. Skipped
  // on the new-chat stub since there's no chat directory yet.
  const { data: chatFilesResp } = useGetChatArtifactsQuery(
    { chatId: hasRealChatId ? chat.id : '', includeArtifacts: true },
    { skip: !hasRealChatId },
  )
  const chatFiles: ServerFile[] = chatFilesResp ?? []
  // Agent artifacts (`.chats/{id}/artifacts/`) surface in the Artifacts panel
  // under a "Chat files" section. The Files panel only shows real attachments.
  // Single list — AI-produced artifacts and user-uploaded attachments are the
  // same kind of thing in the library, so we show them together here too.
  const visibleChatFiles = useMemo(() => {
    if (pendingChatItems.length === 0) return chatFiles
    const pinnedPaths = new Set(chatFiles.map(f => f.path.split('/').pop()))
    const pendingFiles = pendingChatItems
      .filter(item => !pinnedPaths.has(item.name))
      .map(item => ({
        path: item.id,
        name: item.name,
        mime: item.mimeType ?? 'application/octet-stream',
        size: item.size ?? 0,
        createdAt: item.addedAt.toISOString(),
        kind: 'attachment' as const,
      }))
    return [...chatFiles, ...pendingFiles]
  }, [chatFiles, pendingChatItems])

  const { developerMode } = usePrefs()

  // Focus the composer when a chat is opened. Defers past the
  // scroll-to-bottom and message-load layout shifts that follow
  // mount, so focus reliably lands on the textarea.
  useEffect(() => {
    const t = setTimeout(() => focusInputRef.current?.(), 0)
    return () => clearTimeout(t)
  }, [chat.id])

  const { data: agents } = useGetAgentsQuery()
  const agentName =
    agents?.find(a => a.id === chat.agentId)?.name ?? 'Agent'

  // The avatar stack is now a global overlay rendered by AppShell. This
  // view only publishes the chat-area insets (the `--content-area-*`
  // CSS vars set in the effect above) so the global overlay narrows in
  // sync when the Files/Tasks panel or the preview panel is open.
  return (
    <div className="relative flex w-full max-w-full flex-1 min-w-0 min-h-0 overflow-hidden">

      {/* ── Left column: header + messages + input ──
          Dropzone stays enabled even before the first message is
          sent: we still want to capture the drop (preventDefault, no
          browser nav-to-file) and show an explanatory toast via
          handleUpload. Dropping never spills into the workspace
          library — chat drops are always chat-scoped. */}
      <FileDropZone
        onFiles={handleUpload}
        overlayLabel={hasRealChatId ? 'Drop to attach to chat' : 'Drop to attach to your first message'}
        className="flex flex-1 flex-col min-w-0 min-h-0 w-full max-w-full overflow-hidden"
      >
        {({ openPicker }) => (
      <div className="flex flex-1 flex-col min-w-0 min-h-0 w-full max-w-full overflow-hidden">

        {/* Chat actions render into the global TopBar via portal. */}
        <RoomTopBarActions
          chatId={chat.id}
          onDeleteChat={(id) => onDeleteChat?.(id)}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpenFromUser(!panelOpen)}
          showPanelToggle={!isPreviewOpen}
          showPanelControls={!isPreviewOpen && panelOpen}
          searchQuery={panelSearchQuery}
          onSearchChange={setPanelSearchQuery}
          tasksFilter={tasksFilter}
          onTasksFilterChange={setTasksFilter}
        />

        {/* Messages + Input via shared ChatThread */}
        <ChatThread
          chatId={chat.id}
          workspaceId={chat.workspaceId}
          skipQuery={isNewChat}
          agentName={agentName}
          developerMode={developerMode}
          isSending={postMessageState.isLoading}
          highlightMessageId={highlightMessageId}
          innerClassName={`transition-[padding] duration-300 ${isPreviewOpen ? CHAT_GUTTER_PREVIEW : panelOpen ? CHAT_GUTTER_OPEN : CHAT_GUTTER_CLOSED} pt-8 pb-16 space-y-3`}
          messageClassName={message => {
            if (message.content.type !== 'artifactRef') return CHAT_COLUMN_CLASS
            return CHAT_COLUMN_CLASS
          }}
          statusClassName={CHAT_COLUMN_CLASS}
          agentHeaderClassName={CHAT_COLUMN_CLASS}
          lastAssistantSlotClassName="w-full min-w-0"
          onAttachmentClick={onAttachmentClick}
          showNewBadge={showNewBadge}
          emptySlot={
            anchorMessage ? (
              <div className="max-w-2xl min-w-0 mx-auto">
                <MessageBubble
                  message={anchorMessage}
                  workspaceId={anchorMessage.chatId ? chat.workspaceId : undefined}
                  workspacePath={anchorMessage.chatId ? workspacePathForAnchor : undefined}
                />
              </div>
            ) : (
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
                      onClick={() => {
                        if (isNewChat) onFirstMessage?.(chip, newChatAgentId ?? undefined)
                        else void postMessageMutation({ chatId: chat.id, content: chip })
                      }}
                      className="rounded-full border bg-background px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
            )
          }
          lastAssistantSlot={artifacts.length > 0 ? () => (
            <div className="mt-4 flex flex-col gap-2">
              {artifacts.map(artifact => (
                <ArtifactInlineCard
                  key={artifact.id}
                  artifact={artifact}
                  workspaceId={chat.workspaceId}
                  isSaved={savedArtifactIds.has(artifact.id)}
                  onOpen={() => onArtifactClick?.(artifact)}
                  onSave={() => onSaveArtifact?.(artifact.id)}
                />
              ))}
            </div>
          ) : undefined}
          footerSlot={
            <div
              className="shrink-0 min-w-0 max-w-full overflow-hidden"
              style={{ paddingRight: 'var(--chat-thread-scrollbar-width, 0px)' }}
            >
              <div className={`w-full min-w-0 transition-[padding] duration-300 ${isPreviewOpen ? CHAT_GUTTER_PREVIEW : panelOpen ? CHAT_GUTTER_OPEN : CHAT_GUTTER_CLOSED} pt-2 pb-6`}>
                <div className={CHAT_COMPOSER_CLASS}>
                  <ChatInput
                    focusRef={focusInputRef}
                    onSend={(msg, uploads, options) => {
                    // `uploads` carries library-mention refs (path set) plus
                    // pending-file chips (path undefined — the actual File
                    // object lives in `pendingFiles` state below). De-dupe
                    // refs by path so a file staged AND @-mentioned doesn't
                    // appear twice on the wire.
                    const seen = new Set<string>()
                    const attachments: AttachmentRef[] = uploads
                      .filter(u => typeof u.path === 'string')
                      .filter(u => {
                        if (seen.has(u.path!)) return false
                        seen.add(u.path!)
                        return true
                      })
                      .map(u => ({
                        path: u.path!,
                        name: u.name,
                        kind: u.kind,
                        mime: u.mime,
                        size: u.size,
                      }))
                    const files = pendingFiles.map(p => p.file)
                    const pinPaths = pendingChatItems.map(i => i.id)
                    setPendingFiles([])
                    setStagedFiles([])
                    setPendingChatItems([])
                    if (isNewChat) {
                      onFirstMessage?.(
                        msg,
                        newChatAgentId ?? undefined,
                        attachments.length > 0 ? attachments : undefined,
                        options,
                        files.length > 0 ? files : undefined,
                        pinPaths.length > 0 ? pinPaths : undefined,
                      )
                    } else {
                      postMessageMutation({
                        chatId: chat.id,
                        content: msg,
                        attachments: attachments.length > 0 ? attachments : undefined,
                        files: files.length > 0 ? files : undefined,
                        kind: options?.kind,
                        title: options?.title,
                        executeAt: options?.executeAt,
                        goal: options && 'goal' in options ? options.goal : undefined,
                      })
                        .unwrap()
                        .catch(err => {
                          const data = (err as { data?: { message?: string } } | undefined)?.data
                          const status = (err as { status?: number | string } | undefined)?.status
                          const description = data?.message ?? (status !== undefined ? `HTTP ${status}` : undefined)
                          toast.error('Failed to send message', { description })
                        })
                    }
                    setPrefillText(undefined)
                  }}
                    placeholder={isNewChat ? 'Ask anything, start a task, build something…' : 'Continue the conversation...'}
                    compact={true}
                    showGoalPicker={true}
                    goal={chat.goal ?? null}
                    prefillValue={prefillText}
                    chatAgentId={isNewChat ? (newChatAgentId ?? undefined) : chat.agentId}
                    chatWorkspaceId={chat.workspaceId}
                    chatId={chat.id}
                    onAgentChange={handleAgentChange}
                    draftKey={`chat:${chat.id}`}
                    onOpenUploadPicker={openPicker}
                    extraUploads={[
                      ...pendingFiles.map(p => ({
                        id: p.id,
                        name: p.file.name,
                        mime: p.file.type,
                        size: p.file.size,
                      })),
                      ...stagedFiles,
                    ]}
                    onRemoveExtraUpload={(id) => {
                      removePendingFile(id)
                      removeStaged(id)
                    }}
                    uploadInProgress={false}
                  />
                </div>
              </div>
            </div>
          }
        />
      </div>
        )}
      </FileDropZone>

      {/* ── Right column ─────────────────────────────────────────────
          When the preview panel is open, ChatView doesn't render its
          own right column — the `PreviewPanel` mounts at AppShell
          level so it sits side-by-side with (not under) the top bar.
          Otherwise the regular ChatRightPanel (Files + Tasks) mounts
          here. Desktop docks it as a 290 px flex sibling that animates
          its width; small screens slide it in from the right as an
          overlay with a solid background + shadow so the chat input
          underneath stays covered. Mirrors the file-chat overlay in
          `ContextDetail`. */}
      {!isPreviewOpen && (() => {
        const panel = (
          <ChatRightPanel
            chatId={chat.id}
            workspaceId={chat.workspaceId}
            files={visibleChatFiles}
            searchQuery={panelSearchQuery}
            tasksFilter={tasksFilter}
            onFileClick={(file) => {
              if (isAppArtifactFile(file)) {
                onAttachmentClick?.({
                  path: `${file.path}/desk.app.json`,
                  name: file.label ?? file.name,
                  mime: 'application/json',
                  size: file.size,
                })
                return
              }
              onAttachmentClick?.({
                path: file.path,
                name: file.label ?? file.name,
                mime: file.mime,
                size: file.size,
              })
            }}
            onFileStage={addStagedChatFile}
            onFileRemove={hasRealChatId ? removeChatFile : undefined}
          />
        )
        return (
          <AnimatePresence initial={false}>
            {panelOpen && (isSmallViewport ? (
              <motion.div
                key="chat-right-overlay"
                initial={{ opacity: 0, x: '100%' }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: '100%' }}
                transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                className="absolute inset-y-0 right-0 z-40 flex w-full max-w-[290px] flex-col bg-background shadow-xl"
              >
                {panel}
              </motion.div>
            ) : (
              <motion.div
                key="chat-right"
                initial={{ width: 0 }}
                animate={{ width: 290 }}
                exit={{ width: 0 }}
                transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                className="shrink-0 flex flex-col overflow-hidden"
              >
                {panel}
              </motion.div>
            ))}
          </AnimatePresence>
        )
      })()}

    </div>
  )
}
