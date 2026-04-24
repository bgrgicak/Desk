import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  CornerDownLeft, ChevronDown, Folder, FileText, StickyNote, Link2, Bot, Search, Paperclip, X,
  Zap, ImageIcon, Table, Globe, Play, Target,
  type LucideIcon,
} from 'lucide-react'
import type { ContextItem } from '@/data/ui-types'
import {
  useGetAgentsQuery,
  useGetLibraryQuery,
  useUploadChatArtifactMutation,
  useUploadLibraryFileMutation,
} from '@/store/api'
import { useAppSelector } from '@/store/hooks'
import { selectFolders } from '@/store/slices/derivedSlice'
import { toContextItem } from '@/store/selectors/library'
import { FileDropZone } from '@/components/upload/FileDropZone'
import { toast } from 'sonner'

const ITEM_ICON: Record<ContextItem['type'], LucideIcon> = {
  file: FileText,
  note: StickyNote,
  link: Link2,
}

type GoalKey = 'app' | 'document' | 'image' | 'data' | 'site' | 'run' | null

interface Goal {
  key: GoalKey
  label: string
  Icon: LucideIcon | null
  placeholder: string
}

const GOALS: Goal[] = [
  { key: 'app',      label: 'New app',   Icon: Zap,       placeholder: 'Describe the app you want to build...' },
  { key: 'document', label: 'New doc',   Icon: FileText,  placeholder: 'What should the document cover?' },
  { key: 'image',    label: 'New image', Icon: ImageIcon, placeholder: 'Describe the image you want to create...' },
  { key: 'data',     label: 'New data',  Icon: Table,     placeholder: 'What data do you want to track or analyse?' },
  { key: 'site',     label: 'New site',  Icon: Globe,     placeholder: 'Describe the site you want to build...' },
  { key: 'run',      label: 'New run',   Icon: Play,      placeholder: 'What should run in the background?' },
  { key: null,       label: 'No goal',   Icon: Target,    placeholder: 'Ask anything, start a task, build something...' },
]

function inferGoal(text: string): GoalKey {
  const lower = text.toLowerCase().trim()
  if (!lower) return null
  if (lower.match(/build|make|app|tracker|dashboard|tool|calculator/)) return 'app'
  if (lower.match(/site|website|landing|portfolio|page/))              return 'site'
  if (lower.match(/image|design|logo|illustration|palette|visual|photo|picture/)) return 'image'
  if (lower.match(/spreadsheet|data|table|csv|metrics|numbers|chart|graph/))      return 'data'
  if (lower.match(/run|check|monitor|scan|sync|schedule|automate|watch/))         return 'run'
  if (lower.match(/write|draft|create|plan|strategy|brief|report|email|agenda|notes|document|summary|summarise|summarize/)) return 'document'
  if (lower.length > 10) return 'document'
  return null
}

type AttachedItem = {
  id: string
  name: string
  kind: 'folder' | 'item'
  type?: ContextItem['type']
}

export interface UploadedFile {
  id: string
  name: string
}

interface ChatInputProps {
  onSend: (message: string, uploads: UploadedFile[]) => void
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
  compact?: boolean
  showGoalPicker?: boolean
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
   * When set, "Upload a file…" and drag-and-drop persist to the chat
   * via POST /chats/:id/artifacts. When absent but chatWorkspaceId is
   * set (compose flow before the chat exists), uploads go to the
   * workspace library instead.
   */
  chatId?: string
}

// Calculate fixed position above a trigger button
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

export function ChatInput({
  onSend,
  disabled = false,
  placeholder = 'Ask anything, start a task, build something...',
  autoFocus = false,
  compact = false,
  showGoalPicker = true,
  prefillValue,
  focusRef,
  chatAgentId,
  chatWorkspaceId,
  chatId,
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const [attachedItems, setAttachedItems] = useState<AttachedItem[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ── Server-backed pickers ───────────────────────────────────────────────
  const { data: serverAgents } = useGetAgentsQuery()
  const { data: libraryResp } = useGetLibraryQuery(
    chatWorkspaceId ? { workspaceId: chatWorkspaceId } : undefined,
    { skip: !chatWorkspaceId },
  )
  const folders = useAppSelector(selectFolders)
  const libraryItems: ContextItem[] = (libraryResp?.items ?? []).map(toContextItem)

  // Register imperative focus handle
  useEffect(() => {
    if (focusRef) focusRef.current = () => textareaRef.current?.focus()
    return () => { if (focusRef) focusRef.current = null }
  }, [focusRef])

  // Button refs (for portal positioning)
  const attachBtnRef = useRef<HTMLButtonElement>(null)
  const agentBtnRef = useRef<HTMLButtonElement>(null)
  const goalBtnRef = useRef<HTMLButtonElement>(null)

  // Dropdown content refs (for click-outside)
  const attachDropRef = useRef<HTMLDivElement>(null)
  const agentDropRef = useRef<HTMLDivElement>(null)
  const goalDropRef = useRef<HTMLDivElement>(null)

  // Stored rects for portal positioning
  const [attachRect, setAttachRect] = useState<DOMRect | null>(null)
  const [agentRect, setAgentRect] = useState<DOMRect | null>(null)
  const [goalRect, setGoalRect] = useState<DOMRect | null>(null)

  // Pickers open state
  const [attachOpen, setAttachOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [goalOpen, setGoalOpen] = useState(false)

  // Search state
  const [attachSearch, setAttachSearch] = useState('')
  const [agentSearch, setAgentSearch] = useState('')
  const [atMentionStart, setAtMentionStart] = useState<number | null>(null)

  // Selections
  // The picker surface is "pick the agent for this chat" now that the
  // server enforces one agent per chat (see plan §6, row 3). When we
  // know the chat's agentId, hydrate from it; otherwise fall back to
  // the first agent returned by /agents.
  //
  // TODO(api-gap): PATCH /chats/:id doesn't yet accept agentId, so
  // clicking another agent for an existing chat is a display-only
  // preview that resets on reload — matrix §4.3.4. The selection will
  // be persisted server-side once the endpoint carries it.
  const serverActiveAgent =
    (chatAgentId ? serverAgents?.find(a => a.id === chatAgentId) : undefined)
    ?? serverAgents?.[0]
    ?? null
  const [previewAgentId, setPreviewAgentId] = useState<string | null>(null)
  const activeAgent =
    (previewAgentId ? serverAgents?.find(a => a.id === previewAgentId) : undefined) ?? serverActiveAgent
  const [goalOverride, setGoalOverride] = useState<GoalKey | undefined>(undefined)
  const suggestedGoal = inferGoal(value)
  const effectiveGoalKey: GoalKey = goalOverride !== undefined ? goalOverride : suggestedGoal
  const effectiveGoal = GOALS.find(g => g.key === effectiveGoalKey) ?? null
  // When the goal picker is hidden, always use the passed placeholder directly.
  // Otherwise the goal inference would override it with "Ask anything, start a task…"
  const activePlaceholder = showGoalPicker
    ? (effectiveGoal?.placeholder ?? placeholder)
    : placeholder

  // Attachment list — folders are client-derived (empty for now; matrix
  // §4.2.1), files come straight from the library.
  const allAttachments = [
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

  // Auto-focus
  useEffect(() => {
    if (autoFocus && textareaRef.current) textareaRef.current.focus()
  }, [autoFocus])

  // Prefill: set value and focus when prefillValue changes
  useEffect(() => {
    if (prefillValue !== undefined && prefillValue !== '') {
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

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        !attachBtnRef.current?.contains(target) &&
        !attachDropRef.current?.contains(target)
      ) {
        setAttachOpen(false)
        if (atMentionStart !== null) setAtMentionStart(null)
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
  }, [atMentionStart])

  // Detect @ mention while typing
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value
    const cursor = e.target.selectionStart ?? newVal.length
    const textBefore = newVal.slice(0, cursor)
    const atMatch = textBefore.match(/@([^\s@]*)$/)

    if (atMatch) {
      const start = cursor - atMatch[1].length - 1
      setAtMentionStart(start)
      setAttachSearch(atMatch[1])
      setAttachRect(attachBtnRef.current?.getBoundingClientRect() ?? null)
      setAttachOpen(true)
    } else {
      if (atMentionStart !== null) {
        setAtMentionStart(null)
        setAttachSearch('')
        setAttachOpen(false)
      }
    }
    setValue(newVal)
  }

  const insertMention = useCallback((attachment: AttachedItem) => {
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
    setAttachOpen(false)
    setAtMentionStart(null)
    setAttachSearch('')
    setTimeout(() => el.focus(), 0)
  }, [value, atMentionStart])

  const removeAttachedItem = (id: string) => {
    setAttachedItems(prev => prev.filter(p => p.id !== id))
  }

  // Real upload paths — chat-scoped when the chat already exists,
  // workspace-scoped library otherwise (compose before first message).
  const [uploadChatArtifact, chatUploadState] = useUploadChatArtifactMutation()
  const [uploadLibraryFile, libraryUploadState] = useUploadLibraryFileMutation()
  const isUploading = chatUploadState.isLoading || libraryUploadState.isLoading
  const uploadEnabled = Boolean(chatId) || Boolean(chatWorkspaceId)
  const hasRealChatId = Boolean(chatId) && !chatId!.startsWith('chat-new-')

  const handleFilesUpload = async (files: File[]) => {
    for (const file of files) {
      try {
        if (hasRealChatId) {
          const serverFile = await uploadChatArtifact({
            chatId: chatId!,
            file,
          }).unwrap()
          setAttachedItems(prev => [
            ...prev,
            { id: `upload-${serverFile.id ?? serverFile.path ?? Date.now()}`, name: serverFile.name ?? file.name, kind: 'item', type: 'file' },
          ])
        } else if (chatWorkspaceId) {
          const serverFile = await uploadLibraryFile({
            workspaceId: chatWorkspaceId,
            file,
          }).unwrap()
          setAttachedItems(prev => [
            ...prev,
            { id: `upload-${serverFile.id ?? serverFile.path ?? Date.now()}`, name: serverFile.name ?? file.name, kind: 'item', type: 'file' },
          ])
        } else {
          toast.error('Cannot upload: no chat or workspace context')
          return
        }
        toast.success(`Uploaded ${file.name}`)
      } catch (err) {
        toast.error(`Upload failed: ${file.name}`, {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    }
    setAttachOpen(false)
  }

  const handleSubmit = () => {
    const trimmed = value.trim()
    if ((!trimmed && attachedItems.length === 0) || disabled) return
    const uploads: UploadedFile[] = attachedItems
      .filter(i => i.id.startsWith('upload-'))
      .map(i => ({ id: i.id, name: i.name }))
    onSend(trimmed, uploads)
    setValue('')
    setAttachedItems([])
    setGoalOverride(undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setAttachOpen(false); setAgentOpen(false); setGoalOpen(false); setAtMentionStart(null) }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
  }

  const canSubmit = (value.trim().length > 0 || attachedItems.length > 0) && !disabled
  const pickerBtnClass = 'flex items-center gap-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors px-2 h-6 text-xs font-medium shrink-0'
  const dropdownClass = 'rounded-lg border bg-background shadow-lg overflow-hidden flex flex-col'

  return (
    <FileDropZone
      onFiles={handleFilesUpload}
      disabled={!uploadEnabled || isUploading}
      overlayLabel={
        isUploading
          ? 'Uploading…'
          : hasRealChatId
            ? 'Drop to attach to chat'
            : chatWorkspaceId
              ? 'Drop to add to Library'
              : 'Pick a workspace first'
      }
      className="w-full"
    >
      {({ openPicker }) => (
    <div className="w-full">
      {/* Input card */}
      <div className="rounded-lg border bg-background">
        {/* Chips — only when attachments exist */}
        {attachedItems.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 px-3 ${compact ? 'pt-2' : 'pt-3'}`}>
            {attachedItems.map(item => {
              const Icon = item.kind === 'folder' ? Folder : ITEM_ICON[item.type ?? 'file'] ?? FileText
              return (
                <span
                  key={item.id}
                  className="inline-flex items-center gap-1 rounded-md bg-secondary text-secondary-foreground text-xs font-medium h-6 pl-2 pr-1 max-w-[200px]"
                >
                  <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <button
                    type="button"
                    onClick={() => {
                      setAttachRect(attachBtnRef.current?.getBoundingClientRect() ?? null)
                      setAttachOpen(true); setAgentOpen(false); setAttachSearch('')
                    }}
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

        {/* Goal picker */}
        {showGoalPicker && (
          <>
            <button
              ref={goalBtnRef}
              onClick={() => {
                const rect = goalBtnRef.current?.getBoundingClientRect() ?? null
                setGoalRect(rect)
                setGoalOpen(v => !v)
                setAttachOpen(false)
                setAgentOpen(false)
              }}
              className={`${pickerBtnClass} ${effectiveGoal && effectiveGoal.key !== null ? 'text-foreground' : ''}`}
            >
              {effectiveGoal && effectiveGoal.key !== null && effectiveGoal.Icon
                ? <effectiveGoal.Icon className="h-3 w-3" />
                : <Target className="h-3 w-3" />
              }
              {effectiveGoal && effectiveGoal.key !== null ? effectiveGoal.label : 'No goal'}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {goalOpen && goalRect && createPortal(
              <div ref={goalDropRef} style={getDropdownStyle(goalRect, 208)} className={dropdownClass}>
                <p className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Output</p>
                <div className="pb-1.5">
                  {GOALS.map(goal => {
                    const isSuggested = goal.key === suggestedGoal && suggestedGoal !== null
                    const isSelected = goalOverride !== undefined ? goal.key === goalOverride : goal.key === suggestedGoal
                    return (
                      <button
                        key={String(goal.key)}
                        onClick={() => { setGoalOverride(goal.key); setGoalOpen(false) }}
                        className={`flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left ${isSelected ? 'bg-muted/30' : ''}`}
                      >
                        {goal.Icon
                          ? <goal.Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          : <span className="h-3.5 w-3.5 shrink-0" />
                        }
                        <span className="flex-1">{goal.label}</span>
                        {isSuggested && <span className="text-[10px] text-muted-foreground/70 shrink-0">Suggested</span>}
                      </button>
                    )
                  })}
                </div>
              </div>,
              document.body
            )}
          </>
        )}

        {/* Agent picker */}
        <>
          <button
            ref={agentBtnRef}
            onClick={() => {
              const rect = agentBtnRef.current?.getBoundingClientRect() ?? null
              setAgentRect(rect)
              setAgentOpen(v => !v)
              setAttachOpen(false)
              setGoalOpen(false)
              setAgentSearch('')
            }}
            className={pickerBtnClass}
          >
            <Bot className="h-3 w-3" />
            {activeAgent?.name ?? 'Agent'}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
          {agentOpen && agentRect && createPortal(
            <div ref={agentDropRef} style={getDropdownStyle(agentRect, 256)} className={dropdownClass}>
              <div className="flex items-center gap-2 px-3 py-2 border-b">
                <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <input
                  autoFocus
                  value={agentSearch}
                  onChange={e => setAgentSearch(e.target.value)}
                  placeholder="Search agents…"
                  className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground/50"
                />
              </div>
              <div className="overflow-y-auto max-h-48">
                {filteredAgents.length === 0 && (
                  <p className="px-3 py-4 text-xs text-muted-foreground text-center">No results</p>
                )}
                {filteredAgents.map(agent => (
                  <button
                    key={agent.id}
                    onClick={() => {
                      setPreviewAgentId(agent.id)
                      setAgentOpen(false)
                    }}
                    className={`flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left ${activeAgent?.id === agent.id ? 'bg-muted/30' : ''}`}
                  >
                    <span>{agent.name}</span>
                    <span className="text-xs text-muted-foreground ml-2 shrink-0">{agent.model}</span>
                  </button>
                ))}
              </div>
            </div>,
            document.body
          )}
        </>

        {/* Attachment picker */}
        <>
          <button
            ref={attachBtnRef}
            onClick={() => {
              const rect = attachBtnRef.current?.getBoundingClientRect() ?? null
              setAttachRect(rect)
              setAttachOpen(v => !v)
              setAgentOpen(false)
              setGoalOpen(false)
              setAttachSearch('')
            }}
            className={pickerBtnClass}
          >
            <Paperclip className="h-3 w-3" />
            Add files
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
          {attachOpen && attachRect && createPortal(
            <div ref={attachDropRef} style={getDropdownStyle(attachRect, 288)} className={dropdownClass}>
              <div className="flex items-center gap-2 px-3 py-2 border-b">
                <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <input
                  autoFocus
                  value={attachSearch}
                  onChange={e => setAttachSearch(e.target.value)}
                  placeholder="Search files and folders…"
                  className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground/50"
                />
              </div>
              <div className="overflow-y-auto max-h-52">
                {filteredAttachments.length === 0 && (
                  <p className="px-3 py-4 text-xs text-muted-foreground text-center">No results</p>
                )}
                {filteredAttachments.some(a => a.kind === 'folder') && (
                  <>
                    <p className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Folders</p>
                    {filteredAttachments.filter(a => a.kind === 'folder').map(a => (
                      <button key={a.id} onClick={() => insertMention(a)}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left"
                      >
                        <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate">{a.name}</span>
                        {attachedItems.some(i => i.id === a.id) && (
                          <span className="ml-auto shrink-0 h-1.5 w-1.5 rounded-full bg-primary" />
                        )}
                      </button>
                    ))}
                  </>
                )}
                {filteredAttachments.some(a => a.kind === 'item') && (
                  <>
                    <p className="px-3 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Files</p>
                    {filteredAttachments.filter(a => a.kind === 'item').map(a => {
                      const Icon = a.kind === 'item' ? ITEM_ICON[a.type] : FileText
                      return (
                        <button key={a.id} onClick={() => insertMention(a)}
                          className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted/50 transition-colors text-left"
                        >
                          <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="truncate">{a.name}</span>
                          {attachedItems.some(i => i.id === a.id) && (
                            <span className="ml-auto shrink-0 h-1.5 w-1.5 rounded-full bg-primary" />
                          )}
                        </button>
                      )
                    })}
                  </>
                )}
              </div>
              <div className="border-t">
                <button
                  onClick={() => {
                    setAttachOpen(false)
                    openPicker()
                  }}
                  disabled={!uploadEnabled || isUploading}
                  data-testid="chat-upload-a-file"
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left text-muted-foreground disabled:opacity-50 disabled:pointer-events-none"
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0" />
                  <span>{isUploading ? 'Uploading…' : 'Upload a file…'}</span>
                </button>
              </div>
            </div>,
            document.body
          )}
        </>

      </div>
    </div>
      )}
    </FileDropZone>
  )
}
