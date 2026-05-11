import { Fragment, useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Bot, ChevronDown, Folder, Paperclip, Search,
  Zap, FileText, ImageIcon, Table, Globe, ListTodo, Target,
  type LucideIcon,
} from 'lucide-react'
import type { GoalKey } from '@agent-desk/shared'
import type { ContextItem } from '@/data/ui-types'
import {
  useGetAgentsQuery,
  useGetLibraryQuery,
  useGetWorkspaceAgentsQuery,
} from '@/store/api'
import { toContextItem, toFolderList } from '@/store/selectors/library'
import { useListKeyboardNav } from '@/hooks/use-list-keyboard-nav'
import { ITEM_ICON, type ComposerAttachment } from './composer-pickers-utils'

interface Goal {
  key: GoalKey | null
  label: string
  Icon: LucideIcon | null
  placeholder: string
}

const GOALS: Goal[] = [
  { key: 'app',       label: 'New app',       Icon: Zap,           placeholder: 'Describe the app you want to build...' },
  { key: 'document',  label: 'New doc',       Icon: FileText,      placeholder: 'What should the document cover?' },
  { key: 'image',     label: 'New image',     Icon: ImageIcon,     placeholder: 'Describe the image you want to create...' },
  { key: 'data',      label: 'New data',      Icon: Table,         placeholder: 'What data do you want to track or analyse?' },
  { key: 'site',      label: 'New site',      Icon: Globe,         placeholder: 'Describe the site you want to build...' },
  { key: 'task',      label: 'New task',      Icon: ListTodo,      placeholder: 'What needs to be done?' },
  { key: null,        label: 'No goal',       Icon: Target,        placeholder: 'Ask anything, start a task, build something...' },
]

export function getGoalPlaceholder(key: GoalKey | null): string | null {
  return GOALS.find(g => g.key === key)?.placeholder ?? null
}

export interface ComposerPickersHandle {
  /** Open the attach dropdown and seed its search box. Used by ChatInput's @ mention path. */
  openAttach: (search?: string) => void
  /** Close the attach dropdown without selecting anything. */
  closeAttach: () => void
}

interface ComposerPickersProps {
  workspaceId?: string
  agentId?: string
  onAgentChange?: (agentId: string) => void
  attachments: ComposerAttachment[]
  onAttachmentsChange: (next: ComposerAttachment[]) => void
  /** Called when the user picks a single attachment in the dropdown.
   * Defaults to appending into `attachments`; overriding lets ChatInput
   * also splice its `@…` token out of the textarea. */
  onAttachmentPick?: (attachment: ComposerAttachment) => void
  onOpenUploadPicker?: () => void
  uploadInProgress?: boolean
  className?: string
  /** Where to mount the floating dropdowns. Defaults to document.body.
   * Pass a node inside a Radix Dialog/Sheet so the dropdowns live within
   * its FocusScope and DismissableLayer (otherwise the trap pulls focus
   * out of the search input). */
  portalContainer?: HTMLElement | null
  /** Hide the agent/model picker entirely. Used by surfaces that don't
   * give users a choice — e.g. the global Ask AI palette, which uses a
   * single global model. */
  hideAgentPicker?: boolean
  /** Skip the library dropdown and open a native file picker on click.
   * Used when the surface has no library to pick from. */
  directUpload?: boolean
  goalKey?: GoalKey | null
  onGoalChange?: (key: GoalKey | null) => void
  showGoalPicker?: boolean
}

function getDropdownStyle(rect: DOMRect, width: number): React.CSSProperties {
  const gap = 6
  const left = Math.min(rect.left, window.innerWidth - width - 8)
  return {
    position: 'fixed',
    bottom: window.innerHeight - rect.top + gap,
    left: Math.max(8, left),
    width,
    zIndex: 9999,
  }
}

const pickerBtnClass =
  'flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors px-2 h-6 text-xs font-medium shrink-0 [&>span]:truncate'
const dropdownClass = 'rounded-lg border bg-background shadow-lg overflow-hidden flex flex-col'

export const ComposerPickers = forwardRef<ComposerPickersHandle, ComposerPickersProps>(function ComposerPickers(
  {
    workspaceId,
    agentId,
    onAgentChange,
    attachments,
    onAttachmentsChange,
    onAttachmentPick,
    onOpenUploadPicker,
    uploadInProgress = false,
    className,
    portalContainer,
    hideAgentPicker = false,
    directUpload = false,
    goalKey = null,
    onGoalChange,
    showGoalPicker = false,
  },
  ref,
) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleDirectUploadClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

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
  const portalTarget = portalContainer ?? (typeof document !== 'undefined' ? document.body : null)
  const { data: globalAgents } = useGetAgentsQuery(undefined, { skip: !!workspaceId })
  const { data: workspaceAgents } = useGetWorkspaceAgentsQuery(workspaceId ?? '', { skip: !workspaceId })
  const serverAgents = workspaceId ? workspaceAgents : globalAgents

  const { data: libraryResp } = useGetLibraryQuery(
    workspaceId ? { workspaceId } : undefined,
    { skip: !workspaceId },
  )
  const folders = workspaceId ? toFolderList(libraryResp?.folders ?? [], workspaceId) : []
  const libraryItems: ContextItem[] = workspaceId
    ? (libraryResp?.items ?? []).map((f) => toContextItem(f, workspaceId, serverAgents ?? []))
    : []

  const activeAgent =
    (agentId ? serverAgents?.find(a => a.id === agentId) : undefined)
    ?? serverAgents?.[0]
    ?? null

  const attachBtnRef = useRef<HTMLButtonElement>(null)
  const agentBtnRef = useRef<HTMLButtonElement>(null)
  const goalBtnRef = useRef<HTMLButtonElement>(null)
  const attachDropRef = useRef<HTMLDivElement>(null)
  const agentDropRef = useRef<HTMLDivElement>(null)
  const goalDropRef = useRef<HTMLDivElement>(null)

  const [attachRect, setAttachRect] = useState<DOMRect | null>(null)
  const [agentRect, setAgentRect] = useState<DOMRect | null>(null)
  const [goalRect, setGoalRect] = useState<DOMRect | null>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [goalOpen, setGoalOpen] = useState(false)
  const [attachSearch, setAttachSearch] = useState('')
  const [agentSearch, setAgentSearch] = useState('')
  // Visual highlight on the keyboard-nav cursor only after the user
  // actually presses an arrow key. Without this, opening the picker by
  // mouse still paints the first row "selected", which reads as a
  // misclick to the user.
  const [attachKbActive, setAttachKbActive] = useState(false)
  const [agentKbActive, setAgentKbActive] = useState(false)
  useEffect(() => { if (!attachOpen) setAttachKbActive(false) }, [attachOpen])
  useEffect(() => { if (!agentOpen) setAgentKbActive(false) }, [agentOpen])

  useImperativeHandle(ref, () => ({
    openAttach(search?: string) {
      setAttachRect(attachBtnRef.current?.getBoundingClientRect() ?? null)
      setAttachSearch(search ?? '')
      setAttachOpen(true)
      setAgentOpen(false)
    },
    closeAttach() {
      setAttachOpen(false)
      setAttachSearch('')
    },
  }), [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        !attachBtnRef.current?.contains(target) &&
        !attachDropRef.current?.contains(target)
      ) {
        setAttachOpen(false)
      }
      if (
        !agentBtnRef.current?.contains(target) &&
        !agentDropRef.current?.contains(target)
      ) {
        setAgentOpen(false)
      }
      if (
        !goalBtnRef.current?.contains(target) &&
        !goalDropRef.current?.contains(target)
      ) {
        setGoalOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const allAttachments: ComposerAttachment[] = [
    ...folders.map(f => ({ kind: 'folder' as const, id: f.id, name: f.name })),
    ...libraryItems.map(i => ({ kind: 'item' as const, id: i.id, name: i.name, type: i.type })),
  ]
  const filteredAttachments = allAttachments.filter(
    a => !attachSearch || a.name.toLowerCase().includes(attachSearch.toLowerCase())
  )
  const filteredAgents = (serverAgents ?? []).filter(
    a => !agentSearch || a.name.toLowerCase().includes(agentSearch.toLowerCase())
      || (a.model?.toLowerCase().includes(agentSearch.toLowerCase()) ?? false)
  )

  const handlePickAttachment = useCallback((attachment: ComposerAttachment) => {
    if (onAttachmentPick) {
      onAttachmentPick(attachment)
    } else if (!attachments.some(p => p.id === attachment.id)) {
      onAttachmentsChange([...attachments, attachment])
    }
    setAttachOpen(false)
    setAttachSearch('')
  }, [attachments, onAttachmentsChange, onAttachmentPick])

  const handleAgentSelect = useCallback((agent: { id: string }) => {
    setAgentOpen(false)
    onAgentChange?.(agent.id)
  }, [onAgentChange])

  const agentNav = useListKeyboardNav({
    items: filteredAgents,
    enabled: agentOpen,
    onSelect: handleAgentSelect,
  })

  const attachNav = useListKeyboardNav({
    items: filteredAttachments,
    enabled: attachOpen,
    onSelect: handlePickAttachment,
  })

  const handleAgentSearchKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setAgentKbActive(true)
    agentNav.handleKeyDown(e)
  }, [agentNav])

  const handleAttachSearchKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setAttachKbActive(true)
    attachNav.handleKeyDown(e)
  }, [attachNav])

  const uploadEnabled = Boolean(onOpenUploadPicker)

  return (
    <div className={`flex min-w-0 max-w-full flex-wrap items-center gap-1.5 overflow-hidden ${className ?? ''}`}>
      {directUpload && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => handleFilesPicked(e.target.files)}
        />
      )}

      {/* Goal picker */}
      {showGoalPicker && (() => {
        const effectiveGoal = GOALS.find(g => g.key === goalKey) ?? GOALS.find(g => g.key === null)!
        return (
          <>
            <button
              type="button"
              ref={goalBtnRef}
              onClick={() => {
                const rect = goalBtnRef.current?.getBoundingClientRect() ?? null
                setGoalRect(rect)
                setGoalOpen(v => !v)
                setAttachOpen(false)
                setAgentOpen(false)
              }}
              className={`${pickerBtnClass} ${goalKey !== null ? 'text-foreground' : ''}`}
            >
              {goalKey !== null && effectiveGoal.Icon
                ? <effectiveGoal.Icon className="h-3 w-3" />
                : <Target className="h-3 w-3" />
              }
              <span>{effectiveGoal.label}</span>
              <ChevronDown className="h-3 w-3" />
            </button>
            {goalOpen && goalRect && createPortal(
              <div ref={goalDropRef} style={getDropdownStyle(goalRect, 208)} className={dropdownClass}>
                <p className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Your goal</p>
                <div className="pb-1.5">
                  {GOALS.map(goal => (
                    <button
                      type="button"
                      key={String(goal.key)}
                      onClick={() => { onGoalChange?.(goal.key); setGoalOpen(false) }}
                      className={`flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left ${goalKey === goal.key ? 'bg-muted/30' : ''}`}
                    >
                      {goal.Icon
                        ? <goal.Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        : <span className="h-3.5 w-3.5 shrink-0" />
                      }
                      <span className="flex-1">{goal.label}</span>
                    </button>
                  ))}
                </div>
              </div>,
              portalTarget ?? document.body,
            )}
          </>
        )
      })()}

      {/* Agent picker — hidden on surfaces with a fixed global model. */}
      {!hideAgentPicker && (
        <>
      <button
        type="button"
        ref={agentBtnRef}
        onClick={() => {
          const rect = agentBtnRef.current?.getBoundingClientRect() ?? null
          setAgentRect(rect)
          setAgentOpen(v => !v)
          setAttachOpen(false)
          setAgentSearch('')
        }}
        className={pickerBtnClass}
      >
        <Bot className="h-3 w-3" />
        <span>{activeAgent?.name ?? 'Agent'}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {agentOpen && agentRect && createPortal(
        <div ref={agentDropRef} data-composer-dropdown="" style={getDropdownStyle(agentRect, 256)} className={dropdownClass}>
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={agentSearch}
              onChange={e => setAgentSearch(e.target.value)}
              onKeyDown={handleAgentSearchKey}
              placeholder="Search agents…"
              className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground/50"
            />
          </div>
          <div className="overflow-y-auto max-h-48">
            {filteredAgents.length === 0 && (
              <p className="px-3 py-4 text-xs text-muted-foreground text-center">No results</p>
            )}
            {filteredAgents.map((agent, i) => {
              const isActive = agentKbActive && agentNav.selectedIndex === i
              return (
                <button
                  type="button"
                  key={agent.id}
                  ref={agentNav.itemRef(i)}
                  onClick={() => handleAgentSelect(agent)}
                  className={`flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left ${isActive ? 'bg-muted/50' : activeAgent?.id === agent.id ? 'bg-muted/30' : ''}`}
                >
                  <span>{agent.name}</span>
                  <span className="text-xs text-muted-foreground ml-2 shrink-0">
                    {agent.model.length > 24 ? agent.model.slice(0, 24) + '…' : agent.model}
                  </span>
                </button>
              )
            })}
          </div>
        </div>,
        portalTarget ?? document.body,
      )}
        </>
      )}

      {/* Attachment picker */}
      <button
        type="button"
        ref={attachBtnRef}
        onClick={() => {
          if (directUpload) { handleDirectUploadClick(); return }
          const rect = attachBtnRef.current?.getBoundingClientRect() ?? null
          setAttachRect(rect)
          setAttachOpen(v => !v)
          setAgentOpen(false)
          setAttachSearch('')
        }}
        className={pickerBtnClass}
      >
        <Paperclip className="h-3 w-3" />
        <span>{directUpload ? 'Attach file' : 'Add files'}</span>
        {!directUpload && <ChevronDown className="h-3 w-3" />}
      </button>
      {!directUpload && attachOpen && attachRect && createPortal(
        <div ref={attachDropRef} data-composer-dropdown="" style={getDropdownStyle(attachRect, 288)} className={dropdownClass}>
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              autoFocus
              value={attachSearch}
              onChange={e => setAttachSearch(e.target.value)}
              onKeyDown={handleAttachSearchKey}
              placeholder="Search files and folders…"
              className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground/50"
            />
          </div>
          <div className="border-b">
            <button
              type="button"
              onClick={() => {
                setAttachOpen(false)
                onOpenUploadPicker?.()
              }}
              disabled={!uploadEnabled || uploadInProgress}
              data-testid="chat-upload-a-file"
              className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left text-muted-foreground disabled:opacity-50 disabled:pointer-events-none"
            >
              <Paperclip className="h-3.5 w-3.5 shrink-0" />
              <span>{uploadInProgress ? 'Uploading…' : 'Upload a file…'}</span>
            </button>
          </div>
          <div className="overflow-y-auto max-h-52">
            {filteredAttachments.length === 0 && (
              <p className="px-3 py-4 text-xs text-muted-foreground text-center">No results</p>
            )}
            {filteredAttachments.map((a, i) => {
              const prev = i > 0 ? filteredAttachments[i - 1] : null
              const showFolderHeading = a.kind === 'folder' && (!prev || prev.kind !== 'folder')
              const showFileHeading = a.kind === 'item' && (!prev || prev.kind !== 'item')
              const Icon = a.kind === 'folder' ? Folder : ITEM_ICON[a.type ?? 'file']
              const isSelected = attachKbActive && attachNav.selectedIndex === i
              return (
                <Fragment key={a.id}>
                  {showFolderHeading && (
                    <p className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Folders</p>
                  )}
                  {showFileHeading && (
                    <p className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Files</p>
                  )}
                  <button
                    type="button"
                    ref={attachNav.itemRef(i)}
                    onClick={() => handlePickAttachment(a)}
                    className={`flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left ${isSelected ? 'bg-muted/50' : ''}`}
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
        </div>,
        portalTarget ?? document.body,
      )}
    </div>
  )
})
