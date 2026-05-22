import { useState } from 'react'
import { Link as RouterLink, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  CalendarClock, CheckCircle2, ExternalLink, Loader2,
  MessagesSquare, Paperclip, Plus, Trash2, Zap,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  DropdownMenuItem,
  cn,
} from '@agent-desk/ui'
import { iconForFile } from '@/data/file-kind'
import { isAppArtifactFile } from '@/store/selectors/artifacts'
import { toUiTask } from '@/store/selectors/tasks'
import { RowKebab } from '@/components/shared/RowKebab'
import { SectionBody, SectionHeader } from '@/components/shared/SectionHeader'
import { SectionEmptyState } from '@/components/shared/SectionEmptyState'
import { StatusBadge } from '@/components/tasks/task-badges'
import { TaskSheet, type TaskCreateInput } from '@/components/tasks/TaskSheet'
import {
  useDeleteMessageMutation,
  useGetAgentsQuery,
  useGetChatQuery,
  useGetChatsQuery,
  useGetMessagesQuery,
  usePatchMessageMutation,
  usePostChatMessageMutation,
  useRunMessageMutation,
} from '@/store/api'
import { buildPath, NEW_CHAT_ID } from '@/router/nav'
import { toUiChat } from '@/store/selectors/chats'
import { useChatHierarchy } from '@/store/selectors/threads'
import type { ServerFile } from '@/store/types'
import type { Chat as UiChat, Task } from '@/data/ui-types'

interface ChatRightPanelProps {
  chatId: string
  workspaceId?: string
  files: ServerFile[]
  /** Double-click: open the file in detail view. */
  onFileClick?: (file: ServerFile) => void
  /** Single-click (or kebab "Use in chat"): stage the file for the next outgoing message. */
  onFileStage?: (file: ServerFile) => void
  /** Kebab "Remove": unlink the entry from the chat's attachments dir. */
  onFileRemove?: (file: ServerFile) => void
}

// Shared appearance for file + task rows in the chat right panel. `h-8`
// matches the left sidebar's row height (shadcn's `SidebarMenuButton`
// defaults to `h-8 text-sm`), so files, tasks, chats, and pinned items
// share one 32 px rhythm.
const ROW_CLASS = 'group/row relative flex h-8 items-center gap-3 px-3 rounded-lg cursor-pointer transition-colors hover:bg-foreground/[0.04]'

export function ChatRightPanel({
  chatId,
  workspaceId,
  files,
  onFileClick,
  onFileStage,
  onFileRemove,
}: ChatRightPanelProps) {
  const [removingFile, setRemovingFile] = useState<ServerFile | null>(null)

  // Resolve thread relationships once for the whole panel: we need
  // both the list of child threads (for the Threads section) and
  // whether *this* chat is itself a thread (so we can hide Threads —
  // threads inside threads aren't supported).
  const { data: serverChats = [] } = useGetChatsQuery(workspaceId ? { workspaceId } : undefined, { skip: !workspaceId })
  const uiChats = serverChats.map(toUiChat)
  const hierarchy = useChatHierarchy(uiChats, workspaceId)
  const isThreadChat = !!hierarchy.parentOf(chatId)
  const childThreads: UiChat[] = isThreadChat
    ? []
    : hierarchy.childrenByParent.get(chatId) ?? []

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto pl-1.5 pr-6">
        {!isThreadChat && (
          <ThreadsSection
            threads={childThreads}
            workspaceId={workspaceId}
            searchQuery=""
          />
        )}
        <FilesSection
          files={files}
          workspaceId={workspaceId}
          hasSearch={false}
          // When Threads is hidden (this chat *is* a thread), Files
          // becomes the first section and claims the larger top-anchor
          // gap normally reserved for Threads.
          isFirst={isThreadChat}
          onFileClick={onFileClick}
          onFileStage={onFileStage}
          onRequestRemove={file => setRemovingFile(file)}
        />
        <TasksSection
          chatId={chatId}
          workspaceId={workspaceId}
        />
      </div>

      <AlertDialog
        open={removingFile !== null}
        onOpenChange={open => { if (!open) setRemovingFile(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove "{removingFile?.label ?? removingFile?.name}" from this chat?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The file's library entry (if any) is unaffected. Direct chat uploads are removed permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removingFile) onFileRemove?.(removingFile)
                setRemovingFile(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Threads ──────────────────────────────────────────────────────────────────

function ThreadsSection({
  threads,
  workspaceId,
  searchQuery,
}: {
  /** Threads anchored in the current chat (already resolved upstream
   *  from the workspace's chat hierarchy). */
  threads: UiChat[]
  workspaceId?: string
  /** Already lower-cased + trimmed by the parent. */
  searchQuery: string
}) {
  const [collapsed, setCollapsed] = useState(false)
  const filtered = searchQuery
    ? threads.filter(t => t.title.toLowerCase().includes(searchQuery))
    : threads
  // Newest thread first — matches the recency sort used elsewhere.
  const sorted = [...filtered].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  return (
    <section>
      <SectionHeader
        label="Threads"
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
        topGap="first"
      />
      <SectionBody collapsed={collapsed}>
        {sorted.length === 0 ? (
          <SectionEmptyState>
            {searchQuery
              ? 'No threads match the search.'
              : 'Threads spawned from this chat appear here.'}
          </SectionEmptyState>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sorted.map(thread => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                workspaceId={workspaceId}
              />
            ))}
          </ul>
        )}
      </SectionBody>
    </section>
  )
}

function ThreadRow({
  thread,
  workspaceId,
}: {
  thread: UiChat
  workspaceId?: string
}) {
  const href = workspaceId
    ? buildPath(workspaceId, 'tasks', { chat: thread.id })
    : undefined
  const body = (
    <>
      <div className="relative shrink-0">
        <MessagesSquare className="h-4 w-4 text-muted-foreground" />
        {/* Same unread dot as the chat sidebar row — keeps the visual
            grammar consistent across surfaces. */}
        {thread.unread && (
          <span className="absolute -top-0.5 -right-0.5 w-1 h-1 rounded-full bg-blue-500" />
        )}
      </div>
      <span className="flex-1 min-w-0 truncate text-sm">{thread.title}</span>
    </>
  )
  if (!href) {
    return (
      <li>
        <div className={ROW_CLASS}>{body}</div>
      </li>
    )
  }
  return (
    <li>
      <div className={ROW_CLASS}>
        <RouterLink to={href} className="flex min-w-0 flex-1 items-center gap-3">
          {body}
        </RouterLink>
      </div>
    </li>
  )
}

// ── Files ────────────────────────────────────────────────────────────────────

function FilesSection({
  files,
  workspaceId,
  isFirst = false,
  onFileClick,
  onFileStage,
  onRequestRemove,
}: {
  files: ServerFile[]
  workspaceId?: string
  hasSearch: boolean
  /** When true, this section is the top of the panel (Threads is
   *  hidden because the chat is itself a thread). Drops the
   *  follow-on `mt-3` and claims the larger first-section top gap. */
  isFirst?: boolean
  onFileClick?: (file: ServerFile) => void
  onFileStage?: (file: ServerFile) => void
  onRequestRemove?: (file: ServerFile) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    // `mt-3` matches the gap `TasksSection` already adds before its
    // own header, so every "follow-on" section in this column has the
    // same vertical rhythm to the one above it. When this section is
    // top-anchored (no Threads above), drop that margin — the
    // SectionHeader's `topGap="first"` provides the 24 px anchor pad.
    <section className={cn(!isFirst && 'mt-3')}>
      <SectionHeader
        label="Files"
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
        topGap={isFirst ? 'first' : 'normal'}
      />
      <SectionBody collapsed={collapsed}>
        {files.length === 0 ? (
          <SectionEmptyState>
            Files shared in this chat appear here.
          </SectionEmptyState>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {files.map(file => (
              <FileRow
                key={file.path}
                file={file}
                workspaceId={workspaceId}
                onFileClick={onFileClick}
                onFileStage={onFileStage}
                onRequestRemove={onRequestRemove}
              />
            ))}
          </ul>
        )}
      </SectionBody>
    </section>
  )
}

function FileRow({
  file,
  workspaceId,
  onFileClick,
  onFileStage,
  onRequestRemove,
}: {
  file: ServerFile
  workspaceId?: string
  onFileClick?: (file: ServerFile) => void
  onFileStage?: (file: ServerFile) => void
  onRequestRemove?: (file: ServerFile) => void
}) {
  const Icon = iconForFile(file.name, file.mime)
  const href = workspaceId && onFileClick
    ? buildPath(workspaceId, 'context', {
        item: isAppArtifactFile(file) ? `${file.path}/desk.app.json` : file.path,
      })
    : undefined

  const body = (
    <>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 min-w-0 truncate text-sm">{file.name}</span>
    </>
  )

  const actions = (
    <RowKebab align="end" contentClassName="w-40" label="File options">
      {onFileStage && (
        <DropdownMenuItem onClick={() => onFileStage(file)}>
          <Paperclip className="h-3.5 w-3.5 mr-2" />
          Use in chat
        </DropdownMenuItem>
      )}
      {onFileClick && (
        href ? (
          <DropdownMenuItem asChild>
            <RouterLink to={href} onClick={() => onFileClick(file)}>
              <ExternalLink className="h-3.5 w-3.5 mr-2" />
              Open
            </RouterLink>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => onFileClick(file)}>
            <ExternalLink className="h-3.5 w-3.5 mr-2" />
            Open
          </DropdownMenuItem>
        )
      )}
      {onRequestRemove && (
        <DropdownMenuItem onClick={() => onRequestRemove(file)}>
          <Trash2 className="h-3.5 w-3.5 mr-2" />
          Remove
        </DropdownMenuItem>
      )}
    </RowKebab>
  )

  if (href) {
    return (
      <li>
        <div className={ROW_CLASS}>
          <RouterLink
            to={href}
            className="flex min-w-0 flex-1 items-center gap-3"
            onClick={e => {
              // Plain click opens the in-chat preview panel (via
              // onFileClick) instead of navigating to the Library
              // detail page. Modifier clicks fall through to the
              // RouterLink so cmd/middle-click can still open the full
              // detail page in a new tab.
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
              e.preventDefault()
              onFileClick?.(file)
            }}
          >
            {body}
          </RouterLink>
          {actions}
        </div>
      </li>
    )
  }
  return (
    <li>
      <div className={ROW_CLASS} onClick={() => onFileClick?.(file)}>
        {body}
        {actions}
      </div>
    </li>
  )
}

// ── Tasks ────────────────────────────────────────────────────────────────────

function TasksSection({
  chatId,
  workspaceId,
}: {
  chatId: string
  workspaceId?: string
}) {
  const navigate = useNavigate()
  const hasRealId = !!chatId && chatId !== NEW_CHAT_ID
  const { data: agents = [] } = useGetAgentsQuery()
  const { data: chat } = useGetChatQuery(chatId, { skip: !hasRealId })
  // Sub-tasks anchored in this chat run inside their own thread chats —
  // and the unread/running flags that drive the "Needs input" pill live
  // on those thread chats, not on `chat`. Pull the workspace chat list
  // so `toUiTask` can look up each task's thread chat by id. Without
  // this, sub-task rows here never light up when the agent posts a
  // reply, even though the Tasks board does.
  const { currentData: workspaceChats } = useGetChatsQuery(
    workspaceId ? { workspaceId } : undefined,
    { skip: !workspaceId },
  )
  const { currentData: tasksResp, isLoading } = useGetMessagesQuery(
    { chatId, kind: ['task'] },
    { skip: !hasRealId, refetchOnMountOrArgChange: true },
  )
  const [patchMessage] = usePatchMessageMutation()
  const [deleteMessage] = useDeleteMessageMutation()
  const [postMessage] = usePostChatMessageMutation()
  const [runMessage] = useRunMessageMutation()
  const [pendingDelete, setPendingDelete] = useState<Task | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  // New-task sheet — pre-fills `chatId` so the created task lands here.
  const [sheetOpen, setSheetOpen] = useState(false)

  // Prefer the workspace chats list (contains thread chats) so
  // `toUiTask` resolves unread/running off the thread chat for
  // sub-tasks. Fall back to just the current chat when the workspace
  // list hasn't loaded yet (or no workspace id) so non-threaded tasks
  // still render correctly.
  const chatsForLookup = workspaceChats ?? (chat ? [chat] : [])
  const tasks: Task[] = (tasksResp?.items ?? []).map(m => toUiTask(m, agents, chatsForLookup))

  const goToTask = (task: Task) => {
    if (workspaceId) navigate(buildPath(workspaceId, 'tasks', { task: task.id }))
  }

  const onMarkAsDone = (task: Task) => {
    if (!task.messageId) return
    void patchMessage({ chatId, messageId: task.messageId, patch: { state: 'cancelled' } })
  }

  const onSchedule = (task: Task) => {
    if (!task.messageId) return
    const executeAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    void patchMessage({ chatId, messageId: task.messageId, patch: { executeAt } })
  }

  const onDelete = (task: Task) => {
    if (!task.messageId) return
    void deleteMessage({ chatId, messageId: task.messageId })
    setPendingDelete(null)
  }

  const onCreateTask = async (input: TaskCreateInput) => {
    if (!hasRealId) return
    try {
      // Task anchor goes into the current chat (kind='task'); the server
      // auto-spawns a thread chat anchored to it so task_runs land in
      // their own thread, not in this chat's history.
      const newMessage = await postMessage({
        chatId,
        content: input.description?.trim()
          ? `${input.name}\n\n${input.description}`
          : input.name,
        kind: 'task',
        title: input.name,
        executeAt: input.status === 'scheduled' && input.scheduledFor
          ? input.scheduledFor.toISOString()
          : undefined,
        cron: input.cron,
      }).unwrap()
      if (input.status === 'active') {
        await runMessage({ chatId: newMessage.chatId, messageId: newMessage.id }).unwrap()
      }
      setSheetOpen(false)
    } catch (err) {
      toast.error('Failed to create task', {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  return (
    <section className="mt-3">
      <SectionHeader
        label="Tasks"
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
        actions={
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            disabled={!hasRealId}
            title="New task"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <Plus className="h-4 w-4" />
            <span className="sr-only">New task</span>
          </button>
        }
      />
      <SectionBody collapsed={collapsed}>
        {!hasRealId ? (
          <SectionEmptyState>
            Tasks created in this chat appear here.
          </SectionEmptyState>
        ) : isLoading && !tasksResp ? (
          <div className="mx-2 rounded-lg border border-dashed border-foreground/10 p-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Loading tasks…</span>
          </div>
        ) : tasks.length === 0 ? (
          <SectionEmptyState>
            Tasks created in this chat appear here.
          </SectionEmptyState>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {tasks.map(task => (
              <TaskRow
                key={task.id}
                task={task}
                onView={() => goToTask(task)}
                onMarkAsDone={() => onMarkAsDone(task)}
                onSchedule={() => onSchedule(task)}
                onRequestDelete={() => setPendingDelete(task)}
              />
            ))}
          </ul>
        )}
      </SectionBody>

      <AlertDialog open={!!pendingDelete} onOpenChange={open => { if (!open) setPendingDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the task from this chat. It can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingDelete && onDelete(pendingDelete)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <TaskSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onCreateTask={onCreateTask}
      />
    </section>
  )
}

function TaskRow({
  task,
  onView,
  onMarkAsDone,
  onSchedule,
  onRequestDelete,
}: {
  task: Task
  onView: () => void
  onMarkAsDone: () => void
  onSchedule: () => void
  onRequestDelete: () => void
}) {
  const isScheduled = task.status === 'scheduled'
  const canMarkDone = task.status !== 'complete'

  return (
    <li>
      <div className={ROW_CLASS} onClick={onView}>
        {/* Same Zap icon + colour token as file-type icons in the Files
            section — keeps the panel visually consistent and pushes the
            "what kind of thing is this" signal into the row metadata
            instead of the icon. The status is communicated by the badge. */}
        <Zap className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 min-w-0 truncate text-sm leading-5">{task.name}</span>
        {/* The badge collapses its width to 0 on row hover so the truncated
            title can expand to show more characters. `max-w-24` is wide
            enough for the longest label ("Scheduled"); animating to
            `max-w-0` gives a smooth squeeze. `flex items-center leading-5`
            keeps the pill centred on the title (an inline wrapper picks
            up the row's line box and rides low). */}
        <span className="flex shrink-0 items-center leading-5 max-w-24 overflow-hidden transition-all duration-200 group-hover/row:max-w-0 group-hover/row:opacity-0">
          <StatusBadge status={task.status} small />
        </span>
        <RowKebab align="end" contentClassName="w-44" label="Task options">
          <DropdownMenuItem onClick={onView}>
            <ExternalLink className="h-3.5 w-3.5 mr-2" />
            View
          </DropdownMenuItem>
          {canMarkDone && (
            <DropdownMenuItem onClick={onMarkAsDone}>
              <CheckCircle2 className="h-3.5 w-3.5 mr-2" />
              Mark as done
            </DropdownMenuItem>
          )}
          {!isScheduled && canMarkDone && (
            <DropdownMenuItem onClick={onSchedule}>
              <CalendarClock className="h-3.5 w-3.5 mr-2" />
              Schedule
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onRequestDelete}>
            <Trash2 className="h-3.5 w-3.5 mr-2" />
            Delete
          </DropdownMenuItem>
        </RowKebab>
      </div>
    </li>
  )
}
