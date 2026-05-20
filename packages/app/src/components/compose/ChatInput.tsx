import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import {
  ArrowRight, Paperclip, X,
} from 'lucide-react'
import { cn } from '@agent-desk/ui'
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
 * Derive the `kind`/`title`/`executeAt`/`goal` fields the `postChatMessage`
 * mutation accepts from the composer's two pieces of state:
 *
 *   - `goalOverride` — what the Tools popover currently shows
 *   - `executeAtOverride` — ISO timestamp picked in the Schedule popover
 *
 * Schedule wins: a picked date implicitly flips the message into a
 * scheduled task regardless of what Tools shows. When no Schedule is set
 * but Tools = `task`, we still send `kind: 'task'` so it lands on the
 * tasks board. Plain goals (`app`, `document`, …) flow as ordinary chat
 * messages with the goal recorded server-side.
 */
export function buildSendOptions(
  _persistedGoalKey: GoalKey,
  goalOverride: GoalKey | undefined,
  message: string,
  executeAtOverride?: string | null,
): SendOptions | undefined {
  const firstLine = message.split('\n')[0].trim()
  const title = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine || undefined

  // A scheduled run is a task with executeAt — and forces the goal to
  // 'scheduled' so the chat list groups it correctly.
  if (executeAtOverride) {
    return { kind: 'task', title, executeAt: executeAtOverride, goal: 'scheduled' }
  }

  if (goalOverride === undefined) return undefined

  if (goalOverride === 'task') {
    return { kind: 'task', title, goal: 'task' }
  }

  return { goal: goalOverride }
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
   * Optional chat context. `workspaceId` scopes the Files picker to
   * that workspace's library. `chatAgentId` is currently accepted for
   * backward compatibility only — the composer no longer surfaces an
   * agent picker. The chat's bound agent stays in the parent.
   */
  chatAgentId?: string
  chatWorkspaceId?: string
  /**
   * Retained on the prop surface for callers that still wire it, but
   * the composer no longer renders an agent picker so the callback is
   * never invoked. Will be removed once consumers are cleaned up.
   * @deprecated The composer no longer surfaces an agent picker.
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
  /** Retained for backward compatibility; the agent picker has been
   * removed from the composer so this is always effectively true.
   * @deprecated */
  hideAgentPicker?: boolean
  /** Skip the library dropdown and open a native file picker on click. */
  directUpload?: boolean
  /** Hide the Schedule button (e.g. surfaces that can't schedule). */
  hideSchedulePicker?: boolean
  /** Drop the container shadow (e.g. inside a card/modal that already
   *  casts its own shadow). */
  flat?: boolean
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

/**
 * Returns true when the element accepts typed text — textareas, text-like
 * inputs, and contenteditable surfaces. Used to decide whether a paste should
 * stay with the focused element or get redirected to the chat composer.
 */
export function isEditableElement(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase()
    return (
      type === 'text'
      || type === 'search'
      || type === 'email'
      || type === 'url'
      || type === 'tel'
      || type === 'password'
      || type === 'number'
      || type === ''
    )
  }
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return false
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
  chatWorkspaceId,
  chatId,
  onAgentChange,
  onOpenUploadPicker,
  extraUploads = [],
  onRemoveExtraUpload,
  uploadInProgress = false,
  draftKey,
  hideAgentPicker = true,
  directUpload = false,
  hideSchedulePicker = false,
  flat = false,
}: ChatInputProps) {
  // These props are part of the public surface (callers pass them for
  // backward compat / upload routing) but the new composer body doesn't
  // read them directly — touch them so eslint's no-unused-vars stays
  // quiet without dropping the props from the API.
  void chatId
  void chatAgentId
  void onAgentChange
  void hideAgentPicker

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

    // Non-compact max derived from the composer card's `max-h-[256px]`
    // minus its chrome (24 + 12 padding = 36, toolbar pt-2 + h-7 = 36).
    // Past this, the textarea scrolls internally instead of pushing the
    // card past its cap.
    const maxH = compact ? 120 : 184
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

  const [goalOverride, setGoalOverride] = useState<GoalKey | undefined>(undefined)
  const [executeAtOverride, setExecuteAtOverride] = useState<string | null>(null)
  const persistedGoalKey = goal ?? null
  /**
   * `userPickedGoal` is what the Tools button shows — the user's
   * explicit selection (or the chat's persisted goal as a fallback).
   * `effectiveGoalKey` is the *implied* goal that drives the placeholder
   * copy and the send wire: a scheduled date flips it to 'scheduled'
   * even though the Tools button still reads "Task". Keeping these
   * separate matters because Schedule only renders when Tools === task;
   * collapsing them would hide the Schedule button as soon as the user
   * picked a date.
   */
  const userPickedGoal: GoalKey = goalOverride !== undefined ? goalOverride : persistedGoalKey
  const effectiveGoalKey: GoalKey = executeAtOverride ? 'scheduled' : userPickedGoal
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

  // Redirect pastes that happen while no editable element is focused (e.g. user
  // clicked into the message list, then hit Cmd+V) into the composer so the
  // content always lands where they can send it from.
  useEffect(() => {
    if (disabled) return
    const onDocumentPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return
      if (isEditableElement(document.activeElement)) return
      const el = textareaRef.current
      if (!el) return
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      e.preventDefault()
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      replaceTextareaRangePreservingUndo(el, start, end, text)
      const caret = start + text.length
      el.setSelectionRange(caret, caret)
      syncValue(el.value)
      recordTextHistory(el)
    }
    document.addEventListener('paste', onDocumentPaste)
    return () => document.removeEventListener('paste', onDocumentPaste)
  }, [disabled, recordTextHistory, syncValue])

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
    const options = buildSendOptions(persistedGoalKey, goalOverride, trimmed, executeAtOverride)
    onSend(trimmed, [...extraUploads, ...mentionedFiles], options)
    replaceValue('')
    setAttachedItems([])
    setExecuteAtOverride(null)
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
      {/* Single rounded card — textarea on top, toolbar at the bottom.
          `flex-col` + the min-height clamp give the card a stable
          footprint; the toolbar gets pushed to the bottom edge via
          `mt-auto` when the textarea hasn't grown to fill the space.
          Internal paddings: 24 px left/right/top, 12 px bottom. */}
      <div className={cn(
        'rounded-2xl border border-foreground/10 bg-background',
        flat ? '' : 'shadow-md',
        'flex flex-col min-h-[160px] max-h-[256px]',
        'pl-6 pr-6 pt-6 pb-3',
      )}>
        {/* Attachment chips — only when items / uploads exist. */}
        {(attachedItems.length > 0 || extraUploads.length > 0) && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {extraUploads.map(upload => (
              <span
                key={upload.id}
                className="inline-flex items-center gap-1 rounded-md bg-foreground/[0.04] text-foreground text-xs font-medium h-6 pl-2 pr-1 max-w-[200px]"
              >
                <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{upload.name}</span>
                {onRemoveExtraUpload && (
                  <button
                    type="button"
                    onClick={() => onRemoveExtraUpload(upload.id)}
                    className="ml-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors"
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
                  className="inline-flex items-center gap-1 rounded-md bg-foreground/[0.04] text-foreground text-xs font-medium h-6 pl-2 pr-1 max-w-[200px]"
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
                    className="ml-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors"
                    aria-label={`Remove ${item.name}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              )
            })}
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          rows={1}
          defaultValue={initialValue}
          onChange={handleChange}
          onBeforeInput={handleBeforeInput}
          onKeyDown={handleKeyDown}
          placeholder={activePlaceholder}
          disabled={disabled}
          className={cn(
            'block w-full min-w-0 resize-none bg-transparent text-sm leading-6 outline-none',
            'placeholder:text-muted-foreground disabled:opacity-50',
          )}
        />

        {/* Toolbar — pickers on the left, send on the right. `mt-auto`
            pins it to the bottom of the card; the negative horizontal
            margin pulls the picker pills and send button so their
            hover backgrounds line up flush with the textarea text. */}
        <div className="mt-auto pt-2 -mx-2 flex items-center justify-between gap-2">
          <ComposerPickers
            ref={pickersRef}
            workspaceId={chatWorkspaceId}
            attachments={attachedItems}
            onAttachmentsChange={setAttachedItems}
            onAttachmentPick={insertMention}
            onOpenUploadPicker={onOpenUploadPicker}
            uploadInProgress={uploadInProgress}
            directUpload={directUpload}
            showGoalPicker={showGoalPicker}
            goalKey={userPickedGoal}
            onGoalChange={(next) => {
              // Stepping away from `task` invalidates any pending
              // Schedule selection — the Schedule button is gated on
              // `goalKey === 'task'`, so leaving an executeAt behind
              // would silently round-trip with the next send.
              setGoalOverride(next)
              if (next !== 'task') setExecuteAtOverride(null)
            }}
            executeAt={hideSchedulePicker ? null : executeAtOverride}
            onExecuteAtChange={hideSchedulePicker ? undefined : setExecuteAtOverride}
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            aria-label="Send message"
            className={cn(
              'shrink-0 flex items-center justify-center h-7 w-7 rounded-md transition-colors',
              canSubmit
                ? 'text-foreground hover:bg-foreground/[0.06]'
                : 'text-muted-foreground/30 cursor-default',
            )}
          >
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
