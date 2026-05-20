import { Fragment, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react'
import { format } from 'date-fns'
import {
  CalendarClock, ChevronDown, Folder, Paperclip, Search,
  Zap, FileText, ImageIcon, Table, Globe, ListTodo, Target, X,
  type LucideIcon,
} from 'lucide-react'
import {
  Calendar,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
  useIsMobile,
} from '@agent-desk/ui'
import type { GoalKey } from '@agent-desk/shared'
import { useGetLibraryQuery } from '@/store/api'
import { toContextItem } from '@/store/selectors/library'
import { useListKeyboardNav } from '@/hooks/use-list-keyboard-nav'
import { ITEM_ICON, type ComposerAttachment } from './composer-pickers-utils'

// ─────────────────────────────────────────────────────────────────────────────
//  Goal catalogue
// ─────────────────────────────────────────────────────────────────────────────

interface Goal {
  /** `null` is the "No goal" reset entry. */
  key: GoalKey | null
  label: string
  Icon: LucideIcon
  placeholder: string
}

/**
 * The full goal list surfaced under the Tools popover. `scheduled` and
 * `run` are deliberately omitted here — Schedule is reached via its
 * dedicated button (only when Task is selected), and the `run` goal
 * isn't surfaced to users in this iteration.
 */
const GOALS: Goal[] = [
  { key: 'app',      label: 'App',      Icon: Zap,      placeholder: 'Describe the app you want to build...' },
  { key: 'document', label: 'Document', Icon: FileText, placeholder: 'What should the document cover?' },
  { key: 'image',    label: 'Image',    Icon: ImageIcon, placeholder: 'Describe the image you want to create...' },
  { key: 'data',     label: 'Data',     Icon: Table,    placeholder: 'What data do you want to track or analyse?' },
  { key: 'site',     label: 'Site',     Icon: Globe,    placeholder: 'Describe the site you want to build...' },
  { key: 'task',     label: 'Task',     Icon: ListTodo, placeholder: 'What needs to be done?' },
]

const NO_GOAL: Goal = {
  key: null,
  label: 'Tools',
  Icon: Target,
  placeholder: 'Ask anything, start a task, build something...',
}

const SCHEDULED_PLACEHOLDER = 'When should I run this, and what should it do?'

export function getGoalPlaceholder(key: GoalKey | null): string | null {
  if (key === 'scheduled') return SCHEDULED_PLACEHOLDER
  return GOALS.find(g => g.key === key)?.placeholder ?? NO_GOAL.placeholder
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface ComposerPickersHandle {
  /** Open the Files popover and seed its search box. Used by ChatInput's @-mention path. */
  openAttach: (search?: string) => void
  /** Close the Files popover without selecting anything. */
  closeAttach: () => void
}

interface ComposerPickersProps {
  workspaceId?: string
  attachments: ComposerAttachment[]
  onAttachmentsChange: (next: ComposerAttachment[]) => void
  /** Called when the user picks a single attachment in the dropdown.
   * Defaults to appending into `attachments`; overriding lets ChatInput
   * also splice its `@…` token out of the textarea. */
  onAttachmentPick?: (attachment: ComposerAttachment) => void
  onOpenUploadPicker?: () => void
  uploadInProgress?: boolean
  className?: string
  /** Skip the library dropdown and open a native file picker on click.
   * Used when the surface has no library to pick from. */
  directUpload?: boolean
  goalKey?: GoalKey | null
  onGoalChange?: (key: GoalKey | null) => void
  showGoalPicker?: boolean
  /** Scheduled execution time as ISO string. `null` = not scheduled. */
  executeAt?: string | null
  onExecuteAtChange?: (next: string | null) => void
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared styles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Toolbar trigger pill used by all three popover buttons. Ghost by
 * default; tints to `text-foreground` when "active" (has a selection).
 * The hover token matches the row hover used across the new Room
 * surfaces (`bg-foreground/[0.04]`).
 */
const toolbarBtnClass = cn(
  'inline-flex items-center gap-1.5 h-7 px-2 rounded-md',
  'text-xs font-medium text-muted-foreground',
  'hover:text-foreground hover:bg-foreground/[0.04] transition-colors',
  'disabled:opacity-50 disabled:pointer-events-none',
)

// ─────────────────────────────────────────────────────────────────────────────

export function isComposerDropdownDismissKey(event: Pick<KeyboardEvent, 'key'>): boolean {
  return event.key === 'Escape'
}

export const ComposerPickers = forwardRef<ComposerPickersHandle, ComposerPickersProps>(function ComposerPickers(
  {
    workspaceId,
    attachments,
    onAttachmentsChange,
    onAttachmentPick,
    onOpenUploadPicker,
    uploadInProgress = false,
    className,
    directUpload = false,
    goalKey = null,
    onGoalChange,
    showGoalPicker = false,
    executeAt = null,
    onExecuteAtChange,
  },
  ref,
) {
  // ── Files popover ────────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [filesOpen, setFilesOpen] = useState(false)
  const [filesSearch, setFilesSearch] = useState('')
  const [filesKbActive, setFilesKbActive] = useState(false)
  useEffect(() => { if (!filesOpen) setFilesKbActive(false) }, [filesOpen])

  // Skip the RTK Query subscription entirely while the popover is closed.
  // Subscribing eagerly meant every library refetch (frequent during
  // artifact streaming after a send) re-rendered ComposerPickers and
  // re-ran `toContextItem` across the entire library — even though the
  // result is only consumed inside the (closed) popover.
  const { data: libraryResp } = useGetLibraryQuery(
    workspaceId ? { workspaceId } : undefined,
    { skip: !workspaceId || !filesOpen },
  )

  const allAttachments: ComposerAttachment[] = useMemo(() => {
    if (!workspaceId || !filesOpen) return []
    const folderRefs = libraryResp?.folders ?? []
    const itemRefs = libraryResp?.items ?? []
    return [
      ...folderRefs.map(f => ({ kind: 'folder' as const, id: f.path, name: f.name })),
      ...itemRefs.map(f => {
        const item = toContextItem(f, workspaceId, [])
        return { kind: 'item' as const, id: item.id, name: item.name, type: item.type }
      }),
    ]
  }, [workspaceId, filesOpen, libraryResp?.folders, libraryResp?.items])

  const filteredAttachments = useMemo(
    () => allAttachments.filter(a => !filesSearch || a.name.toLowerCase().includes(filesSearch.toLowerCase())),
    [allAttachments, filesSearch],
  )

  const handleFilesPicked = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return
    const next: ComposerAttachment[] = Array.from(files).map((f, i) => ({
      id: `upload:${Date.now()}_${i}_${f.name}`,
      name: f.name,
      kind: 'item',
      type: 'file',
    }))
    onAttachmentsChange([...attachments, ...next])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [attachments, onAttachmentsChange])

  const handlePickAttachment = useCallback((attachment: ComposerAttachment) => {
    if (onAttachmentPick) {
      onAttachmentPick(attachment)
    } else if (!attachments.some(p => p.id === attachment.id)) {
      onAttachmentsChange([...attachments, attachment])
    }
    setFilesOpen(false)
    setFilesSearch('')
  }, [attachments, onAttachmentsChange, onAttachmentPick])

  const attachNav = useListKeyboardNav({
    items: filteredAttachments,
    enabled: filesOpen,
    onSelect: handlePickAttachment,
  })

  const handleAttachSearchKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setFilesKbActive(true)
    attachNav.handleKeyDown(e)
  }, [attachNav])

  useImperativeHandle(ref, () => ({
    openAttach(search?: string) {
      setFilesSearch(search ?? '')
      setFilesOpen(true)
    },
    closeAttach() {
      setFilesOpen(false)
      setFilesSearch('')
    },
  }), [])

  // Phone-class viewports turn the Schedule popover into a bottom
  // sheet — the calendar + time row otherwise extend past the
  // viewport edge (or get pinched against the composer's top edge)
  // on iPhone SE-class screens.
  const isMobile = useIsMobile()

  // ── Tools popover ────────────────────────────────────────────────────────
  const [toolsOpen, setToolsOpen] = useState(false)
  const activeGoal: Goal = GOALS.find(g => g.key === goalKey) ?? NO_GOAL

  const handlePickGoal = useCallback((key: GoalKey | null) => {
    onGoalChange?.(key)
    setToolsOpen(false)
  }, [onGoalChange])

  // ── Schedule popover ─────────────────────────────────────────────────────
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const scheduledDate: Date | null = executeAt ? new Date(executeAt) : null
  // Time entry is local-state only — the user can type any HH:mm; on
  // commit we combine it with the picked date and propagate executeAt
  // upward as ISO. Default to 9:00 AM when no date is picked yet.
  const [pendingTime, setPendingTime] = useState<string>(
    scheduledDate ? format(scheduledDate, 'HH:mm') : '09:00',
  )
  useEffect(() => {
    if (scheduledDate) setPendingTime(format(scheduledDate, 'HH:mm'))
  }, [scheduledDate])

  const applyScheduleDate = useCallback((d: Date | undefined) => {
    if (!d) {
      onExecuteAtChange?.(null)
      setScheduleOpen(false)
      return
    }
    const [hh, mm] = pendingTime.split(':').map(n => parseInt(n, 10))
    const next = new Date(d)
    next.setHours(Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0, 0, 0)
    onExecuteAtChange?.(next.toISOString())
    setScheduleOpen(false)
  }, [onExecuteAtChange, pendingTime])

  const clearSchedule = useCallback(() => {
    onExecuteAtChange?.(null)
    setScheduleOpen(false)
  }, [onExecuteAtChange])

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className={cn('flex min-w-0 max-w-full items-center gap-1', className)}>
      {directUpload && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => handleFilesPicked(e.target.files)}
        />
      )}

      {/* Tools (formerly Goal) */}
      {showGoalPicker && (
        <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={toolbarBtnClass}
              title="Pick a tool"
            >
              <activeGoal.Icon className="h-3.5 w-3.5" />
              <span className="truncate">{activeGoal.label}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={6} className="w-56 p-1">
            <p className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Tools
            </p>
            <div className="flex flex-col">
              {GOALS.map(g => (
                <button
                  key={g.key ?? 'no-goal'}
                  type="button"
                  onClick={() => handlePickGoal(g.key)}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-left transition-colors',
                    'hover:bg-foreground/[0.04]',
                    goalKey === g.key && 'bg-foreground/[0.06]',
                  )}
                >
                  <g.Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{g.label}</span>
                </button>
              ))}
              {goalKey !== null && (
                <>
                  <div className="h-px my-1 bg-foreground/[0.06]" />
                  <button
                    type="button"
                    onClick={() => handlePickGoal(null)}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-left text-muted-foreground hover:bg-foreground/[0.04] transition-colors"
                  >
                    <X className="h-3.5 w-3.5 shrink-0" />
                    <span>Clear selection</span>
                  </button>
                </>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {/* Schedule — only relevant when the user has picked the "Task"
          tool. Other goals can't be scheduled, so we hide the button
          entirely instead of leaving an inert control next to Tools.
          On mobile (narrow viewports) the picker renders as a bottom
          sheet — the popover variant gets pinched against the
          composer's top edge and clips the time row. */}
      {onExecuteAtChange && goalKey === 'task' && (
        isMobile ? (
          <Sheet open={scheduleOpen} onOpenChange={setScheduleOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                className={cn(toolbarBtnClass, executeAt && 'text-foreground')}
                title="Schedule"
              >
                <CalendarClock className="h-3.5 w-3.5" />
                <span className="truncate">
                  {scheduledDate ? format(scheduledDate, 'MMM d, h:mm a') : 'Schedule'}
                </span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </SheetTrigger>
            <SheetContent
              side="bottom"
              showCloseButton={false}
              // Cap the sheet height so it never gobbles the whole
              // screen — calendar (~280 px) + time row (~48 px) +
              // padding fits well under 60 % of a 667 px viewport.
              className="max-h-[80dvh] gap-0 overflow-y-auto rounded-t-xl p-3"
            >
              {/* Radix Dialog requires a title for accessible
                  announcement; visually hidden since the calendar UI
                  is self-explanatory. */}
              <SheetTitle className="sr-only">Schedule task</SheetTitle>
              <Calendar
                mode="single"
                selected={scheduledDate ?? undefined}
                onSelect={applyScheduleDate}
                disabled={d => d < new Date(new Date().setHours(0, 0, 0, 0))}
                className="mx-auto"
              />
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-foreground/[0.06] px-1 pt-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Time</span>
                  <input
                    type="time"
                    value={pendingTime}
                    onChange={e => setPendingTime(e.target.value)}
                    className="rounded border border-foreground/10 bg-transparent px-2 py-1 text-xs text-foreground outline-none focus:border-foreground/30"
                  />
                </label>
                {scheduledDate && (
                  <button
                    type="button"
                    onClick={clearSchedule}
                    className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>
            </SheetContent>
          </Sheet>
        ) : (
          <Popover open={scheduleOpen} onOpenChange={setScheduleOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(toolbarBtnClass, executeAt && 'text-foreground')}
                title="Schedule"
              >
                <CalendarClock className="h-3.5 w-3.5" />
                <span className="truncate">
                  {scheduledDate ? format(scheduledDate, 'MMM d, h:mm a') : 'Schedule'}
                </span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={6}
              // Cap to the safe area so the calendar doesn't extend up
              // behind the top bar on short / mobile viewports — the
              // popover scrolls internally past that height.
              className="w-auto max-h-[calc(100dvh-5rem)] overflow-y-auto p-2"
            >
              <Calendar
                mode="single"
                selected={scheduledDate ?? undefined}
                onSelect={applyScheduleDate}
                disabled={d => d < new Date(new Date().setHours(0, 0, 0, 0))}
              />
              <div className="flex items-center justify-between gap-2 px-1 pt-2 border-t border-foreground/[0.06]">
                <label className="text-xs text-muted-foreground flex items-center gap-2">
                  <span>Time</span>
                  <input
                    type="time"
                    value={pendingTime}
                    onChange={e => setPendingTime(e.target.value)}
                    className="bg-transparent border border-foreground/10 rounded px-2 py-1 text-xs text-foreground outline-none focus:border-foreground/30"
                  />
                </label>
                {scheduledDate && (
                  <button
                    type="button"
                    onClick={clearSchedule}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        )
      )}

      {/* Files */}
      <Popover open={!directUpload && filesOpen} onOpenChange={setFilesOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={() => {
              if (directUpload) fileInputRef.current?.click()
            }}
            className={cn(toolbarBtnClass, attachments.length > 0 && 'text-foreground')}
            title="Attach files"
          >
            <Paperclip className="h-3.5 w-3.5" />
            <span className="truncate">
              {attachments.length > 0 ? `Files · ${attachments.length}` : 'Files'}
            </span>
            {!directUpload && <ChevronDown className="h-3 w-3 opacity-60" />}
          </button>
        </PopoverTrigger>
        {!directUpload && (
          <PopoverContent align="start" sideOffset={6} className="w-72 p-0 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-foreground/[0.06]">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                autoFocus
                value={filesSearch}
                onChange={e => setFilesSearch(e.target.value)}
                onKeyDown={handleAttachSearchKey}
                placeholder="Search files and folders…"
                className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground/50"
              />
            </div>
            {onOpenUploadPicker && (
              <div className="border-b border-foreground/[0.06]">
                <button
                  type="button"
                  onClick={() => {
                    setFilesOpen(false)
                    onOpenUploadPicker()
                  }}
                  disabled={uploadInProgress}
                  data-testid="chat-upload-a-file"
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-foreground/[0.04] transition-colors text-left disabled:opacity-50 disabled:pointer-events-none"
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0" />
                  <span>{uploadInProgress ? 'Uploading…' : 'Upload a file…'}</span>
                </button>
              </div>
            )}
            <div className="overflow-y-auto max-h-52">
              {filteredAttachments.length === 0 && (
                <p className="px-3 py-4 text-xs text-muted-foreground text-center">No results</p>
              )}
              {filteredAttachments.map((a, i) => {
                const prev = i > 0 ? filteredAttachments[i - 1] : null
                const showFolderHeading = a.kind === 'folder' && (!prev || prev.kind !== 'folder')
                const showFileHeading = a.kind === 'item' && (!prev || prev.kind !== 'item')
                const Icon = a.kind === 'folder' ? Folder : ITEM_ICON[a.type ?? 'file']
                const isSelected = filesKbActive && attachNav.selectedIndex === i
                return (
                  <Fragment key={a.id}>
                    {showFolderHeading && (
                      <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Folders</p>
                    )}
                    {showFileHeading && (
                      <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Files</p>
                    )}
                    <button
                      type="button"
                      ref={attachNav.itemRef(i)}
                      onClick={() => handlePickAttachment(a)}
                      className={cn(
                        'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left transition-colors',
                        'hover:bg-foreground/[0.04]',
                        isSelected && 'bg-foreground/[0.06]',
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate">{a.name}</span>
                      {attachments.some(it => it.id === a.id) && (
                        <span className="ml-auto shrink-0 h-1.5 w-1.5 rounded-full bg-primary" />
                      )}
                    </button>
                  </Fragment>
                )
              })}
            </div>
          </PopoverContent>
        )}
      </Popover>
    </div>
  )
})
