import { useMemo, useState } from 'react'
import {
  Settings2, Bot, Plug, Sliders,
  Trash2, Plus, ChevronDown, X, Search,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import {
  MOCK_PROVIDERS,
  MOCK_SETTINGS_AGENTS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
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

// ── Mock connections ─────────────────────────────────────────────────────────

interface Connection {
  id: string
  name: string
  description: string
  icon: string
}

const ALL_CONNECTIONS: Connection[] = [
  { id: 'google-drive',  name: 'Google Drive',    description: 'Docs, Sheets and Slides',          icon: '📁' },
  { id: 'notion',        name: 'Notion',           description: 'Pages and databases',              icon: '📝' },
  { id: 'github',        name: 'GitHub',           description: 'Repositories and issues',         icon: '🐙' },
  { id: 'slack',         name: 'Slack',            description: 'Messages and channels',            icon: '💬' },
  { id: 'figma',         name: 'Figma',            description: 'Design files and prototypes',     icon: '🎨' },
  { id: 'linear',        name: 'Linear',           description: 'Issues, projects and cycles',     icon: '🔷' },
  { id: 'web-clipper',   name: 'Web Clipper',      description: 'Save pages from your browser',   icon: '🌐' },
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

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-0.5">Workspace details</h3>
        <p className="text-xs text-muted-foreground">Name, icon and description for this workspace.</p>
      </div>

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

      {/* Actions */}
      <div className="flex items-center justify-between pt-2 border-t">
        {/* Delete with popover confirm */}
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

interface AgentsSectionProps {
  focus: AgentsFocus
  providers: Provider[]
  agents: SettingsAgent[]
  search: string
  onFocus: (next: AgentsFocus) => void
  onSaveAgent: (agent: SettingsAgent) => void
  onDeleteAgent: (id: string) => void
}

function AgentsSection({
  view, focus, providers, agents, search,
  onFocus,
  onSaveAgent, onDeleteAgent,
}: AgentsSectionProps) {
  if (focus !== null) {
    return (
      <AgentDetail
        agents={agents}
        providers={providers}
        focus={focus}
        onSave={onSaveAgent}
        onCancel={() => onFocus(null)}
      />
    )
  }

  const q = search.trim().toLowerCase()
  const filteredAgents = q
    ? agents.filter(a => {
        const providerName = providers.find(p => p.id === a.providerId)?.name ?? ''
        return a.name.toLowerCase().includes(q)
          || a.model.toLowerCase().includes(q)
          || providerName.toLowerCase().includes(q)
      })
    : agents

  return (
    <AgentsList
      agents={filteredAgents}
      providers={providers}
      hasAnyAgents={agents.length > 0}
      hasAnyProviders={providers.length > 0}
      query={q}
      onOpen={(id) => onFocus({ mode: 'edit', id })}
      onAdd={() => onFocus({ mode: 'new' })}
      onDelete={onDeleteAgent}
    />
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
}

function AgentsList({
  agents, providers, hasAnyAgents, hasAnyProviders, query, onOpen, onAdd, onDelete,
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
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onAdd}>
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="px-0">Name</TableHead>
          <TableHead className="px-0">Provider</TableHead>
          <TableHead className="px-0">Model</TableHead>
          <TableHead className="px-0 w-0" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map(a => {
          const provider = providers.find(p => p.id === a.providerId)
          const providerLabel = provider ? PROVIDER_LABELS[provider.kind] : 'Unlinked'
          return (
            <TableRow key={a.id}>
              <TableCell className="px-0 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  {provider
                    ? <ProviderGlyph kind={provider.kind} size="sm" />
                    : <span className="h-5 w-5 shrink-0 rounded-md bg-muted" />
                  }
                  <span className="text-sm font-medium truncate">{a.name}</span>
                </div>
              </TableCell>
              <TableCell className="px-0 py-2 text-muted-foreground">
                {providerLabel}
              </TableCell>
              <TableCell className="px-0 py-2 text-muted-foreground">
                {a.model}
              </TableCell>
              <TableCell className="px-0 py-2 w-0">
                <div className="flex items-center justify-end gap-1.5">
                  <Button variant="outline" size="xs" onClick={() => onOpen(a.id)}>Edit</Button>
                  <Button variant="outline" size="xs" onClick={() => onDelete(a.id)}>Delete</Button>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
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
    })
  }

  return (
    <div className="space-y-5 max-w-xl">
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
          rows={4}
          className="resize-none"
        />
      </Field>

      <div className="flex items-center justify-end gap-2 pt-2 border-t">
        <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={handleSave} disabled={!canSave}>
          {focus.mode === 'new' ? 'Add agent' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

function ProviderGlyph({ kind, size = 'md' }: { kind: ProviderKind; size?: 'sm' | 'md' }) {
  const box  = size === 'sm' ? 'h-5 w-5' : 'h-8 w-8'
  const mark = size === 'sm' ? 'h-3 w-3' : 'h-[18px] w-[18px]'
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

// ── Connections ──────────────────────────────────────────────────────────────

function ConnectionsSection() {
  const [enabled, setEnabled] = useState<Set<string>>(
    new Set(['google-drive', 'notion'])
  )

  const toggle = (id: string) =>
    setEnabled(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-0.5">Connections</h3>
        <p className="text-xs text-muted-foreground">
          Connected sources appear in this workspace's library and can be referenced in chats.
        </p>
      </div>

      <div className="space-y-1">
        {ALL_CONNECTIONS.map(conn => (
          <div
            key={conn.id}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/40 transition-colors"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-base">
              {conn.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{conn.name}</p>
              <p className="text-xs text-muted-foreground">{conn.description}</p>
            </div>
            <Switch
              checked={enabled.has(conn.id)}
              onCheckedChange={() => toggle(conn.id)}
            />
          </div>
        ))}
      </div>
    </div>
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
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-0.5">Preferences</h3>
        <p className="text-xs text-muted-foreground">Behaviour settings for this workspace.</p>
      </div>

      <div className="space-y-4">

        {/* Auto-save */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Auto-save artifacts</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Automatically save artifacts created in chats to your Desk.
            </p>
          </div>
          <Switch checked={autoSave} onCheckedChange={setAutoSave} />
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
          <Switch checked={showBadges} onCheckedChange={setShowBadges} />
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
          <div className="flex rounded-md border overflow-hidden shrink-0">
            {VIEW_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setDefaultView(opt.value)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  defaultView === opt.value
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
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
  const [agentsFocus, setAgentsFocus]   = useState<AgentsFocus>(null)
  const [providers]                     = useState<Provider[]>(MOCK_PROVIDERS)
  const [agents, setAgents]             = useState<SettingsAgent[]>(MOCK_SETTINGS_AGENTS)
  const [agentsSearch, setAgentsSearch] = useState('')

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

  const renderHeaderBreadcrumb = () => {
    const pageClass = 'text-sm font-semibold text-foreground'

    if (activeSection !== 'agents') {
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
              <BreadcrumbLink asChild>
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

  const showAgentsToolbar = activeSection === 'agents' && agentsFocus === null

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
              <div className="flex items-center gap-2 mb-4">
                <div
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm"
                  style={{ backgroundColor: workspace.bg }}
                >
                  {workspace.emoji}
                </div>
                <span className="text-sm font-semibold truncate">{workspace.name}</span>
              </div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5">
                Settings
              </p>
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
            {/* Header: breadcrumbs + inline actions + close */}
            <div className="h-[52px] flex items-center justify-between gap-3 border-b px-4 shrink-0">
              {renderHeaderBreadcrumb()}
              <div className="flex items-center gap-2 shrink-0">
                {showAgentsToolbar && (
                  <>
                    <SearchInput
                      value={agentsSearch}
                      onChange={setAgentsSearch}
                      placeholder="Search agents…"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setAgentsFocusAndReset({ mode: 'new' })}
                    >
                      <Plus className="h-3.5 w-3.5" />Add
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  onClick={() => onOpenChange(false)}
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-4 py-6">
              {activeSection === 'workspace' && (
                <WorkspaceSection
                  workspace={workspace}
                  onUpdate={ws => { onUpdateWorkspace(ws); onOpenChange(false) }}
                  onDelete={() => { onDeleteWorkspace(); onOpenChange(false) }}
                />
              )}
              {activeSection === 'agents' && (
                <AgentsSection
                  focus={agentsFocus}
                  providers={providers}
                  agents={agents}
                  search={agentsSearch}
                  onFocus={setAgentsFocusAndReset}
                  onSaveAgent={handleSaveAgent}
                  onDeleteAgent={handleDeleteAgent}
                />
              )}
              {activeSection === 'connections' && <ConnectionsSection />}
              {activeSection === 'preferences' && <PreferencesSection />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
