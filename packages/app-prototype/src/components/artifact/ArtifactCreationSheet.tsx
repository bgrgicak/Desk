import { useState, useEffect, useRef } from 'react'
import { X, FileText, Zap, ImageIcon, Table, Globe } from 'lucide-react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { ArtifactType } from '@/data/ui-types'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ArtifactCreateInput {
  type: ArtifactType
  instructions: string
  name?: string
}

interface ArtifactCreationSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateArtifact: (input: ArtifactCreateInput) => Promise<void> | void
}

interface FormState {
  type: ArtifactType
  instructions: string
  name: string
}

const DEFAULT_FORM: FormState = {
  type: 'document',
  instructions: '',
  name: '',
}

// ── Type choice card config ────────────────────────────────────────────────────

const TYPE_CONFIG: Record<ArtifactType, { label: string; desc: string; icon: React.ElementType; color: string }> = {
  document:    { label: 'Document',    desc: 'Reports, briefs, plans, notes',           icon: FileText,  color: 'text-blue-500'   },
  app:         { label: 'App',         desc: 'Interactive tools, dashboards, trackers', icon: Zap,       color: 'text-amber-500'  },
  image:       { label: 'Image',       desc: 'Illustrations, logos, designs',           icon: ImageIcon, color: 'text-pink-500'   },
  spreadsheet: { label: 'Spreadsheet', desc: 'Tables, data analysis, calculations',     icon: Table,     color: 'text-green-500'  },
  site:        { label: 'Site',        desc: 'Web pages, landing pages, portfolios',    icon: Globe,     color: 'text-purple-500' },
}

const TYPE_ORDER: ArtifactType[] = ['document', 'app', 'image', 'spreadsheet', 'site']

// ── Main component ─────────────────────────────────────────────────────────────

export function ArtifactCreationSheet({ open, onOpenChange, onCreateArtifact }: ArtifactCreationSheetProps) {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [submitting, setSubmitting] = useState(false)
  const prevOpenRef = useRef(false)

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setForm(DEFAULT_FORM)
    }
    prevOpenRef.current = open
  }, [open])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function handleCreate() {
    if (!form.instructions.trim()) return
    setSubmitting(true)
    try {
      await onCreateArtifact({
        type:         form.type,
        instructions: form.instructions.trim(),
        name:         form.name.trim() || undefined,
      })
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = form.instructions.trim().length > 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex flex-col p-0 gap-0 sm:max-w-none w-[480px]"
      >
        {/* Header */}
        <div className="h-[52px] flex items-center justify-between px-4 border-b shrink-0">
          <span className="text-sm font-semibold truncate flex-1 min-w-0 mr-2">
            {form.name.trim() || 'New artifact'}
          </span>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Form body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

          {/* Type */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Type</label>
            <RadioGroup
              value={form.type}
              onValueChange={v => set('type', v as ArtifactType)}
              className="grid grid-cols-1 gap-2"
            >
              {TYPE_ORDER.map(type => {
                const { label, desc, icon: Icon, color } = TYPE_CONFIG[type]
                const id = `artifact-type-${type}`
                return (
                  <div key={type} className="relative">
                    <RadioGroupItem value={type} id={id} className="sr-only" />
                    <label
                      htmlFor={id}
                      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors hover:bg-accent/30 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5`}
                    >
                      <Icon className={`h-5 w-5 mt-0.5 shrink-0 ${color}`} />
                      <div>
                        <div className="text-sm font-medium leading-none mb-1">{label}</div>
                        <div className="text-xs text-muted-foreground">{desc}</div>
                      </div>
                    </label>
                  </div>
                )
              })}
            </RadioGroup>
          </div>

          {/* Instructions */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Instructions</label>
            <div className="rounded-lg border bg-background shadow-xs">
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
            onClick={handleCreate}
            disabled={submitting || !canSubmit}
          >
            {submitting ? 'Creating…' : 'Create artifact'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
