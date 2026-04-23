import { useMemo, useState } from 'react'
import { Bot, Plus, Trash2, ChevronDown } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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

// ─── Types ────────────────────────────────────────────────────────────────────

type SettingsTab = 'agents' | 'providers'

type Focus =
  | { kind: 'agent'; mode: 'edit'; id: string }
  | { kind: 'agent'; mode: 'new' }
  | { kind: 'provider'; mode: 'edit'; id: string }
  | { kind: 'provider'; mode: 'new'; providerKind: ProviderKind }
  | null

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export function SettingsModal({ open, onOpenChange }: SettingsModalProps) {
  const [providers, setProviders] = useState<Provider[]>(MOCK_PROVIDERS)
  const [agents, setAgents]       = useState<SettingsAgent[]>(MOCK_SETTINGS_AGENTS)
  const [tab, setTab]             = useState<SettingsTab>('agents')
  const [focus, setFocus]         = useState<Focus>(null)

  // Reset drill-in whenever the top-level tab changes
  const handleTabChange = (next: string) => {
    setTab(next as SettingsTab)
    setFocus(null)
  }

  const handleClose = (next: boolean) => {
    if (!next) {
      setFocus(null)
      setTab('agents')
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="sm:max-w-4xl p-0 gap-0 overflow-hidden"
        style={{ height: 'min(640px, 85vh)' }}
      >
        <DialogHeader className="px-6 pt-5 pb-4 border-b">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 min-h-0">
          {/* Left nav — only Agents for now */}
          <nav className="w-48 shrink-0 border-r bg-sidebar/60 px-2 py-3">
            <button
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-md bg-muted text-foreground font-medium"
            >
              <Bot className="h-4 w-4" />
              Agents
            </button>
          </nav>

          {/* Content column */}
          <div className="flex-1 flex flex-col min-w-0">
            <AgentsSection
              tab={tab}
              onTabChange={handleTabChange}
              focus={focus}
              setFocus={setFocus}
              providers={providers}
              setProviders={setProviders}
              agents={agents}
              setAgents={setAgents}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Agents section (tabs + breadcrumbs + routed content) ─────────────────────

interface AgentsSectionProps {
  tab: SettingsTab
  onTabChange: (next: string) => void
  focus: Focus
  setFocus: (next: Focus) => void
  providers: Provider[]
  setProviders: React.Dispatch<React.SetStateAction<Provider[]>>
  agents: SettingsAgent[]
  setAgents: React.Dispatch<React.SetStateAction<SettingsAgent[]>>
}

function AgentsSection({
  tab, onTabChange, focus, setFocus,
  providers, setProviders, agents, setAgents,
}: AgentsSectionProps) {
  return (
    <>
      {/* Header: breadcrumbs */}
      <div className="px-6 pt-4 pb-3 flex items-center justify-between border-b">
        <BreadcrumbTrail
          tab={tab}
          focus={focus}
          agents={agents}
          providers={providers}
          onHome={() => setFocus(null)}
        />
      </div>

      {/* Tabs + content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {focus === null ? (
          <Tabs value={tab} onValueChange={onTabChange} className="gap-4">
            <div className="flex items-center justify-between">
              <TabsList>
                <TabsTrigger value="agents">Agents</TabsTrigger>
                <TabsTrigger value="providers">Providers</TabsTrigger>
              </TabsList>
              {tab === 'agents' && (
                <Button size="sm" onClick={() => setFocus({ kind: 'agent', mode: 'new' })}>
                  <Plus className="h-4 w-4" />Add
                </Button>
              )}
              {tab === 'providers' && (
                <AddProviderButton
                  existing={providers}
                  onPick={(kind) => setFocus({ kind: 'provider', mode: 'new', providerKind: kind })}
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
                onPickNew={(kind) => setFocus({ kind: 'provider', mode: 'new', providerKind: kind })}
              />
            </TabsContent>
          </Tabs>
        ) : focus.kind === 'agent' ? (
          <AgentDetail
            agents={agents}
            providers={providers}
            focus={focus}
            onSave={(agent) => {
              setAgents((prev) => {
                const exists = prev.some((a) => a.id === agent.id)
                return exists ? prev.map((a) => (a.id === agent.id ? agent : a)) : [...prev, agent]
              })
              setFocus(null)
            }}
            onCancel={() => setFocus(null)}
            onDelete={(id) => {
              setAgents((prev) => prev.filter((a) => a.id !== id))
              setFocus(null)
            }}
          />
        ) : (
          <ProviderDetail
            providers={providers}
            focus={focus}
            onSave={(provider) => {
              setProviders((prev) => {
                const exists = prev.some((p) => p.id === provider.id)
                return exists ? prev.map((p) => (p.id === provider.id ? provider : p)) : [...prev, provider]
              })
              setFocus(null)
            }}
            onCancel={() => setFocus(null)}
            onDelete={(id) => {
              setProviders((prev) => prev.filter((p) => p.id !== id))
              // Orphaned agents fall back to the first remaining provider
              setAgents((prev) => prev.filter((a) => a.providerId !== id))
              setFocus(null)
            }}
          />
        )}
      </div>
    </>
  )
}

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────

interface BreadcrumbTrailProps {
  tab: SettingsTab
  focus: Focus
  agents: SettingsAgent[]
  providers: Provider[]
  onHome: () => void
}

function BreadcrumbTrail({ tab, focus, agents, providers, onHome }: BreadcrumbTrailProps) {
  let leafLabel: string | null = null
  let activeTab: SettingsTab = tab
  if (focus?.kind === 'agent') {
    activeTab = 'agents'
    leafLabel = focus.mode === 'new'
      ? 'New agent'
      : agents.find((a) => a.id === focus.id)?.name ?? 'Agent'
  } else if (focus?.kind === 'provider') {
    activeTab = 'providers'
    leafLabel = focus.mode === 'new'
      ? `New ${PROVIDER_LABELS[focus.providerKind]} provider`
      : providers.find((p) => p.id === focus.id)?.name ?? 'Provider'
  }

  const tabLabel = activeTab === 'agents' ? 'Agents' : 'Providers'

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <button type="button" onClick={onHome}>Agents</button>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          {leafLabel ? (
            <BreadcrumbLink asChild>
              <button type="button" onClick={onHome}>{tabLabel}</button>
            </BreadcrumbLink>
          ) : (
            <BreadcrumbPage>{tabLabel}</BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {leafLabel && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{leafLabel}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

// ─── Providers: list + Add popover + detail ───────────────────────────────────

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
    <div className="rounded-xl border overflow-hidden">
      {providers.map((p) => (
        <button
          key={p.id}
          onClick={() => onOpen(p.id)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors border-b last:border-b-0"
        >
          <ProviderGlyph kind={p.kind} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{p.name}</div>
            <div className="text-xs text-muted-foreground truncate">
              {PROVIDER_LABELS[p.kind]} · {p.apiKey ? 'API key set' : 'No API key'}
            </div>
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
  const [open, setOpen] = useState(false)
  const hasClaude  = existing.some((p) => p.kind === 'claude')
  const hasChatGPT = existing.some((p) => p.kind === 'chatgpt')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" />Add
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <ProviderPickerItem
          label="ChatGPT"
          disabled={hasChatGPT}
          onClick={() => { onPick('chatgpt'); setOpen(false) }}
        />
        <ProviderPickerItem
          label="Claude"
          disabled={hasClaude}
          onClick={() => { onPick('claude'); setOpen(false) }}
        />
        <ProviderPickerItem
          label="Other"
          disabled
          onClick={() => { /* disabled */ }}
        />
      </PopoverContent>
    </Popover>
  )
}

function ProviderPickerItem({
  label, disabled, onClick,
}: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-sm text-left transition-colors',
        disabled
          ? 'text-muted-foreground/60 cursor-not-allowed'
          : 'hover:bg-muted',
      )}
    >
      <ProviderGlyph kind={label.toLowerCase() as ProviderKind} size="sm" />
      {label}
      {disabled && <span className="ml-auto text-xs text-muted-foreground/70">Added</span>}
    </button>
  )
}

function ProviderGlyph({ kind, size = 'md' }: { kind: ProviderKind; size?: 'sm' | 'md' }) {
  const letter = kind === 'claude' ? 'C' : kind === 'chatgpt' ? 'G' : '·'
  const bg = kind === 'claude' ? 'bg-orange-100 text-orange-700'
    : kind === 'chatgpt' ? 'bg-emerald-100 text-emerald-700'
    : 'bg-muted text-muted-foreground'
  const dim = size === 'sm' ? 'h-5 w-5 text-[11px]' : 'h-7 w-7 text-xs'
  return (
    <span className={cn('shrink-0 rounded-md flex items-center justify-center font-semibold', dim, bg)}>
      {letter}
    </span>
  )
}

interface ProviderDetailProps {
  providers: Provider[]
  focus: Extract<Focus, { kind: 'provider' }>
  onSave: (provider: Provider) => void
  onCancel: () => void
  onDelete: (id: string) => void
}

function ProviderDetail({ providers, focus, onSave, onCancel, onDelete }: ProviderDetailProps) {
  const existing = focus.mode === 'edit' ? providers.find((p) => p.id === focus.id) : undefined
  const kind: ProviderKind = existing?.kind ?? (focus.mode === 'new' ? focus.providerKind : 'other')

  const [name, setName]               = useState(existing?.name ?? PROVIDER_LABELS[kind])
  const [apiKey, setApiKey]           = useState(existing?.apiKey ?? '')
  const [organizationId, setOrgId]    = useState(existing?.organizationId ?? '')
  const [baseUrl, setBaseUrl]         = useState(
    existing?.baseUrl ?? (kind === 'claude' ? 'https://api.anthropic.com'
      : kind === 'chatgpt' ? 'https://api.openai.com/v1' : ''),
  )

  const handleSave = () => {
    const next: Provider = {
      id: existing?.id ?? `prov-${kind}-${Date.now()}`,
      kind,
      name: name.trim() || PROVIDER_LABELS[kind],
      apiKey: apiKey.trim(),
      organizationId: kind === 'chatgpt' ? organizationId.trim() || undefined : undefined,
      baseUrl: baseUrl.trim() || undefined,
    }
    onSave(next)
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div className="flex items-center gap-3">
        <ProviderGlyph kind={kind} />
        <div>
          <div className="text-sm font-medium">{PROVIDER_LABELS[kind]} provider</div>
          <div className="text-xs text-muted-foreground">
            {kind === 'claude' && 'Connects Claude models (Sonnet, Opus, Haiku) via the Anthropic API.'}
            {kind === 'chatgpt' && 'Connects OpenAI models (GPT-4o, GPT-4o mini) via the OpenAI API.'}
            {kind === 'other' && 'Custom provider.'}
          </div>
        </div>
      </div>

      <Field label="Display name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={PROVIDER_LABELS[kind]} />
      </Field>

      <Field label="API key" help="Stored locally. Used to authenticate against the provider.">
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={kind === 'claude' ? 'sk-ant-…' : kind === 'chatgpt' ? 'sk-…' : ''}
        />
      </Field>

      {kind === 'chatgpt' && (
        <Field label="Organization ID" help="Optional. Used for billing isolation on multi-org accounts.">
          <Input value={organizationId} onChange={(e) => setOrgId(e.target.value)} placeholder="org-…" />
        </Field>
      )}

      <Field label="Base URL" help="Override only if proxying through a gateway.">
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>

      <div className="flex items-center justify-between pt-2 border-t">
        <div>
          {focus.mode === 'edit' && (
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => onDelete(focus.id)}>
              <Trash2 className="h-4 w-4" />Remove
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

// ─── Agents: list + detail ────────────────────────────────────────────────────

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
        action={<Button size="sm" onClick={onAdd}><Plus className="h-4 w-4" />Add agent</Button>}
      />
    )
  }

  return (
    <div className="rounded-xl border overflow-hidden">
      {agents.map((a) => {
        const provider = providers.find((p) => p.id === a.providerId)
        return (
          <button
            key={a.id}
            onClick={() => onOpen(a.id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors border-b last:border-b-0"
          >
            <div className="h-7 w-7 shrink-0 rounded-md bg-muted flex items-center justify-center">
              <Bot className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{a.name}</div>
              <div className="text-xs text-muted-foreground truncate">{a.model}</div>
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
  focus: Extract<Focus, { kind: 'agent' }>
  onSave: (agent: SettingsAgent) => void
  onCancel: () => void
  onDelete: (id: string) => void
}

function AgentDetail({ agents, providers, focus, onSave, onCancel, onDelete }: AgentDetailProps) {
  const existing = focus.mode === 'edit' ? agents.find((a) => a.id === focus.id) : undefined
  const defaultProvider = existing
    ? providers.find((p) => p.id === existing.providerId) ?? providers[0]
    : providers[0]

  const [name, setName]                 = useState(existing?.name ?? '')
  const [providerId, setProviderId]     = useState(defaultProvider?.id ?? '')
  const [model, setModel]               = useState(existing?.model ?? '')
  const [instructions, setInstructions] = useState(existing?.instructions ?? '')

  const selectedProvider = providers.find((p) => p.id === providerId)
  const modelOptions = useMemo(
    () => (selectedProvider ? PROVIDER_MODELS[selectedProvider.kind] : []),
    [selectedProvider],
  )

  const handleProviderChange = (nextId: string) => {
    setProviderId(nextId)
    const next = providers.find((p) => p.id === nextId)
    if (next && !PROVIDER_MODELS[next.kind].includes(model)) {
      setModel(PROVIDER_MODELS[next.kind][0] ?? '')
    }
  }

  const canSave = name.trim() && providerId && model
  const handleSave = () => {
    if (!canSave) return
    const next: SettingsAgent = {
      id: existing?.id ?? `sa-${Date.now()}`,
      name: name.trim(),
      providerId,
      model,
      instructions: instructions.trim(),
    }
    onSave(next)
  }

  return (
    <div className="space-y-6 max-w-xl">
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Copywriter" />
      </Field>

      <Field label="Provider" help="Determines which models are available.">
        <SelectDropdown
          value={providerId}
          placeholder="Select provider"
          onChange={handleProviderChange}
          options={providers.map((p) => ({ value: p.id, label: `${p.name} (${PROVIDER_LABELS[p.kind]})` }))}
        />
      </Field>

      <Field label="Model">
        <SelectDropdown
          value={model}
          placeholder={selectedProvider ? 'Select model' : 'Pick a provider first'}
          onChange={setModel}
          disabled={!selectedProvider || modelOptions.length === 0}
          options={modelOptions.map((m) => ({ value: m, label: m }))}
        />
      </Field>

      <Field label="Default instructions" help="Prepended to every conversation this agent runs.">
        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Describe how this agent should behave, what tone to use, what to avoid…"
          className="min-h-[120px]"
        />
      </Field>

      <div className="flex items-center justify-between pt-2 border-t">
        <div>
          {focus.mode === 'edit' && (
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => onDelete(focus.id)}>
              <Trash2 className="h-4 w-4" />Delete
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

// ─── Shared bits ──────────────────────────────────────────────────────────────

function Field({
  label, help, children,
}: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{label}</div>
      {children}
      {help && <div className="text-xs text-muted-foreground">{help}</div>}
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
  const selected = options.find((o) => o.value === value)
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
          options.map((o) => (
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
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-muted-foreground max-w-sm">{body}</div>
      {action}
    </div>
  )
}
