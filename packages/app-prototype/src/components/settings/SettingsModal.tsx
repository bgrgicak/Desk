import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Settings2, Bot, Plug, Sliders,
  Trash2, Plus, ChevronDown, X, Search,
  Pencil, MessageSquare, Copy, MoreHorizontal,
} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import {
  CONNECTION_CATALOG,
  MOCK_CONNECTIONS,
  MOCK_PROVIDERS,
  MOCK_SETTINGS_AGENTS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  type Connection,
  type ConnectionKind,
  type Provider,
  type ProviderKind,
  type SettingsAgent,
} from '@/data/mock-data'
import type { WorkspaceInfo } from '@/components/layout/WorkspaceBar'

// ── Brand marks (Anthropic + OpenAI) ─────────────────────────────────────────

function ClaudeLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden className={className}>
      <path
        fill="currentColor"
        d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zM6.569 3.52h3.767L16.906 20h-3.674l-1.343-3.461H5.017L3.673 20H0L6.569 3.52zm4.132 9.959L8.453 7.687 6.205 13.479z"
      />
    </svg>
  )
}

function OpenAILogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden className={className}>
      <path
        fill="currentColor"
        d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.911 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.182a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.998-2.9 6.056 6.056 0 0 0-.748-7.073zm-9.022 12.608a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.759a.795.795 0 0 0 .393-.681v-6.737l2.02 1.169a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.495 4.494zm-9.66-4.126a4.471 4.471 0 0 1-.535-3.013l.142.085 4.783 2.758a.771.771 0 0 0 .78 0l5.843-3.368v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.499 4.499 0 0 1-6.14-1.647zM2.341 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.814 3.354-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786a4.504 4.504 0 0 1-1.647-6.14zm16.597 3.856L13.104 8.364l2.015-1.164a.076.076 0 0 1 .071 0l4.83 2.79a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.41 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.499 4.499 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.056V6.074A4.499 4.499 0 0 1 13.626 2.62l-.142.08L8.7 5.46a.795.795 0 0 0-.393.681zm1.098-2.365 2.602-1.5 2.607 1.5v3l-2.598 1.5-2.607-1.5z"
      />
    </svg>
  )
}

// ── Color + emoji options (mirrored from WorkspaceBar) ──────────────────────

const EMOJI_OPTIONS = [
  '🏡','💼','🎨','📚','🚀','💡','🌿','⚡',
  '🎯','🔬','💻','🎵','🌍','⭐','🏆','🔒',
  '🌊','🦋','🍀','🔥','🧠','🌸','🎭','🐝',
]

const COLOR_OPTIONS = [
  { value: '#fef3c7', label: 'Amber'  },
  { value: '#dbeafe', label: 'Blue'   },
  { value: '#fce7f3', label: 'Pink'   },
  { value: '#d1fae5', label: 'Green'  },
  { value: '#ede9fe', label: 'Purple' },
  { value: '#ffedd5', label: 'Orange' },
  { value: '#fee2e2', label: 'Red'    },
  { value: '#ccfbf1', label: 'Teal'   },
]


// ── Nav sections ─────────────────────────────────────────────────────────────

type NavSection = 'workspace' | 'agents' | 'connections' | 'preferences'

const NAV: { id: NavSection; label: string; icon: typeof Settings2 }[] = [
  { id: 'workspace',   label: 'Workspace',   icon: Settings2 },
  { id: 'agents',      label: 'Agents',      icon: Bot       },
  { id: 'connections', label: 'Connections', icon: Plug      },
  { id: 'preferences', label: 'Preferences', icon: Sliders   },
]

// ── Section components ───────────────────────────────────────────────────────

function WorkspaceSection({
  workspace,
  onUpdate,
  onDelete,
}: {
  workspace: WorkspaceInfo
  onUpdate: (ws: WorkspaceInfo) => void
  onDelete: () => void
}) {
  const [name, setName]               = useState(workspace.name)
  const [emoji, setEmoji]             = useState(workspace.emoji)
  const [color, setColor]             = useState(workspace.bg)
  const [description, setDescription] = useState(workspace.description)
  const [deleteOpen, setDeleteOpen]   = useState(false)

  const isDirty =
    name !== workspace.name ||
    emoji !== workspace.emoji ||
    color !== workspace.bg ||
    description !== workspace.description

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrolledUnder, setScrolledUnder] = useState(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => {
      setScrolledUnder(el.scrollHeight > el.clientHeight + el.scrollTop + 1)
    }
    update()
    el.addEventListener('scroll', update)
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', update); ro.disconnect() }
  }, [])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-4">
        {/* Preview + Name */}
        <div className="flex items-center gap-3">
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-2xl select-none"
            style={{ backgroundColor: color }}
          >
            {emoji}
          </div>
          <Input
            placeholder="Workspace name"
            value={name}
            onChange={e => setName(e.target.value)}
            className="flex-1"
          />
        </div>

        {/* Color */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Color</p>
          <div className="flex gap-2 flex-wrap">
            {COLOR_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                title={label}
                onClick={() => setColor(value)}
                className={`h-6 w-6 rounded-full transition-all ${
                  color === value ? 'ring-2 ring-offset-2 ring-foreground/40 scale-110' : 'hover:scale-110'
                }`}
                style={{ backgroundColor: value }}
              />
            ))}
          </div>
        </div>

        {/* Emoji */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Icon</p>
          <div className="grid grid-cols-8 gap-1">
            {EMOJI_OPTIONS.map(e => (
              <button
                key={e}
                onClick={() => setEmoji(e)}
                className={`flex items-center justify-center h-8 w-8 rounded-md text-lg transition-colors ${
                  emoji === e ? 'bg-muted ring-1 ring-ring/40' : 'hover:bg-muted'
                }`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        {/* Description */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Description</p>
          <Textarea
            placeholder="What's this workspace for?"
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={2}
            className="resize-none"
          />
        </div>
      </div>

      <div
        className={cn(
          'shrink-0 p-4 flex items-center justify-between gap-2 border-t border-transparent',
          scrolledUnder && 'border-border',
        )}
      >
        <Popover open={deleteOpen} onOpenChange={setDeleteOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive gap-1.5">
              <Trash2 className="h-3.5 w-3.5" />
              Delete workspace
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-4" align="start">
            <p className="text-sm font-medium mb-1">Delete this workspace?</p>
            <p className="text-xs text-muted-foreground mb-3">
              This will permanently remove the workspace and all its content. This can't be undone.
            </p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                className="flex-1"
                onClick={() => { setDeleteOpen(false); onDelete() }}
              >
                Delete
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <Button
          size="sm"
          disabled={!name.trim() || !isDirty}
          onClick={() => onUpdate({ ...workspace, name: name.trim(), emoji, bg: color, description })}
        >
          Save changes
        </Button>
      </div>
    </div>
  )
}

// ── Agents section ───────────────────────────────────────────────────────────

type AgentsFocus =
  | { mode: 'edit'; id: string }
  | { mode: 'new' }
  | null

type StatusFilter = 'all' | 'active' | 'inactive'

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all',      label: 'All'      },
  { value: 'active',   label: 'Active'   },
  { value: 'inactive', label: 'Inactive' },
]

interface AgentsSectionProps {
  providers: Provider[]
  agents: SettingsAgent[]
  search: string
  statusFilter: StatusFilter
  onSearchChange: (next: string) => void
  onStatusFilterChange: (next: StatusFilter) => void
  onFocus: (next: AgentsFocus) => void
  onDeleteAgent: (id: string) => void
  onDuplicateAgent: (id: string) => void
  onToggleEnabled: (id: string) => void
}

function AgentsSection({
  providers, agents, search, statusFilter,
  onSearchChange, onStatusFilterChange, onFocus,
  onDeleteAgent, onDuplicateAgent, onToggleEnabled,
}: AgentsSectionProps) {
  const q = search.trim().toLowerCase()
  const filteredAgents = agents
    .filter(a => statusFilter === 'all'
      || (statusFilter === 'active' && a.enabled)
      || (statusFilter === 'inactive' && !a.enabled))
    .filter(a => {
      if (!q) return true
      const providerName = providers.find(p => p.id === a.providerId)?.name ?? ''
      return a.name.toLowerCase().includes(q)
        || a.model.toLowerCase().includes(q)
        || providerName.toLowerCase().includes(q)
    })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center rounded-lg border p-0.5">
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => onStatusFilterChange(f.value)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                statusFilter === f.value
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <SearchInput
            value={search}
            onChange={onSearchChange}
            placeholder="Search agents…"
          />
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => onFocus({ mode: 'new' })}
          >
            <Plus className="h-3.5 w-3.5" />Add
          </Button>
        </div>
      </div>
      <AgentsList
        agents={filteredAgents}
        providers={providers}
        hasAnyAgents={agents.length > 0}
        hasAnyProviders={providers.length > 0}
        query={q}
        onOpen={(id) => onFocus({ mode: 'edit', id })}
        onAdd={() => onFocus({ mode: 'new' })}
        onDelete={onDeleteAgent}
        onDuplicate={onDuplicateAgent}
        onToggleEnabled={onToggleEnabled}
      />
    </div>
  )
}

function SearchInput({
  value, onChange, placeholder,
}: { value: string; onChange: (next: string) => void; placeholder?: string }) {
  return (
    <div className="relative w-56">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8 text-sm"
      />
    </div>
  )
}

// ── Agents list + detail ─────────────────────────────────────────────────────

interface AgentsListProps {
  agents: SettingsAgent[]
  providers: Provider[]
  hasAnyAgents: boolean
  hasAnyProviders: boolean
  query: string
  onOpen: (id: string) => void
  onAdd: () => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onToggleEnabled: (id: string) => void
}

function AgentsList({
  agents, providers, hasAnyAgents, hasAnyProviders, query,
  onOpen, onAdd, onDelete, onDuplicate, onToggleEnabled,
}: AgentsListProps) {
  if (!hasAnyProviders) {
    return (
      <EmptyState
        title="Add a provider first"
        body="Agents run through a provider. Configure Claude or ChatGPT under Connections first."
      />
    )
  }
  if (!hasAnyAgents) {
    return (
      <EmptyState
        title="No agents yet"
        body="Create an agent with a name, a model, and the default instructions it should follow."
        action={
          <Button size="sm" className="gap-1.5" onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" />Add agent
          </Button>
        }
      />
    )
  }
  if (agents.length === 0) {
    return (
      <EmptyState
        title="No matches"
        body={`No agents match “${query}”.`}
      />
    )
  }
  return (
    <div className="flex flex-col">
      {agents.map((a, i) => {
        const provider = providers.find(p => p.id === a.providerId)
        const providerLabel = provider ? PROVIDER_LABELS[provider.kind] : 'Unlinked'
        return (
          <motion.div
            key={a.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.02, duration: 0.15, ease: 'easeOut' }}
            className="group flex items-center gap-3 py-4 border-b last:border-b-0"
          >
            <Switch
              size="sm"
              checked={a.enabled}
              onCheckedChange={() => onToggleEnabled(a.id)}
              aria-label={`${a.enabled ? 'Disable' : 'Enable'} ${a.name} in this workspace`}
            />
            {provider
              ? <ProviderGlyph kind={provider.kind} size="lg" />
              : <span className="h-10 w-10 shrink-0 rounded-lg bg-muted" />
            }
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{a.name}</p>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                <span className="shrink-0">{providerLabel}</span>
                <span className="truncate">{a.model}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => onOpen(a.id)}
              >
                Edit
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="More actions">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onSelect={() => onOpen(a.id)}>
                    <Pencil className="h-4 w-4" />Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => { /* stub: open chat with this agent */ }}>
                    <MessageSquare className="h-4 w-4" />Chat now
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onDuplicate(a.id)}>
                    <Copy className="h-4 w-4" />Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => onDelete(a.id)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </motion.div>
        )
      })}
    </div>
  )
}

interface AgentDetailProps {
  agents: SettingsAgent[]
  providers: Provider[]
  focus: Exclude<AgentsFocus, null>
  onSave: (agent: SettingsAgent) => void
  onCancel: () => void
}

function AgentDetail({ agents, providers, focus, onSave, onCancel }: AgentDetailProps) {
  const existing = focus.mode === 'edit' ? agents.find(a => a.id === focus.id) : undefined
  const defaultProvider = existing
    ? providers.find(p => p.id === existing.providerId) ?? providers[0]
    : providers[0]

  const [name, setName]                 = useState(existing?.name ?? '')
  const [providerId, setProviderId]     = useState(defaultProvider?.id ?? '')
  const [model, setModel]               = useState(existing?.model ?? '')
  const [instructions, setInstructions] = useState(existing?.instructions ?? '')

  const selectedProvider = providers.find(p => p.id === providerId)
  const modelOptions = useMemo(
    () => (selectedProvider ? PROVIDER_MODELS[selectedProvider.kind] : []),
    [selectedProvider],
  )

  const handleProviderChange = (nextId: string) => {
    setProviderId(nextId)
    const next = providers.find(p => p.id === nextId)
    if (next && !PROVIDER_MODELS[next.kind].includes(model)) {
      setModel(PROVIDER_MODELS[next.kind][0] ?? '')
    }
  }

  const canSave = name.trim() && providerId && model
  const handleSave = () => {
    if (!canSave) return
    onSave({
      id: existing?.id ?? `sa-${Date.now()}`,
      name: name.trim(),
      providerId,
      model,
      instructions: instructions.trim(),
      enabled: existing?.enabled ?? true,
    })
  }

  // Show the footer's top border only while content is hidden behind it.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrolledUnder, setScrolledUnder] = useState(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => {
      setScrolledUnder(el.scrollHeight > el.clientHeight + el.scrollTop + 1)
    }
    update()
    el.addEventListener('scroll', update)
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', update); ro.disconnect() }
  }, [])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-4">
        <Field label="Name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Copywriter" />
        </Field>

        <Field label="Provider" help="Determines which models are available.">
          <SelectDropdown
            value={providerId}
            placeholder="Select provider"
            onChange={handleProviderChange}
            options={providers.map(p => ({ value: p.id, label: `${p.name} (${PROVIDER_LABELS[p.kind]})` }))}
          />
        </Field>

        <Field label="Model">
          <SelectDropdown
            value={model}
            placeholder={selectedProvider ? 'Select model' : 'Pick a provider first'}
            onChange={setModel}
            disabled={!selectedProvider || modelOptions.length === 0}
            options={modelOptions.map(m => ({ value: m, label: m }))}
          />
        </Field>

        <Field label="Default instructions" help="Prepended to every conversation this agent runs.">
          <Textarea
            value={instructions}
            onChange={e => setInstructions(e.target.value)}
            placeholder="Describe how this agent should behave, what tone to use, what to avoid…"
            rows={8}
            className="resize-y min-h-40"
          />
        </Field>
      </div>

      <div
        className={cn(
          'shrink-0 p-4 flex items-center justify-end gap-2 border-t border-transparent',
          scrolledUnder && 'border-border',
        )}
      >
        <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={handleSave} disabled={!canSave}>
          {focus.mode === 'new' ? 'Add agent' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

function ProviderGlyph({ kind, size = 'md' }: { kind: ProviderKind; size?: 'sm' | 'md' | 'lg' }) {
  const box  = size === 'sm' ? 'h-5 w-5' : size === 'lg' ? 'h-10 w-10' : 'h-8 w-8'
  const mark = size === 'sm' ? 'h-3 w-3' : size === 'lg' ? 'h-[22px] w-[22px]' : 'h-[18px] w-[18px]'
  if (kind === 'claude') {
    return (
      <span className={cn('shrink-0 rounded-lg flex items-center justify-center bg-[#F5E6DA] text-[#CC785C]', box)}>
        <ClaudeLogo className={mark} />
      </span>
    )
  }
  if (kind === 'chatgpt') {
    return (
      <span className={cn('shrink-0 rounded-lg flex items-center justify-center bg-black text-white', box)}>
        <OpenAILogo className={mark} />
      </span>
    )
  }
  return (
    <span className={cn('shrink-0 rounded-lg flex items-center justify-center bg-muted text-muted-foreground font-semibold', box, size === 'sm' ? 'text-[11px]' : 'text-sm')}>
      ·
    </span>
  )
}

// ── Small shared bits used by AgentsSection ──────────────────────────────────

function Field({
  label, help, children,
}: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
      {help && <p className="text-xs text-muted-foreground/80">{help}</p>}
    </div>
  )
}

interface SelectDropdownProps {
  value: string
  placeholder: string
  onChange: (next: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
}

function SelectDropdown({ value, placeholder, onChange, options, disabled }: SelectDropdownProps) {
  const selected = options.find(o => o.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs text-left flex items-center justify-between gap-2 transition-colors',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none',
            disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-muted/30',
          )}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronDown className="h-4 w-4 opacity-60 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[var(--radix-dropdown-menu-trigger-width)]">
        {options.length === 0 ? (
          <div className="px-2.5 py-1.5 text-sm text-muted-foreground">No options</div>
        ) : (
          options.map(o => (
            <DropdownMenuItem key={o.value} onSelect={() => onChange(o.value)}>
              {o.label}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EmptyState({
  title, body, action,
}: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed px-6 py-10 text-center flex flex-col items-center gap-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground max-w-sm">{body}</p>
      {action}
    </div>
  )
}

// ── Connections section ──────────────────────────────────────────────────────

type ConnectionsFocus =
  | { mode: 'picker' }
  | { mode: 'new'; kind: ConnectionKind }
  | { mode: 'edit'; id: string }
  | null

interface ConnectionsSectionProps {
  connections: Connection[]
  search: string
  statusFilter: StatusFilter
  onSearchChange: (next: string) => void
  onStatusFilterChange: (next: StatusFilter) => void
  onFocus: (next: ConnectionsFocus) => void
  onDeleteConnection: (id: string) => void
  onDuplicateConnection: (id: string) => void
  onToggleEnabled: (id: string) => void
}

function ConnectionsSection({
  connections, search, statusFilter,
  onSearchChange, onStatusFilterChange, onFocus,
  onDeleteConnection, onDuplicateConnection, onToggleEnabled,
}: ConnectionsSectionProps) {
  const q = search.trim().toLowerCase()
  const filtered = connections
    .filter(c => statusFilter === 'all'
      || (statusFilter === 'active' && c.enabled)
      || (statusFilter === 'inactive' && !c.enabled))
    .filter(c => {
      if (!q) return true
      const kindLabel = CONNECTION_CATALOG[c.kind].name.toLowerCase()
      return c.name.toLowerCase().includes(q) || kindLabel.includes(q)
    })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center rounded-lg border p-0.5">
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => onStatusFilterChange(f.value)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                statusFilter === f.value
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <SearchInput
            value={search}
            onChange={onSearchChange}
            placeholder="Search connections…"
          />
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => onFocus({ mode: 'picker' })}
          >
            <Plus className="h-3.5 w-3.5" />Add
          </Button>
        </div>
      </div>
      <ConnectionsList
        connections={filtered}
        hasAnyConnections={connections.length > 0}
        query={q}
        onOpen={(id) => onFocus({ mode: 'edit', id })}
        onPickNew={() => onFocus({ mode: 'picker' })}
        onDelete={onDeleteConnection}
        onDuplicate={onDuplicateConnection}
        onToggleEnabled={onToggleEnabled}
      />
    </div>
  )
}

interface ConnectionsListProps {
  connections: Connection[]
  hasAnyConnections: boolean
  query: string
  onOpen: (id: string) => void
  onPickNew: () => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onToggleEnabled: (id: string) => void
}

function ConnectionsList({
  connections, hasAnyConnections, query,
  onOpen, onPickNew, onDelete, onDuplicate, onToggleEnabled,
}: ConnectionsListProps) {
  if (!hasAnyConnections) {
    return (
      <EmptyState
        title="No connections yet"
        body="Add Claude, ChatGPT, or another tool to make it available in this workspace."
        action={
          <Button size="sm" className="gap-1.5" onClick={onPickNew}>
            <Plus className="h-3.5 w-3.5" />Add connection
          </Button>
        }
      />
    )
  }
  if (connections.length === 0) {
    return (
      <EmptyState
        title="No matches"
        body={`No connections match “${query}”.`}
      />
    )
  }
  return (
    <div className="flex flex-col">
      {connections.map((c, i) => {
        const meta = CONNECTION_CATALOG[c.kind]
        return (
          <motion.div
            key={c.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.02, duration: 0.15, ease: 'easeOut' }}
            className="group flex items-center gap-3 py-4 border-b last:border-b-0"
          >
            <Switch
              size="sm"
              checked={c.enabled}
              onCheckedChange={() => onToggleEnabled(c.id)}
              aria-label={`${c.enabled ? 'Disable' : 'Enable'} ${c.name} in this workspace`}
            />
            <ConnectionGlyph kind={c.kind} size="lg" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{c.name}</p>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                <span className="truncate">{meta.description}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => onOpen(c.id)}
              >
                Edit
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="More actions">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onSelect={() => onOpen(c.id)}>
                    <Pencil className="h-4 w-4" />Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onDuplicate(c.id)}>
                    <Copy className="h-4 w-4" />Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => onDelete(c.id)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </motion.div>
        )
      })}
    </div>
  )
}

// 3-column picker for the Add flow.
interface ConnectionsPickerProps {
  onPick: (kind: ConnectionKind) => void
}

function ConnectionsPicker({ onPick }: ConnectionsPickerProps) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const entries = (Object.entries(CONNECTION_CATALOG) as [ConnectionKind, typeof CONNECTION_CATALOG[ConnectionKind]][])
    .filter(([, meta]) => !q
      || meta.name.toLowerCase().includes(q)
      || meta.description.toLowerCase().includes(q))

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-4">
      <div className="flex items-center justify-end">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search connections…"
        />
      </div>
      {entries.length === 0 ? (
        <EmptyState title="No matches" body={`No connections match “${q}”.`} />
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {entries.map(([kind, meta], i) => (
            <motion.button
              key={kind}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.03, duration: 0.18, ease: 'easeOut' }}
              onClick={() => onPick(kind)}
              className="group flex flex-col items-start gap-2 rounded-xl border bg-background p-4 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
            >
              <ConnectionGlyph kind={kind} size="lg" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{meta.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{meta.description}</p>
              </div>
            </motion.button>
          ))}
        </div>
      )}
    </div>
  )
}

// Shared config form for new + edit. Same sticky-footer layout as AgentDetail.
interface ConnectionDetailProps {
  connections: Connection[]
  focus: Extract<ConnectionsFocus, { mode: 'new' } | { mode: 'edit' }>
  onSave: (connection: Connection) => void
  onCancel: () => void
}

function ConnectionDetail({ connections, focus, onSave, onCancel }: ConnectionDetailProps) {
  const existing = focus.mode === 'edit' ? connections.find(c => c.id === focus.id) : undefined
  const kind: ConnectionKind = existing?.kind ?? (focus.mode === 'new' ? focus.kind : 'claude')
  const meta = CONNECTION_CATALOG[kind]

  const [name, setName]       = useState(existing?.name ?? meta.name)
  const [apiKey, setApiKey]   = useState(existing?.apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(
    existing?.baseUrl ?? (kind === 'claude' ? 'https://api.anthropic.com'
      : kind === 'chatgpt' ? 'https://api.openai.com/v1' : ''),
  )

  const handleSave = () => {
    onSave({
      id: existing?.id ?? `conn-${kind}-${Date.now()}`,
      kind,
      name: name.trim() || meta.name,
      apiKey: apiKey.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      enabled: existing?.enabled ?? true,
    })
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrolledUnder, setScrolledUnder] = useState(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => {
      setScrolledUnder(el.scrollHeight > el.clientHeight + el.scrollTop + 1)
    }
    update()
    el.addEventListener('scroll', update)
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', update); ro.disconnect() }
  }, [])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-4">
        <div className="flex items-center gap-3">
          <ConnectionGlyph kind={kind} size="lg" />
          <div>
            <p className="text-sm font-medium">{meta.name}</p>
            <p className="text-xs text-muted-foreground">{meta.description}</p>
          </div>
        </div>

        <Field label="Display name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder={meta.name} />
        </Field>

        <Field label="API key" help="Stored locally. Used to authenticate against the service.">
          <Input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={kind === 'claude' ? 'sk-ant-…' : kind === 'chatgpt' ? 'sk-…' : 'Paste the API key or token'}
          />
        </Field>

        <Field label="Base URL" help="Override only if proxying through a gateway.">
          <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://…" />
        </Field>
      </div>

      <div
        className={cn(
          'shrink-0 p-4 flex items-center justify-end gap-2 border-t border-transparent',
          scrolledUnder && 'border-border',
        )}
      >
        <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={handleSave}>
          {focus.mode === 'new' ? 'Add connection' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

// Icon chip. Uses real brand marks for Claude/ChatGPT and the catalog
// emoji for anything else.
function ConnectionGlyph({ kind, size = 'md' }: { kind: ConnectionKind; size?: 'sm' | 'md' | 'lg' }) {
  const box = size === 'sm' ? 'h-5 w-5' : size === 'lg' ? 'h-10 w-10' : 'h-8 w-8'
  if (kind === 'claude') {
    const mark = size === 'sm' ? 'h-3 w-3' : size === 'lg' ? 'h-[22px] w-[22px]' : 'h-[18px] w-[18px]'
    return (
      <span className={cn('shrink-0 rounded-lg flex items-center justify-center bg-[#F5E6DA] text-[#CC785C]', box)}>
        <ClaudeLogo className={mark} />
      </span>
    )
  }
  if (kind === 'chatgpt') {
    const mark = size === 'sm' ? 'h-3 w-3' : size === 'lg' ? 'h-[22px] w-[22px]' : 'h-[18px] w-[18px]'
    return (
      <span className={cn('shrink-0 rounded-lg flex items-center justify-center bg-black text-white', box)}>
        <OpenAILogo className={mark} />
      </span>
    )
  }
  const meta = CONNECTION_CATALOG[kind]
  const text = size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-lg' : 'text-base'
  return (
    <span className={cn('shrink-0 rounded-lg flex items-center justify-center bg-muted', box, text)}>
      {meta.icon}
    </span>
  )
}

// ── Preferences ──────────────────────────────────────────────────────────────

type DefaultView = 'desk' | 'chats' | 'context'

function PreferencesSection() {
  const [autoSave, setAutoSave]           = useState(true)
  const [defaultView, setDefaultView]     = useState<DefaultView>('desk')
  const [showBadges, setShowBadges]       = useState(true)

  const VIEW_OPTIONS: { value: DefaultView; label: string }[] = [
    { value: 'desk',    label: 'Desk'    },
    { value: 'chats',   label: 'Chats'   },
    { value: 'context', label: 'Library' },
  ]

  return (
    <div className="space-y-4">
      {/* Auto-save */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Auto-save artifacts</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Automatically save artifacts created in chats to your Desk.
          </p>
        </div>
        <div className="flex items-center h-7 bg-muted rounded-full p-0.5 w-36 shrink-0">
          {([true, false] as const).map(val => (
            <button key={String(val)} onClick={() => setAutoSave(val)}
              className={`flex-1 rounded-full text-xs font-medium transition-colors h-full flex items-center justify-center ${
                autoSave === val ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}>
              {val ? 'Enabled' : 'Disabled'}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t" />

      {/* Unread badges */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Show unread badges</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Display unread counts on workspace tabs and nav items.
          </p>
        </div>
        <div className="flex items-center h-7 bg-muted rounded-full p-0.5 w-36 shrink-0">
          {([true, false] as const).map(val => (
            <button key={String(val)} onClick={() => setShowBadges(val)}
              className={`flex-1 rounded-full text-xs font-medium transition-colors h-full flex items-center justify-center ${
                showBadges === val ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}>
              {val ? 'Enabled' : 'Disabled'}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t" />

      {/* Default view */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Default view</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            The view shown when you switch to this workspace.
          </p>
        </div>
        <div className="w-36 shrink-0">
          <SelectDropdown
            value={defaultView}
            placeholder="Select view"
            onChange={(v) => setDefaultView(v as DefaultView)}
            options={VIEW_OPTIONS}
          />
        </div>
      </div>
    </div>
  )
}

// ── Main modal ───────────────────────────────────────────────────────────────

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: WorkspaceInfo
  onUpdateWorkspace: (ws: WorkspaceInfo) => void
  onDeleteWorkspace: () => void
}

export function SettingsModal({
  open,
  onOpenChange,
  workspace,
  onUpdateWorkspace,
  onDeleteWorkspace,
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<NavSection>('workspace')

  // Agents section state
  const [agentsFocus, setAgentsFocus]             = useState<AgentsFocus>(null)
  const [providers]                               = useState<Provider[]>(MOCK_PROVIDERS)
  const [agents, setAgents]                       = useState<SettingsAgent[]>(MOCK_SETTINGS_AGENTS)
  const [agentsSearch, setAgentsSearch]           = useState('')
  const [agentsStatusFilter, setAgentsStatusFilter] = useState<StatusFilter>('all')

  const setAgentsFocusAndReset = (next: AgentsFocus) => {
    setAgentsFocus(next)
    setAgentsSearch('')
  }

  const handleSaveAgent = (agent: SettingsAgent) => {
    setAgents(prev => {
      const exists = prev.some(a => a.id === agent.id)
      return exists ? prev.map(a => a.id === agent.id ? agent : a) : [...prev, agent]
    })
    setAgentsFocus(null)
  }
  const handleDeleteAgent = (id: string) => {
    setAgents(prev => prev.filter(a => a.id !== id))
    setAgentsFocus(null)
  }
  const handleDuplicateAgent = (id: string) => {
    setAgents(prev => {
      const source = prev.find(a => a.id === id)
      if (!source) return prev
      const copy: SettingsAgent = {
        ...source,
        id: `sa-${Date.now()}`,
        name: `${source.name} (copy)`,
      }
      const i = prev.findIndex(a => a.id === id)
      return [...prev.slice(0, i + 1), copy, ...prev.slice(i + 1)]
    })
  }
  const handleToggleAgentEnabled = (id: string) => {
    setAgents(prev => prev.map(a => a.id === id ? { ...a, enabled: !a.enabled } : a))
  }

  // Connections section state
  const [connectionsFocus, setConnectionsFocus]             = useState<ConnectionsFocus>(null)
  const [connections, setConnections]                       = useState<Connection[]>(MOCK_CONNECTIONS)
  const [connectionsSearch, setConnectionsSearch]           = useState('')
  const [connectionsStatusFilter, setConnectionsStatusFilter] = useState<StatusFilter>('all')

  const setConnectionsFocusAndReset = (next: ConnectionsFocus) => {
    setConnectionsFocus(next)
    setConnectionsSearch('')
  }

  const handleSaveConnection = (conn: Connection) => {
    setConnections(prev => {
      const exists = prev.some(c => c.id === conn.id)
      return exists ? prev.map(c => c.id === conn.id ? conn : c) : [...prev, conn]
    })
    setConnectionsFocus(null)
  }
  const handleDeleteConnection = (id: string) => {
    setConnections(prev => prev.filter(c => c.id !== id))
    setConnectionsFocus(null)
  }
  const handleDuplicateConnection = (id: string) => {
    setConnections(prev => {
      const source = prev.find(c => c.id === id)
      if (!source) return prev
      const copy: Connection = {
        ...source,
        id: `conn-${Date.now()}`,
        name: `${source.name} (copy)`,
      }
      const i = prev.findIndex(c => c.id === id)
      return [...prev.slice(0, i + 1), copy, ...prev.slice(i + 1)]
    })
  }
  const handleToggleConnectionEnabled = (id: string) => {
    setConnections(prev => prev.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c))
  }

  // A stable per-page key so content transitions play when navigating
  // between sections or drilling into / out of detail screens.
  const routeKey = (() => {
    if (activeSection === 'agents') {
      if (agentsFocus === null) return 'agents:list'
      if (agentsFocus.mode === 'new') return 'agents:new'
      return `agents:edit:${agentsFocus.id}`
    }
    if (activeSection === 'connections') {
      if (connectionsFocus === null) return 'connections:list'
      if (connectionsFocus.mode === 'picker') return 'connections:picker'
      if (connectionsFocus.mode === 'new') return `connections:new:${connectionsFocus.kind}`
      return `connections:edit:${connectionsFocus.id}`
    }
    return activeSection
  })()

  const renderHeaderBreadcrumb = () => {
    const pageClass = 'text-sm font-semibold text-foreground'

    if (activeSection === 'agents') {
      const leafLabel = agentsFocus === null
        ? null
        : agentsFocus.mode === 'new'
          ? 'New agent'
          : agents.find(a => a.id === agentsFocus.id)?.name ?? 'Agent'

      return (
        <Breadcrumb className="min-w-0">
          <BreadcrumbList>
            <BreadcrumbItem>
              {leafLabel === null ? (
                <BreadcrumbPage className={pageClass}>Agents</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild className={pageClass}>
                  <button
                    type="button"
                    onClick={() => { setAgentsFocus(null); setAgentsSearch('') }}
                  >
                    Agents
                  </button>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {leafLabel && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className={cn(pageClass, 'truncate')}>{leafLabel}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      )
    }

    if (activeSection === 'connections') {
      // Layers: Connections › (New | <name>) › <leaf connection name>
      const atNew   = connectionsFocus?.mode === 'picker' || connectionsFocus?.mode === 'new'
      const leaf    = connectionsFocus?.mode === 'new'
        ? CONNECTION_CATALOG[connectionsFocus.kind].name
        : connectionsFocus?.mode === 'edit'
          ? connections.find(c => c.id === connectionsFocus.id)?.name ?? 'Connection'
          : null

      return (
        <Breadcrumb className="min-w-0">
          <BreadcrumbList>
            <BreadcrumbItem>
              {connectionsFocus === null ? (
                <BreadcrumbPage className={pageClass}>Connections</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild className={pageClass}>
                  <button
                    type="button"
                    onClick={() => { setConnectionsFocus(null); setConnectionsSearch('') }}
                  >
                    Connections
                  </button>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {atNew && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {connectionsFocus?.mode === 'picker' ? (
                    <BreadcrumbPage className={pageClass}>New</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild className={pageClass}>
                      <button
                        type="button"
                        onClick={() => setConnectionsFocus({ mode: 'picker' })}
                      >
                        New
                      </button>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </>
            )}
            {leaf && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className={cn(pageClass, 'truncate')}>{leaf}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      )
    }

    return (
      <Breadcrumb className="min-w-0">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage className={pageClass}>
              {NAV.find(n => n.id === activeSection)?.label}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0 gap-0 sm:max-w-[900px] overflow-hidden"
        showCloseButton={false}
        style={{ height: '620px' }}
      >
        {/* Hidden title for accessibility */}
        <DialogTitle className="sr-only">Workspace settings</DialogTitle>

        <div className="flex h-full">
          {/* Left nav */}
          <div className="w-52 shrink-0 flex flex-col border-r bg-muted/30">
            <div className="px-4 pt-5 pb-3">
              {/* Workspace identity */}
              <div className="flex items-center gap-2">
                <div
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm"
                  style={{ backgroundColor: workspace.bg }}
                >
                  {workspace.emoji}
                </div>
                <span className="text-sm font-semibold truncate">{workspace.name}</span>
              </div>
            </div>

            <nav className="flex-1 px-2 space-y-0.5">
              {NAV.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveSection(id)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                    activeSection === id
                      ? 'bg-muted text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {/* Right content */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Header: breadcrumbs + close */}
            <div className="h-[52px] flex items-center justify-between gap-3 border-b px-4 shrink-0">
              {renderHeaderBreadcrumb()}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground shrink-0"
                onClick={() => onOpenChange(false)}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Content. Detail / picker / workspace-edit screens take over
                the full content area to support sticky footers and custom
                layouts. Lists and preferences live inside the padded scroll
                body. Each route gets a fresh motion.div so it fades in when
                navigating between pages. */}
            <motion.div
              key={routeKey}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="flex-1 flex flex-col min-h-0"
            >
              {activeSection === 'workspace' ? (
                <WorkspaceSection
                  workspace={workspace}
                  onUpdate={ws => { onUpdateWorkspace(ws); onOpenChange(false) }}
                  onDelete={() => { onDeleteWorkspace(); onOpenChange(false) }}
                />
              ) : activeSection === 'agents' && agentsFocus !== null ? (
                <AgentDetail
                  agents={agents}
                  providers={providers}
                  focus={agentsFocus}
                  onSave={handleSaveAgent}
                  onCancel={() => setAgentsFocus(null)}
                />
              ) : activeSection === 'connections' && connectionsFocus?.mode === 'picker' ? (
                <ConnectionsPicker
                  onPick={(kind) => setConnectionsFocus({ mode: 'new', kind })}
                />
              ) : activeSection === 'connections' && (connectionsFocus?.mode === 'new' || connectionsFocus?.mode === 'edit') ? (
                <ConnectionDetail
                  connections={connections}
                  focus={connectionsFocus}
                  onSave={handleSaveConnection}
                  onCancel={() => setConnectionsFocus(null)}
                />
              ) : (
                <div className="flex-1 overflow-y-auto px-4 pt-3 pb-6">
                  {activeSection === 'agents' && (
                    <AgentsSection
                      providers={providers}
                      agents={agents}
                      search={agentsSearch}
                      statusFilter={agentsStatusFilter}
                      onSearchChange={setAgentsSearch}
                      onStatusFilterChange={setAgentsStatusFilter}
                      onFocus={setAgentsFocusAndReset}
                      onDeleteAgent={handleDeleteAgent}
                      onDuplicateAgent={handleDuplicateAgent}
                      onToggleEnabled={handleToggleAgentEnabled}
                    />
                  )}
                  {activeSection === 'connections' && (
                    <ConnectionsSection
                      connections={connections}
                      search={connectionsSearch}
                      statusFilter={connectionsStatusFilter}
                      onSearchChange={setConnectionsSearch}
                      onStatusFilterChange={setConnectionsStatusFilter}
                      onFocus={setConnectionsFocusAndReset}
                      onDeleteConnection={handleDeleteConnection}
                      onDuplicateConnection={handleDuplicateConnection}
                      onToggleEnabled={handleToggleConnectionEnabled}
                    />
                  )}
                  {activeSection === 'preferences' && <PreferencesSection />}
                </div>
              )}
            </motion.div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
