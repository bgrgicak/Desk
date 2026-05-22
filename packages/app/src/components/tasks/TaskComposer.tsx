import { ChatInput, type UploadedFile, type SendOptions } from '@/components/compose/ChatInput'
import type { AttachmentRef } from '@/store/types'

export interface TaskComposerSubmit {
  /** Raw task description typed by the user. */
  content: string
  /** Short title derived from the first line / first words. */
  title: string
  /** ISO time when the task should first run (Schedule picker). */
  executeAt?: string
  /** Cron expression for recurring tasks (Schedule picker). */
  cron?: string
  /** Library files referenced via the Files picker. */
  attachments: AttachmentRef[]
  /** Raw File objects dropped on the surrounding page or picked via
   *  the composer's attach button — ride along as multipart parts. */
  files: File[]
}

interface TaskComposerProps {
  onSubmit: (input: TaskComposerSubmit) => void
  disabled?: boolean
  /** Focus the textarea on mount — used when we navigate into Tasks
   *  with the intent of immediately composing (e.g. from Home's
   *  empty-section "Create new task" dropdown). */
  autoFocus?: boolean
  /** Files staged via the surrounding page's drop zone (or its attach
   *  picker). Rendered as removable chips in the composer's upload
   *  tray and forwarded out via `onSubmit.files`. */
  pendingFiles?: Array<{ id: string; file: File }>
  /** Remove one staged file from the page-owned buffer. */
  onRemovePendingFile?: (id: string) => void
  /** Open the page-level file picker (hidden input owned by the
   *  surrounding FileDropZone). Wires the composer's attach button to
   *  the same buffer that drops feed. */
  onOpenUploadPicker?: () => void
}

/** First line, capped — used as the chat/task title. */
function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0]?.trim() ?? ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine || 'New task'
}

/**
 * The big task-creation composer at the top of the Tasks view.
 *
 * It's the chat composer pinned to the **Task** kind: no Tools/goal
 * picker (`showGoalPicker={false}` + `goal="task"`), but Schedule and
 * Files stay. ChatInput already provides the card chrome (rounded-2xl
 * border + shadow) matching the Figma. Submitting hands a normalized
 * payload up — the task is created in the idle **To do** state (or
 * **Scheduled** when a Schedule was set), never auto-run.
 */
export function TaskComposer({
  onSubmit,
  disabled,
  autoFocus,
  pendingFiles = [],
  onRemovePendingFile,
  onOpenUploadPicker,
}: TaskComposerProps) {
  const handleSend = (
    message: string,
    uploads: UploadedFile[],
    options?: SendOptions,
  ) => {
    const text = message.trim()
    if (!text) return
    const seen = new Set<string>()
    // Library mentions carry a `path`; dropped/picked raw files don't,
    // so the path filter cleanly partitions the two — library refs go
    // out as `attachments`, raw files as multipart `files`.
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
    onSubmit({
      content: text,
      title: deriveTitle(text),
      executeAt: options?.executeAt,
      cron: options?.cron,
      attachments,
      files: pendingFiles.map(p => p.file),
    })
  }

  return (
    <ChatInput
      goal="task"
      showGoalPicker={false}
      placeholder="What do you want to achieve?"
      draftKey="tasks:new-task"
      disabled={disabled}
      autoFocus={autoFocus}
      onSend={handleSend}
      onOpenUploadPicker={onOpenUploadPicker}
      extraUploads={pendingFiles.map(p => ({
        id: p.id,
        name: p.file.name,
        mime: p.file.type,
        size: p.file.size,
      }))}
      onRemoveExtraUpload={onRemovePendingFile}
    />
  );
}
