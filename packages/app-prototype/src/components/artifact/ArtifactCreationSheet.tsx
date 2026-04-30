import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { X, FileText, Zap, ImageIcon, Table, Globe } from 'lucide-react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ComposerPickers } from '@/components/compose/ComposerPickers'
import { attachmentChipIcon, type ComposerAttachment } from '@/components/compose/composer-pickers-utils'
import type { ArtifactType } from '@/data/ui-types'
import type { AttachmentRef } from '@/store/types'
import { useUploadLibraryFileMutation } from '@/store/api'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ArtifactCreateInput {
  type?: ArtifactType
  instructions: string
  name?: string
  attachments?: AttachmentRef[]
  agentId?: string
}

interface ArtifactCreationSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId?: string
  /** Called when at least one field is filled — parent creates the chat
   * and posts the assembled prompt as the first message. */
  onCreateArtifact: (input: ArtifactCreateInput) => Promise<void> | void
  /** Called when every field is empty — parent navigates to a fresh new
   * chat, optionally seeding the agent picked in the sheet. */
  onSkipToChat?: (agentId?: string) => Promise<void> | void
}

interface FormState {
  type?: ArtifactType
  instructions: string
  name: string
}

const DEFAULT_FORM: FormState = {
  type: undefined,
  instructions: '',
  name: '',
}

// ── Type choice card config ────────────────────────────────────────────────────

const TYPE_CONFIG: Record<ArtifactType, { label: string; desc: string; icon: React.ElementType }> = {
  document:    { label: 'Document',    desc: 'Reports, briefs, plans',     icon: FileText  },
  app:         { label: 'App',         desc: 'Tools, dashboards, trackers', icon: Zap       },
  image:       { label: 'Image',       desc: 'Logos, illustrations, art',  icon: ImageIcon },
  spreadsheet: { label: 'Spreadsheet', desc: 'Tables, data, charts',       icon: Table     },
  site:        { label: 'Site',        desc: 'Landings, pages, portfolios', icon: Globe     },
}

const TYPE_ORDER: ArtifactType[] = ['document', 'app', 'image', 'spreadsheet', 'site']

// ── Main component ─────────────────────────────────────────────────────────────

export function ArtifactCreationSheet({
  open,
  onOpenChange,
  workspaceId,
  onCreateArtifact,
  onSkipToChat,
}: ArtifactCreationSheetProps) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [agentId, setAgentId] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  // Portal target for ComposerPickers' floating dropdowns. Must live
  // inside SheetContent so the dropdown sits within Radix Dialog's
  // FocusScope (otherwise the trap pulls focus out of the search input).
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadLibraryFile, { isLoading: isUploading }] = useUploadLibraryFileMutation()
  const prevOpenRef = useRef(false)

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setForm(DEFAULT_FORM)
      setAttachments([])
      setAgentId(undefined)
    }
    prevOpenRef.current = open
  }, [open])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function toggleType(type: ArtifactType) {
    setForm(prev => ({ ...prev, type: prev.type === type ? undefined : type }))
  }

  const isEmpty =
    !form.type &&
    !form.instructions.trim() &&
    !form.name.trim() &&
    attachments.length === 0

  const buttonLabel = submitting
    ? (isEmpty ? 'Opening…' : 'Creating…')
    : (isEmpty ? 'Skip to chat' : 'Create')

  function removeAttachment(id: string) {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  function openUploadPicker() {
    fileInputRef.current?.click()
  }

  async function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!files.length || !workspaceId) return
    for (const file of files) {
      try {
        const serverFile = await uploadLibraryFile({ workspaceId, file }).unwrap()
        setAttachments(prev => prev.some(a => a.id === serverFile.path)
          ? prev
          : [...prev, { id: serverFile.path, name: serverFile.name ?? file.name, kind: 'item', type: 'file' }],
        )
      } catch (err) {
        toast.error(`Failed to upload ${file.name}`, {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    }
  }

  async function handlePrimary() {
    setSubmitting(true)
    try {
      if (isEmpty) {
        await onSkipToChat?.(agentId)
      } else {
        const refs: AttachmentRef[] = attachments.map(a => ({
          path: a.id,
          name: a.name,
          kind: a.kind === 'folder' ? 'directory' : 'file',
        }))
        await onCreateArtifact({
          type:         form.type,
          instructions: form.instructions.trim(),
          name:         form.name.trim() || undefined,
          attachments:  refs.length ? refs : undefined,
          agentId,
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex flex-col p-0 gap-0 sm:max-w-none w-[480px]"
        ref={setPortalContainer}
      >
        {/* Header */}
        <div className="h-[52px] flex items-center justify-between px-4 border-b shrink-0">
          <span className="text-sm font-semibold truncate flex-1 min-w-0 mr-2">
            {form.name.trim() || 'Create new'}
          </span>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Form body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

          {/* Type */}
          <div className="grid grid-cols-2 gap-2">
            {TYPE_ORDER.map(type => {
              const { label, desc, icon: Icon } = TYPE_CONFIG[type]
              const selected = form.type === type
              return (
                <button
                  key={type}
                  type="button"
                  data-testid={`artifact-sheet-type-${type}`}
                  data-selected={selected}
                  onClick={() => toggleType(type)}
                  className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-4 text-center cursor-pointer transition-colors hover:bg-accent/30 data-[selected=true]:border-primary data-[selected=true]:ring-2 data-[selected=true]:ring-primary/20 data-[selected=true]:bg-primary/5"
                >
                  <Icon className="h-6 w-6 shrink-0 text-muted-foreground/60" />
                  <div className="text-sm font-medium leading-none mt-0.5">{label}</div>
                  <div className="text-xs text-muted-foreground line-clamp-2">{desc}</div>
                </button>
              )
            })}
          </div>

          {/* Instructions + pickers row */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Instructions</label>
            <div className="rounded-lg border bg-background shadow-xs">
              {attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                  {attachments.map(item => {
                    const Icon = attachmentChipIcon(item)
                    return (
                      <span
                        key={item.id}
                        className="inline-flex items-center gap-1 rounded-md bg-secondary text-secondary-foreground text-xs font-medium h-6 pl-2 pr-1 max-w-[200px]"
                      >
                        <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="truncate">{item.name}</span>
                        <button
                          type="button"
                          onClick={() => removeAttachment(item.id)}
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
              <div className="px-3 py-2">
                <textarea
                  rows={5}
                  data-testid="artifact-sheet-instructions"
                  value={form.instructions}
                  onChange={e => set('instructions', e.target.value)}
                  placeholder="Describe what you want to create…"
                  className="w-full resize-y bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 min-h-[80px]"
                />
              </div>
            </div>
            <div className="mt-1.5">
              <ComposerPickers
                workspaceId={workspaceId}
                agentId={agentId}
                onAgentChange={setAgentId}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                portalContainer={portalContainer}
                onOpenUploadPicker={workspaceId ? openUploadPicker : undefined}
                uploadInProgress={isUploading}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={handleFileInputChange}
              />
            </div>
          </div>

          {/* Name (optional) */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Name <span className="font-normal text-muted-foreground/60">(optional)</span></label>
            <Input
              data-testid="artifact-sheet-name"
              placeholder="Generated automatically if blank"
              value={form.name}
              onChange={e => set('name', e.target.value)}
            />
          </div>

        </div>

        <div className="p-4 flex justify-end gap-2 shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button
            data-testid="artifact-sheet-submit"
            onClick={handlePrimary}
            disabled={submitting}
          >
            {buttonLabel}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

