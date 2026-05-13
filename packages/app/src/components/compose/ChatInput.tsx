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
import { replaceTextareaRangePreservingUndo } from './textareaUndo'

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

export function buildSendOptions(
  _persistedGoalKey: GoalKey,
  goalOverride: GoalKey | undefined,
  message: string,
): SendOptions | undefined {
  const explicitGoal = goalOverride
  const taskOptions = optionsForGoal(explicitGoal ?? null, message)
  return explicitGoal !== undefined || taskOptions
    ? { ...taskOptions, ...(explicitGoal !== undefined ? { goal: explicitGoal } : {}) }
    : undefined
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
const MAX_TEXT_HISTORY = 200

export type TextSnapshot = {
  value: string
  selectionStart: number
  selectionEnd: number
}

export function didNativeHistoryChangeText(before: TextSnapshot, after: TextSnapshot) {
  return before.value !== after.value
}

export function keyboardHistoryDirection(event: Pick<React.KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'key'>): -1 | 1 | null {
  if (event.key === 'Undo') return -1
  if (event.key === 'Redo') return 1
  if (!event.metaKey && !event.ctrlKey) return null
  const key = event.key.toLowerCase()
  if (key === 'y') return 1
  if (key === 'z') return event.shiftKey ? 1 : -1
  return null
}

export function inputHistoryDirection(inputType: string | undefined): -1 | 1 | null {
  if (inputType === 'historyUndo') return -1
  if (inputType === 'historyRedo') return 1
  return null
}

function textareaSnapshot(el: HTMLTextAreaElement): TextSnapshot {
  return {
    value: el.value,
    selectionStart: el.selectionStart ?? el.value.length,
    selectionEnd: el.selectionEnd ?? el.value.length,
  }
}

function sameTextSnapshot(a: TextSnapshot, b: TextSnapshot) {
  return a.value === b.value && a.selectionStart === b.selectionStart && a.selectionEnd === b.selectionEnd
}

export function shouldPinTextareaScrollToEnd(valueLength: number, selectionEnd: number | null | undefined) {
  return (selectionEnd ?? valueLength) >= valueLength
}

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

  const readStoredDraft = useCallback((key: string | undefined) => (
    key ? localStorage.getItem(DRAFT_STORAGE_PREFIX + key) ?? '' : ''
  ), [])
  const [initialValue] = useState(() => readStoredDraft(draftKey))
  const valueRef = useRef(initialValue)
  const textHistoryRef = useRef<TextSnapshot[]>([{
    value: initialValue,
    selectionStart: initialValue.length,
    selectionEnd: initialValue.length,
  }])
  const textHistoryIndexRef = useRef(0)
  const [hasText, setHasText] = useState(() => initialValue.trim().length > 0)
  const draftKeyRef = useRef(draftKey)
  const [attachedItems, setAttachedItems] = useState<ComposerAttachment[]>([])
  const [previewAgentId, setPreviewAgentId] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pickersRef = useRef<ComposerPickersHandle>(null)
  const [atMentionStart, setAtMentionStart] = useState<number | null>(null)

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return

    const previousScrollTop = el.scrollTop
    const pinScrollToEnd = shouldPinTextareaScrollToEnd(el.value.length, el.selectionEnd)

    // scrollHeight is unreliable inside Radix Sheet portals and flex layouts —
    // the browser inflates it to the container height rather than the text
    // content height. Switching to position:fixed temporarily detaches the
    // element from the surrounding layout context so scrollHeight reflects only
    // the actual text content.
    const w = el.getBoundingClientRect().width || 300
    const saved = {
      position:   el.style.position,
      width:      el.style.width,
      height:     el.style.height,
      visibility: el.style.visibility,
    }

    el.style.position   = 'fixed'
    el.style.width      = `${w}px`
    el.style.height     = '0px'
    el.style.visibility = 'hidden'

    const contentH = el.scrollHeight

    el.style.position   = saved.position
    el.style.width      = saved.width
    el.style.visibility = saved.visibility

    const maxH = compact ? 120 : 200
    const newH = Math.min(contentH, maxH)
    el.style.height     = `${newH}px`
    el.style.overflowY  = newH >= maxH ? 'auto' : 'hidden'

    if (newH >= maxH) {
      // The fixed/hidden measurement pass can reset the textarea's internal
      // scroll position to the top. When the user is composing at the end of a
      // long prompt, keep the visible viewport pinned to the active line rather
      // than leaving them staring at the beginning of the draft.
      el.scrollTop = pinScrollToEnd ? el.scrollHeight : previousScrollTop
    } else {
      el.scrollTop = 0
    }
  }, [compact])

  const syncValue = useCallback((next: string) => {
    valueRef.current = next
    const nextHasText = next.trim().length > 0
    setHasText(prev => prev === nextHasText ? prev : nextHasText)

    // Persist drafts from the native input event path without making the
    // textarea React-controlled. Re-rendering on every keystroke can still
    // interfere with native undo/redo in some browser builds.
    const currentDraftKey = draftKeyRef.current
    if (currentDraftKey) {
      const storageKey = DRAFT_STORAGE_PREFIX + currentDraftKey
      if (next) localStorage.setItem(storageKey, next)
      else localStorage.removeItem(storageKey)
    }
    resizeTextarea()
  }, [resizeTextarea])

  const replaceValue = useCallback((next: string, options?: { focus?: boolean, cursorToEnd?: boolean }) => {
    syncValue(next)
    const el = textareaRef.current
    if (!el) {
      textHistoryRef.current = [{ value: next, selectionStart: next.length, selectionEnd: next.length }]
      textHistoryIndexRef.current = 0
      return
    }
    if (el.value !== next) el.value = next
    if (options?.focus) el.focus()
    if (options?.cursorToEnd) {
      const end = next.length
      el.setSelectionRange(end, end)
    }
    textHistoryRef.current = [textareaSnapshot(el)]
    textHistoryIndexRef.current = 0
    resizeTextarea()
  }, [resizeTextarea, syncValue])

  const recordTextHistory = useCallback((el: HTMLTextAreaElement) => {
    const nextSnapshot = textareaSnapshot(el)
    const history = textHistoryRef.current
    const current = history[textHistoryIndexRef.current]
    if (current && sameTextSnapshot(current, nextSnapshot)) return

    const nextHistory = history.slice(0, textHistoryIndexRef.current + 1)
    nextHistory.push(nextSnapshot)
    if (nextHistory.length > MAX_TEXT_HISTORY) nextHistory.shift()
    textHistoryRef.current = nextHistory
    textHistoryIndexRef.current = nextHistory.length - 1
  }, [])

  const alignTextHistory = useCallback((el: HTMLTextAreaElement, direction?: -1 | 1) => {
    const nextSnapshot = textareaSnapshot(el)
    const history = textHistoryRef.current
    const currentIndex = textHistoryIndexRef.current
    let match = -1
    if (direction === -1) {
      for (let i = currentIndex - 1; i >= 0; i -= 1) {
        if (history[i].value === nextSnapshot.value) { match = i; break }
      }
    } else if (direction === 1) {
      for (let i = currentIndex + 1; i < history.length; i += 1) {
        if (history[i].value === nextSnapshot.value) { match = i; break }
      }
    } else {
      match = history.findLastIndex(snapshot => snapshot.value === nextSnapshot.value)
    }
    if (match >= 0) {
      textHistoryIndexRef.current = match
      textHistoryRef.current[match] = nextSnapshot
    } else {
      recordTextHistory(el)
    }
  }, [recordTextHistory])

  const applyTextHistory = useCallback((direction: -1 | 1) => {
    const el = textareaRef.current
    if (!el) return false
    const history = textHistoryRef.current
    const nextIndex = textHistoryIndexRef.current + direction
    const snapshot = history[nextIndex]
    if (!snapshot) return false
    textHistoryIndexRef.current = nextIndex
    el.value = snapshot.value
    el.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd)
    syncValue(snapshot.value)
    return true
  }, [syncValue])

  useEffect(() => {
    if (draftKeyRef.current === draftKey) return
    draftKeyRef.current = draftKey
    replaceValue(readStoredDraft(draftKey))
    setAtMentionStart(null)
    pickersRef.current?.closeAttach()
  }, [draftKey, readStoredDraft, replaceValue])

  // Register imperative focus handle
  useEffect(() => {
    if (focusRef) focusRef.current = () => textareaRef.current?.focus()
    return () => { if (focusRef) focusRef.current = null }
  }, [focusRef])

  const effectiveAgentId = previewAgentId ?? chatAgentId
  const [goalOverride, setGoalOverride] = useState<GoalKey | undefined>(undefined)
  const persistedGoalKey = goal ?? null
  const effectiveGoalKey: GoalKey = goalOverride !== undefined ? goalOverride : persistedGoalKey
  const activePlaceholder = showGoalPicker
    ? (getGoalPlaceholder(effectiveGoalKey) ?? placeholder)
    : placeholder

  useEffect(() => {
    setGoalOverride(undefined)
  }, [goal])

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
      replaceValue(prefillValue)
      setTimeout(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(prefillValue.length, prefillValue.length)
      }, 0)
    }
  }, [prefillValue, replaceValue])

  useLayoutEffect(() => {
    resizeTextarea()
  }, [resizeTextarea])

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
    syncValue(newVal)

    const historyDirection = inputHistoryDirection((e.nativeEvent as InputEvent | undefined)?.inputType)
    if (historyDirection !== null) {
      alignTextHistory(e.target, historyDirection)
    } else {
      recordTextHistory(e.target)
    }
  }

  const handleBeforeInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const historyDirection = inputHistoryDirection((e.nativeEvent as InputEvent | undefined)?.inputType)
    if (historyDirection === null) return

    // Edit-menu and touch-bar undo/redo often arrive as beforeinput/input
    // history events rather than keydown. Own those too so the composer does
    // not depend on the browser preserving a native undo stack for this
    // uncontrolled-but-imperatively-synced textarea.
    e.preventDefault()
    applyTextHistory(historyDirection)
  }

  const insertMention = useCallback((attachment: ComposerAttachment) => {
    const el = textareaRef.current
    if (!el) return
    setAttachedItems(prev =>
      prev.some(p => p.id === attachment.id) ? prev : [...prev, attachment]
    )
    const currentValue = el.value
    const cursor = el.selectionStart ?? currentValue.length
    if (atMentionStart !== null) {
      replaceTextareaRangePreservingUndo(el, atMentionStart, cursor, '')
    }
    syncValue(el.value)
    recordTextHistory(el)
    setAtMentionStart(null)
    setTimeout(() => el.focus(), 0)
  }, [atMentionStart, recordTextHistory, syncValue])

  const removeAttachedItem = (id: string) => {
    setAttachedItems(prev => prev.filter(p => p.id !== id))
  }

  const handleAgentChange = useCallback((agentId: string) => {
    setPreviewAgentId(agentId)
    onAgentChange?.(agentId)
  }, [onAgentChange])

  const handleSubmit = () => {
    const currentValue = textareaRef.current?.value ?? valueRef.current
    const trimmed = currentValue.trim()
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
    const options = buildSendOptions(persistedGoalKey, goalOverride, trimmed)
    onSend(trimmed, [...extraUploads, ...mentionedFiles], options)
    replaceValue('')
    setAttachedItems([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const historyDirection = keyboardHistoryDirection(e)
    if (historyDirection !== null) {
      // Some embedded/webview builds never update textarea native history for
      // this composer, so relying on the browser first still leaves Cmd/Ctrl+Z
      // inert. Own the common keyboard shortcuts and drive the mirrored text
      // history directly; native menu/touch undo still flows through onChange.
      e.preventDefault()
      applyTextHistory(historyDirection)
      return
    }
    if (e.key === 'Escape') { setAtMentionStart(null); pickersRef.current?.closeAttach() }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
  }

  const canSubmit = (hasText || attachedItems.length > 0 || extraUploads.length > 0) && !disabled

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
        <div className={`flex min-w-0 gap-2 px-3 ${compact ? 'py-2' : 'py-3'}`}>
          <textarea
            ref={textareaRef}
            rows={1}
            defaultValue={initialValue}
            onChange={handleChange}
            onBeforeInput={handleBeforeInput}
            onKeyDown={handleKeyDown}
            placeholder={activePlaceholder}
            disabled={disabled}
            className="min-w-0 flex-1 self-center resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 disabled:opacity-50"
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
      <div className={`flex min-w-0 max-w-full flex-wrap items-center gap-1.5 overflow-hidden ${compact ? 'mt-1.5' : 'mt-2'}`}>

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
