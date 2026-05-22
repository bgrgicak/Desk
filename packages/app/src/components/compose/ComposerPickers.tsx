import { Fragment, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react'
import {
  CalendarClock, ChevronDown, Folder, Paperclip, Search,
  Zap, FileText, ImageIcon, Table, Globe, ListTodo, Target, X,
  type LucideIcon,
} from 'lucide-react'
import {
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@roomy-ai/ui'
import type { GoalKey } from '@roomy-ai/shared'
import { useGetLibraryQuery, useSearchLibraryQuery } from '@/store/api'
import { toContextItem } from '@/store/selectors/library'
import { useListKeyboardNav } from '@/hooks/use-list-keyboard-nav'
import { ITEM_ICON, type ComposerAttachment } from './composer-pickers-utils'
import {
  SchedulePickerForm,
  describeScheduleValue,
  type SchedulePickerValue,
} from '@/components/tasks/SchedulePicker'

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
  { key: 'search',   label: 'Search',   Icon: Search,   placeholder: 'What do you want to find?' },
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
  /** Current schedule selection (`null` = not scheduled). */
  schedule?: SchedulePickerValue | null
  onScheduleChange?: (next: SchedulePickerValue | null) => void
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
    schedule = null,
    onScheduleChange,
  },
  ref,
) {
  // ── Files popover ────────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [filesOpen, setFilesOpen] = useState(false)
  const [filesSearch, setFilesSearch] = useState('')
  const [filesKbActive, setFilesKbActive] = useState(false)
  useEffect(() => { if (!filesOpen) setFilesKbActive(false) }, [filesOpen])

  // Two-mode picker: empty query lists the workspace root; non-empty
  // query hits the server-side recursive search (capped at 200 results).
  // This replaces the previous "fetch every file in the workspace and
  // filter client-side" pattern that turned into a 300+ MB JSON download
  // for home-dir-sized workspaces.
  const trimmedSearch = filesSearch.trim()
  const isSearching = filesOpen && trimmedSearch.length > 0
  const { data: rootResp } = useGetLibraryQuery(
    workspaceId ? { workspaceId } : undefined,
    { skip: !workspaceId || !filesOpen || isSearching },
  )
  const { data: searchResp } = useSearchLibraryQuery(
    workspaceId ? { workspaceId, q: trimmedSearch } : { workspaceId: '', q: '' },
    { skip: !workspaceId || !isSearching },
  )

  const filteredAttachments: ComposerAttachment[] = useMemo(() => {
    if (!workspaceId || !filesOpen) return []
    const resp = isSearching ? searchResp : rootResp
    const folderRefs = resp?.folders ?? []
    const itemRefs = resp?.items ?? []
    return [
      ...folderRefs.map(f => ({ kind: 'folder' as const, id: f.path, name: f.name })),
      ...itemRefs.map(f => {
        const item = toContextItem(f, workspaceId)
        return { kind: 'item' as const, id: item.id, name: item.name, type: item.type }
      }),
    ]
  }, [workspaceId, filesOpen, isSearching, rootResp, searchResp])

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

  // ── Tools popover ────────────────────────────────────────────────────────
  const [toolsOpen, setToolsOpen] = useState(false)
  const activeGoal: Goal = GOALS.find(g => g.key === goalKey) ?? NO_GOAL

  const handlePickGoal = useCallback((key: GoalKey | null) => {
    onGoalChange?.(key)
    setToolsOpen(false)
  }, [onGoalChange])

  // ── Schedule popover ─────────────────────────────────────────────────────
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const scheduleLabel = describeScheduleValue(schedule)
  const isScheduleActive = !!(schedule && (schedule.executeAt || schedule.cron))

  const handleScheduleSave = useCallback((next: SchedulePickerValue | null) => {
    onScheduleChange?.(next)
    setScheduleOpen(false)
  }, [onScheduleChange])

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
          entirely. Uses a modal Dialog (not a Popover) because the
          picker's Once/Recurring Tabs compete with Popover focus
          tracking: switching tabs inside a Popover sometimes dismisses
          the popover before the user can interact. Dialogs keep their
          own focus trap and survive that. */}
      {onScheduleChange && goalKey === 'task' && (
        <>
          <button
            type="button"
            onClick={() => setScheduleOpen(true)}
            className={cn(toolbarBtnClass, isScheduleActive && 'text-foreground')}
            title="Schedule"
            data-testid="composer-schedule-trigger"
          >
            <CalendarClock className="h-3.5 w-3.5" />
            <span className="truncate">{scheduleLabel}</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
          <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
            <DialogContent
              className="sm:max-w-md p-4"
              data-testid="composer-schedule-dialog"
            >
              <DialogTitle className="text-sm font-semibold">
                {isScheduleActive ? 'Edit schedule' : 'Schedule task'}
              </DialogTitle>
              <SchedulePickerForm
                initial={schedule}
                onSave={handleScheduleSave}
                onCancel={() => setScheduleOpen(false)}
              />
            </DialogContent>
          </Dialog>
        </>
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
