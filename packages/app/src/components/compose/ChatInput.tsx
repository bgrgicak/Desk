import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import {
  CornerDownLeft, Paperclip, X,
} from 'lucide-react'
import { type GoalKey as SharedGoalKey } from '@agent-desk/shared'
import {
  ComposerPickers,
  getGoalPlaceholder,
  type ComposerPickersHandle,
} from './ComposerPickers'
import { attachmentChipIcon, type ComposerAttachment } from './composer-pickers-utils'

type GoalKey = SharedGoalKey | null

/**
 * Map a picker selection to the kind/title/executeAt fields the
 * `postChatMessage` mutation accepts. Only `task` and `scheduled` need
 * server-side wiring today — the content-output goals (app, doc, …)
 * still flow as ordinary chat messages.
 */
function optionsForGoal(goal: GoalKey, message: string): SendOptions | undefined {
  if (goal !== 'task' && goal !== 'scheduled') return undefined
  const firstLine = message.split('\n')[0].trim()
  const title = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine || undefined
  if (goal === 'task') return { kind: 'task', title }
  // 'scheduled' default: same time tomorrow. The user can refine via the
  // task detail panel; this matches the default in App.tsx's onTaskCreate
  // when status === 'scheduled' but no scheduledFor was picked.
  return {
    kind: 'task',
    title,
    executeAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }
}


export interface UploadedFile {
  id: string
  name: string
  /** Workspace-relative path on disk; present for chat artifact uploads
   * so the caller can build an AttachmentRef when the message is sent. */
  path?: string
  /** "directory" when the path is a folder; the caller stamps this onto
   * the AttachmentRef so the UI can render a folder icon and route
   * clicks to the folder view. Omitted means "file". */
  kind?: 'file' | 'directory'
  mime?: string
  size?: number
}

/**
 * Optional kind/schedule hints derived from the message-type picker.
 * `kind: 'task'` flips the message into the Tasks listing; `executeAt`
 * (ISO) defers the first run via the at-job scheduler. Both omitted →
 * normal chat message, which is the default.
 */
export interface SendOptions {
  kind?: 'task'
  title?: string
  executeAt?: string
  /** Goal the user explicitly selected in the chat composer. */
  goal?: GoalKey
}

interface ChatInputProps {
  onSend: (message: string, uploads: UploadedFile[], options?: SendOptions) => void
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
  compact?: boolean
  showGoalPicker?: boolean
  /** Persisted chat goal used as the composer's default selection. */
  goal?: GoalKey
  prefillValue?: string   // when set, populates and focuses the textarea
  focusRef?: React.MutableRefObject<(() => void) | null>  // call to imperatively focus the textarea
  /**
   * Optional chat context. When chatAgentId is set the agent picker
   * hydrates from it (one-agent-per-chat contract). workspaceId scopes
   * the attach picker to that workspace's library.
   */
  chatAgentId?: string
  chatWorkspaceId?: string
  /**
   * Fired when the user picks a different agent from the bottom toggle.
   * Parent decides what to do — for an existing chat, patch the chat
   * (re-binds chat.agentId server-side); for a new chat, seed the id
   * into the pending createChat call.
   */
  onAgentChange?: (agentId: string) => void
  /**
   * The parent (typically ChatView) owns the upload flow so the entire
   * chat screen can be a drop target, not just this input strip. When
   * these are set the "Upload a file…" button delegates to
   * onOpenUploadPicker, and any files already uploaded appear as chips
   * alongside library-item mentions.
   */
  chatId?: string
  onOpenUploadPicker?: () => void
  extraUploads?: UploadedFile[]
  onRemoveExtraUpload?: (id: string) => void
  uploadInProgress?: boolean
  /**
   * When set, the typed draft is persisted to localStorage under this key
   * so the text survives navigation and reloads. Cleared on submit.
   */
  draftKey?: string
  /** Hide the agent/model picker entirely. Used by surfaces with a fixed
   * global model (e.g. the global Ask AI palette). */
  hideAgentPicker?: boolean
  /** Skip the library dropdown and open a native file picker on click. */
  directUpload?: boolean
}

const DRAFT_STORAGE_PREFIX = 'chatDraft:'

export function ChatInput({
  onSend,
  disabled = false,
  placeholder = 'Ask anything, start a task, build something...',
  autoFocus = false,
  compact = false,
  showGoalPicker = true,
  goal = null,
  prefillValue,
  focusRef,
  chatAgentId,
  chatWorkspaceId: _chatWorkspaceId,
  chatId,
  onAgentChange,
  onOpenUploadPicker,
  extraUploads = [],
  onRemoveExtraUpload,
  uploadInProgress = false,
  draftKey,
  hideAgentPicker = false,
  directUpload = false,
}: ChatInputProps) {
  // chatId is part of the public prop surface (callers pass it for
  // upload routing) but ChatInput itself doesn't read it — touch it
  // here so eslint's no-unused-vars stays quiet without dropping the
  // prop from the API.
  void chatId

  const [value, setValue] = useState<string>(() =>
    draftKey ? localStorage.getItem(DRAFT_STORAGE_PREFIX + draftKey) ?? '' : ''
  )

  // Persist the draft while typing; remove the entry once empty or submitted.
  useEffect(() => {
    if (!draftKey) return
    const storageKey = DRAFT_STORAGE_PREFIX + draftKey
    if (value) localStorage.setItem(storageKey, value)
    else localStorage.removeItem(storageKey)
  }, [draftKey, value])
  const [attachedItems, setAttachedItems] = useState<ComposerAttachment[]>([])
  const [previewAgentId, setPreviewAgentId] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pickersRef = useRef<ComposerPickersHandle>(null)
  const [atMentionStart, setAtMentionStart] = useState<number | null>(null)

  // Register imperative focus handle
  useEffect(() => {
    if (focusRef) focusRef.current = () => textareaRef.current?.focus()
    return () => { if (focusRef) focusRef.current = null }
  }, [focusRef])

  const effectiveAgentId = previewAgentId ?? chatAgentId
  const [goalOverride, setGoalOverride] = useState<GoalKey | undefined>(undefined)
  const persistedGoalKey = goal ?? null
  const effectiveGoalKey: GoalKey = goalOverride ?? persistedGoalKey
  const activePlaceholder = showGoalPicker
    ? (getGoalPlaceholder(effectiveGoalKey) ?? placeholder)
    : placeholder

  // Auto-focus
  useEffect(() => {
    if (autoFocus && textareaRef.current) textareaRef.current.focus()
  }, [autoFocus])

  // Prefill: set value and focus when prefillValue changes. We can't
  // derive `value` from `prefillValue` because the user must be able to
  // edit it after — so syncing imperatively from an effect is the
  // intended pattern here.
  useEffect(() => {
    if (prefillValue !== undefined && prefillValue !== '') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValue(prefillValue)
      setTimeout(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(prefillValue.length, prefillValue.length)
      }, 0)
    }
  }, [prefillValue])

  // Auto-resize textarea.
  // scrollHeight is unreliable inside Radix Sheet portals and flex layouts —
  // the browser inflates it to the container height rather than the text content height.
  // Switching to position:fixed temporarily detaches the element from the surrounding
  // layout context so scrollHeight reflects only the actual text content.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return

    // Snapshot current width so text wrapping stays identical after the switch
    const w = el.getBoundingClientRect().width || 300

    // Save styles we'll temporarily override
    const saved = {
      position:   el.style.position,
      width:      el.style.width,
      height:     el.style.height,
      visibility: el.style.visibility,
    }

    // Detach from layout to get a clean scrollHeight measurement
    el.style.position   = 'fixed'
    el.style.width      = `${w}px`
    el.style.height     = '0px'
    el.style.visibility = 'hidden'   // prevent any flash (useLayoutEffect is pre-paint anyway)

    const contentH = el.scrollHeight

    // Restore layout position before applying the final height
    el.style.position   = saved.position
    el.style.width      = saved.width
    el.style.visibility = saved.visibility

    const maxH = compact ? 120 : 200
    const newH = Math.min(contentH, maxH)
    el.style.height     = `${newH}px`
    el.style.overflowY  = newH >= maxH ? 'auto' : 'hidden'
  }, [value, compact])

  // Detect @ mention while typing — drives the attach picker open via
  // the ComposerPickers imperative handle.
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value
    const cursor = e.target.selectionStart ?? newVal.length
    const textBefore = newVal.slice(0, cursor)
    const atMatch = textBefore.match(/@([^\s@]*)$/)

    if (atMatch) {
      const start = cursor - atMatch[1].length - 1
      setAtMentionStart(start)
      pickersRef.current?.openAttach(atMatch[1])
    } else if (atMentionStart !== null) {
      setAtMentionStart(null)
      pickersRef.current?.closeAttach()
    }
    setValue(newVal)
  }

  const insertMention = useCallback((attachment: ComposerAttachment) => {
    const el = textareaRef.current
    if (!el) return
    setAttachedItems(prev =>
      prev.some(p => p.id === attachment.id) ? prev : [...prev, attachment]
    )
    const cursor = el.selectionStart ?? value.length
    const newVal = atMentionStart !== null
      ? value.slice(0, atMentionStart) + value.slice(cursor)
      : value
    setValue(newVal)
    setAtMentionStart(null)
    setTimeout(() => el.focus(), 0)
  }, [value, atMentionStart])

  const removeAttachedItem = (id: string) => {
    setAttachedItems(prev => prev.filter(p => p.id !== id))
  }

  const handleAgentChange = useCallback((agentId: string) => {
    setPreviewAgentId(agentId)
    onAgentChange?.(agentId)
  }, [onAgentChange])

  const handleSubmit = () => {
    const trimmed = value.trim()
    if ((!trimmed && attachedItems.length === 0 && extraUploads.length === 0) || disabled) return
    // Library items and folders mentioned via @ or the attach picker have
    // id === workspace-relative path (see toContextItem / toFolderList).
    // Forward both as UploadedFile entries with `path` set so the parent's
    // onSend can build AttachmentRefs — opencode's `--file` flag accepts a
    // directory path and surfaces its contents to the model, so folders ride
    // the same wire as files.
    const mentionedFiles: UploadedFile[] = attachedItems.map(i => ({
      id: i.id,
      name: i.name,
      path: i.id,
      kind: i.kind === 'folder' ? 'directory' : 'file',
    }))
    const taskOptions = optionsForGoal(effectiveGoalKey, trimmed)
    const options: SendOptions | undefined = effectiveGoalKey !== null
      ? { ...taskOptions, goal: effectiveGoalKey }
      : taskOptions
    onSend(trimmed, [...extraUploads, ...mentionedFiles], options)
    setValue('')
    setAttachedItems([])
    if (effectiveGoalKey === null) setGoalOverride(undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setAtMentionStart(null); pickersRef.current?.closeAttach() }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
  }

  const canSubmit = (value.trim().length > 0 || attachedItems.length > 0 || extraUploads.length > 0) && !disabled

  return (
    <div className="w-full">
      {/* Input card */}
      <div className="rounded-lg border bg-background">
        {/* Chips — only when attachments / uploads exist */}
        {(attachedItems.length > 0 || extraUploads.length > 0) && (
          <div className={`flex flex-wrap gap-1.5 px-3 ${compact ? 'pt-2' : 'pt-3'}`}>
            {extraUploads.map(upload => (
              <span
                key={upload.id}
                className="inline-flex items-center gap-1 rounded-md bg-secondary text-secondary-foreground text-xs font-medium h-6 pl-2 pr-1 max-w-[200px]"
              >
                <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{upload.name}</span>
                {onRemoveExtraUpload && (
                  <button
                    type="button"
                    onClick={() => onRemoveExtraUpload(upload.id)}
                    className="ml-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    aria-label={`Remove ${upload.name}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </span>
            ))}
            {attachedItems.map(item => {
              const Icon = attachmentChipIcon(item)
              return (
                <span
                  key={item.id}
                  className="inline-flex items-center gap-1 rounded-md bg-secondary text-secondary-foreground text-xs font-medium h-6 pl-2 pr-1 max-w-[200px]"
                >
                  <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <button
                    type="button"
                    onClick={() => pickersRef.current?.openAttach('')}
                    className="truncate hover:underline decoration-muted-foreground/60"
                  >
                    {item.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAttachedItem(item.id)}
                    className="ml-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    aria-label={`Remove ${item.name}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              )
            })}
          </div>
        )}

        {/* Textarea + submit inline */}
        <div className={`flex gap-2 px-3 ${compact ? 'py-2' : 'py-3'}`}>
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={activePlaceholder}
            disabled={disabled}
            className={`flex-1 self-center resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 disabled:opacity-50`}
          />
          <div className="self-stretch flex flex-col justify-end">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={`shrink-0 flex items-center justify-center h-6 w-6 rounded-md transition-colors ${
                canSubmit ? 'text-foreground hover:bg-muted' : 'text-muted-foreground/30 cursor-default'
              }`}
            >
              <CornerDownLeft className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Pickers row — below the input */}
      <div className={`flex items-center gap-1.5 ${compact ? 'mt-1.5' : 'mt-2'}`}>

        <ComposerPickers
          ref={pickersRef}
          workspaceId={_chatWorkspaceId}
          agentId={effectiveAgentId}
          onAgentChange={handleAgentChange}
          attachments={attachedItems}
          onAttachmentsChange={setAttachedItems}
          onAttachmentPick={insertMention}
          onOpenUploadPicker={onOpenUploadPicker}
          uploadInProgress={uploadInProgress}
          hideAgentPicker={hideAgentPicker}
          directUpload={directUpload}
          showGoalPicker={showGoalPicker}
          goalKey={effectiveGoalKey}
          onGoalChange={setGoalOverride}
        />

      </div>
    </div>
  )
}
