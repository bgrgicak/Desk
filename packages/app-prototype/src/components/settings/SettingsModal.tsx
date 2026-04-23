import { useMemo, useState } from 'react'
import {
  Settings2, Bot, Plug, Sliders,
  Trash2, Plus, ChevronDown, X,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
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
  MOCK_PROVIDERS,
  MOCK_SETTINGS_AGENTS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  type Provider,
  type ProviderKind,
  type SettingsAgent,
} from '@/data/mock-data'
import type { WorkspaceInfo } from '@/components/layout/WorkspaceBar'

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

// ── Agents section: Agents + Providers tabs ─────────────────────────────────

type AgentsTab = 'agents' | 'providers'

type AgentsFocus =
  | { kind: 'agent'; mode: 'edit'; id: string }
  | { kind: 'agent'; mode: 'new' }
  | { kind: 'provider'; mode: 'edit'; id: string }
  | { kind: 'provider'; mode: 'new'; providerKind: ProviderKind }
  | null

function AgentsSection() {
  const [tab, setTab]             = useState<AgentsTab>('agents')
  const [focus, setFocus]         = useState<AgentsFocus>(null)
  const [providers, setProviders] = useState<Provider[]>(MOCK_PROVIDERS)
  const [agents, setAgents]       = useState<SettingsAgent[]>(MOCK_SETTINGS_AGENTS)

  const handleTabChange = (next: string) => {
    setTab(next as AgentsTab)
    setFocus(null)
  }

  if (focus === null) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-sm font-semibold mb-0.5">Agents</h3>
          <p className="text-xs text-muted-foreground">
            Manage the agents you use and the providers that power them.
          </p>
        </div>

        <Tabs value={tab} onValueChange={handleTabChange} className="gap-4">
          <div className="flex items-center justify-between">
            <TabsList>
              <TabsTrigger value="agents">Agents</TabsTrigger>
              <TabsTrigger value="providers">Providers</TabsTrigger>
            </TabsList>
            {tab === 'agents' ? (
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => setFocus({ kind: 'agent', mode: 'new' })}
              >
                <Plus className="h-3.5 w-3.5" />Add
              </Button>
            ) : (
              <AddProviderButton
                existing={providers}
                onPick={(k) => setFocus({ kind: 'provider', mode: 'new', providerKind: k })}
              />
            )}
          </div>

          <TabsContent value="agents">
            <AgentsList
              agents={agents}
              providers={providers}
              onOpen={(id) => setFocus({ kind: 'agent', mode: 'edit', id })}
              onAdd={() => setFocus({ kind: 'agent', mode: 'new' })}
            />
          </TabsContent>

          <TabsContent value="providers">
            <ProvidersList
              providers={providers}
              onOpen={(id) => setFocus({ kind: 'provider', mode: 'edit', id })}
              onPickNew={(k) => setFocus({ kind: 'provider', mode: 'new', providerKind: k })}
            />
          </TabsContent>
        </Tabs>
      </div>
    )
  }

  // Drilled-in detail view: breadcrumb back to list, then the form
  const tabLabel   = focus.kind === 'agent' ? 'Agents' : 'Providers'
  const leafLabel  = focus.kind === 'agent'
    ? (focus.mode === 'new' ? 'New agent' : agents.find(a => a.id === focus.id)?.name ?? 'Agent')
    : (focus.mode === 'new'
        ? `New ${PROVIDER_LABELS[focus.providerKind]} provider`
        : providers.find(p => p.id === focus.id)?.name ?? 'Provider')

  const backToList = () => {
    setTab(focus.kind === 'agent' ? 'agents' : 'providers')
    setFocus(null)
  }

  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button type="button" onClick={backToList}>{tabLabel}</button>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{leafLabel}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {focus.kind === 'agent' ? (
        <AgentDetail
          agents={agents}
          providers={providers}
          focus={focus}
          onSave={(agent) => {
            setAgents(prev => {
              const exists = prev.some(a => a.id === agent.id)
              return exists ? prev.map(a => a.id === agent.id ? agent : a) : [...prev, agent]
            })
            setFocus(null)
          }}
          onCancel={backToList}
          onDelete={(id) => {
            setAgents(prev => prev.filter(a => a.id !== id))
            setFocus(null)
          }}
        />
      ) : (
        <ProviderDetail
          providers={providers}
          focus={focus}
          onSave={(provider) => {
            setProviders(prev => {
              const exists = prev.some(p => p.id === provider.id)
              return exists ? prev.map(p => p.id === provider.id ? provider : p) : [...prev, provider]
            })
            setFocus(null)
          }}
          onCancel={backToList}
          onDelete={(id) => {
            setProviders(prev => prev.filter(p => p.id !== id))
            // Agents bound to the removed provider lose their link; drop them.
            setAgents(prev => prev.filter(a => a.providerId !== id))
            setFocus(null)
          }}
        />
      )}
    </div>
  )
}

// ── Agents list + detail ─────────────────────────────────────────────────────

interface AgentsListProps {
  agents: SettingsAgent[]
  providers: Provider[]
  onOpen: (id: string) => void
  onAdd: () => void
}

function AgentsList({ agents, providers, onOpen, onAdd }: AgentsListProps) {
  if (providers.length === 0) {
    return (
      <EmptyState
        title="Add a provider first"
        body="Agents run through a provider. Add Claude or ChatGPT on the Providers tab to get started."
      />
    )
  }
  if (agents.length === 0) {
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
  return (
    <div className="space-y-1">
      {agents.map(a => {
        const provider = providers.find(p => p.id === a.providerId)
        return (
          <button
            key={a.id}
            onClick={() => onOpen(a.id)}
            className="flex w-full items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/40 transition-colors text-left"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Bot className="h-4 w-4 text-muted-foreground/70" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{a.name}</p>
              <p className="text-xs text-muted-foreground truncate">{a.model}</p>
            </div>
            <span className="text-xs text-muted-foreground shrink-0">
              {provider ? PROVIDER_LABELS[provider.kind] : 'Unlinked'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

interface AgentDetailProps {
  agents: SettingsAgent[]
  providers: Provider[]
  focus: Extract<AgentsFocus, { kind: 'agent' }>
  onSave: (agent: SettingsAgent) => void
  onCancel: () => void
  onDelete: (id: string) => void
}

function AgentDetail({ agents, providers, focus, onSave, onCancel, onDelete }: AgentDetailProps) {
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

      <div className="flex items-center justify-between pt-2 border-t">
        <div>
          {focus.mode === 'edit' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive gap-1.5"
              onClick={() => onDelete(focus.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />Delete
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave}>
            {focus.mode === 'new' ? 'Add agent' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Providers list + Add popover + detail ────────────────────────────────────

interface ProvidersListProps {
  providers: Provider[]
  onOpen: (id: string) => void
  onPickNew: (kind: ProviderKind) => void
}

function ProvidersList({ providers, onOpen, onPickNew }: ProvidersListProps) {
  if (providers.length === 0) {
    return (
      <EmptyState
        title="No providers yet"
        body="Add an API key for Claude or ChatGPT to start creating agents."
        action={<AddProviderButton existing={providers} onPick={onPickNew} />}
      />
    )
  }
  return (
    <div className="space-y-1">
      {providers.map(p => (
        <button
          key={p.id}
          onClick={() => onOpen(p.id)}
          className="flex w-full items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/40 transition-colors text-left"
        >
          <ProviderGlyph kind={p.kind} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{p.name}</p>
            <p className="text-xs text-muted-foreground truncate">
              {PROVIDER_LABELS[p.kind]} · {p.apiKey ? 'API key set' : 'No API key'}
            </p>
          </div>
        </button>
      ))}
    </div>
  )
}

interface AddProviderButtonProps {
  existing: Provider[]
  onPick: (kind: ProviderKind) => void
}

function AddProviderButton({ existing, onPick }: AddProviderButtonProps) {
  const [open, setOpen]  = useState(false)
  const hasClaude        = existing.some(p => p.kind === 'claude')
  const hasChatGPT       = existing.some(p => p.kind === 'chatgpt')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />Add
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-1">
        <ProviderPickerItem
          kind="chatgpt"
          label="ChatGPT"
          disabled={hasChatGPT}
          onClick={() => { onPick('chatgpt'); setOpen(false) }}
        />
        <ProviderPickerItem
          kind="claude"
          label="Claude"
          disabled={hasClaude}
          onClick={() => { onPick('claude'); setOpen(false) }}
        />
        <ProviderPickerItem
          kind="other"
          label="Other"
          disabled
          onClick={() => { /* disabled */ }}
        />
      </PopoverContent>
    </Popover>
  )
}

function ProviderPickerItem({
  kind, label, disabled, onClick,
}: { kind: ProviderKind; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md text-left transition-colors',
        disabled
          ? 'text-muted-foreground/60 cursor-not-allowed'
          : 'hover:bg-muted/60',
      )}
    >
      <ProviderGlyph kind={kind} size="sm" />
      {label}
      {disabled && <span className="ml-auto text-xs text-muted-foreground/70">
        {kind === 'other' ? 'Soon' : 'Added'}
      </span>}
    </button>
  )
}

function ProviderGlyph({ kind, size = 'md' }: { kind: ProviderKind; size?: 'sm' | 'md' }) {
  const letter = kind === 'claude' ? 'C' : kind === 'chatgpt' ? 'G' : '·'
  const bg = kind === 'claude' ? 'bg-orange-100 text-orange-700'
    : kind === 'chatgpt' ? 'bg-emerald-100 text-emerald-700'
    : 'bg-muted text-muted-foreground'
  const dim = size === 'sm' ? 'h-5 w-5 text-[11px]' : 'h-8 w-8 text-sm'
  return (
    <span className={cn('shrink-0 rounded-lg flex items-center justify-center font-semibold', dim, bg)}>
      {letter}
    </span>
  )
}

interface ProviderDetailProps {
  providers: Provider[]
  focus: Extract<AgentsFocus, { kind: 'provider' }>
  onSave: (provider: Provider) => void
  onCancel: () => void
  onDelete: (id: string) => void
}

function ProviderDetail({ providers, focus, onSave, onCancel, onDelete }: ProviderDetailProps) {
  const existing = focus.mode === 'edit' ? providers.find(p => p.id === focus.id) : undefined
  const kind: ProviderKind = existing?.kind ?? (focus.mode === 'new' ? focus.providerKind : 'other')

  const [name, setName]            = useState(existing?.name ?? PROVIDER_LABELS[kind])
  const [apiKey, setApiKey]        = useState(existing?.apiKey ?? '')
  const [organizationId, setOrgId] = useState(existing?.organizationId ?? '')
  const [baseUrl, setBaseUrl]      = useState(
    existing?.baseUrl ?? (kind === 'claude' ? 'https://api.anthropic.com'
      : kind === 'chatgpt' ? 'https://api.openai.com/v1' : ''),
  )

  const handleSave = () => {
    onSave({
      id: existing?.id ?? `prov-${kind}-${Date.now()}`,
      kind,
      name: name.trim() || PROVIDER_LABELS[kind],
      apiKey: apiKey.trim(),
      organizationId: kind === 'chatgpt' ? organizationId.trim() || undefined : undefined,
      baseUrl: baseUrl.trim() || undefined,
    })
  }

  return (
    <div className="space-y-5 max-w-xl">
      <div className="flex items-center gap-3">
        <ProviderGlyph kind={kind} />
        <div>
          <p className="text-sm font-medium">{PROVIDER_LABELS[kind]} provider</p>
          <p className="text-xs text-muted-foreground">
            {kind === 'claude' && 'Connects Claude models (Sonnet, Opus, Haiku) via the Anthropic API.'}
            {kind === 'chatgpt' && 'Connects OpenAI models (GPT-4o, GPT-4o mini) via the OpenAI API.'}
            {kind === 'other' && 'Custom provider.'}
          </p>
        </div>
      </div>

      <Field label="Display name">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder={PROVIDER_LABELS[kind]} />
      </Field>

      <Field label="API key" help="Stored locally. Used to authenticate against the provider.">
        <Input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder={kind === 'claude' ? 'sk-ant-…' : kind === 'chatgpt' ? 'sk-…' : ''}
        />
      </Field>

      {kind === 'chatgpt' && (
        <Field label="Organization ID" help="Optional. Used for billing isolation on multi-org accounts.">
          <Input value={organizationId} onChange={e => setOrgId(e.target.value)} placeholder="org-…" />
        </Field>
      )}

      <Field label="Base URL" help="Override only if proxying through a gateway.">
        <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
      </Field>

      <div className="flex items-center justify-between pt-2 border-t">
        <div>
          {focus.mode === 'edit' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive gap-1.5"
              onClick={() => onDelete(focus.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />Remove
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={handleSave}>
            {focus.mode === 'new' ? 'Add provider' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
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
            {/* Header: breadcrumbs + close */}
            <div className="flex items-center justify-between h-12 px-5 border-b shrink-0">
              <nav className="flex items-center gap-1.5 text-sm text-muted-foreground min-w-0">
                <span className="text-foreground font-medium truncate">
                  {NAV.find(n => n.id === activeSection)?.label}
                </span>
              </nav>
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

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto p-6">
              {activeSection === 'workspace' && (
                <WorkspaceSection
                  workspace={workspace}
                  onUpdate={ws => { onUpdateWorkspace(ws); onOpenChange(false) }}
                  onDelete={() => { onDeleteWorkspace(); onOpenChange(false) }}
                />
              )}
              {activeSection === 'agents' && <AgentsSection />}
              {activeSection === 'connections' && <ConnectionsSection />}
              {activeSection === 'preferences' && <PreferencesSection />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
