import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
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
  useGetAgentsQuery,
  useCreateAgentMutation,
  usePatchAgentMutation,
  useDeleteAgentMutation,
  useGetWorkspaceAgentsQuery,
  useAddWorkspaceAgentMutation,
  useRemoveWorkspaceAgentMutation,
  useGetModelsQuery,
  useGetProviderKeysQuery,
  usePutProviderKeysMutation,
  useGetProvidersMetaQuery,
  usePutProvidersMetaMutation,
  useGetMeQuery,
  type ModelRef,
} from '@/store/api'
import type { ServerAgent } from '@/store/types'
import {
  CONNECTION_CATALOG,
  FALLBACK_MODELS_BY_PROVIDER,
  MODEL_PROVIDER_BY_KIND,
  PROVIDER_KEY_BY_KIND,
  type Connection,
  type ConnectionKind,
} from '@/data/connections'
import type { WorkspaceInfo } from '@/components/layout/WorkspaceBar'

function describeApiError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { data?: { message?: unknown }; error?: unknown }
    if (typeof e.data?.message === 'string') return e.data.message
    if (typeof e.error === 'string') return e.error
  }
  if (err instanceof Error) return err.message
  return 'Unknown error'
}

// ── Brand marks ─────────────────────────────────────────────────────────────

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

// Provider id → brand glyph kind. Anything not in the map renders the
// generic muted square.
function brandKindForProvider(provider: string): ConnectionKind | null {
  if (provider === 'anthropic') return 'claude'
  if (provider === 'openai')    return 'chatgpt'
  return null
}

// Connection kinds that the picker can actually configure (i.e. we have a
// backend to persist them). Other catalog entries appear in the picker
// but are disabled.
function isFunctionalKind(kind: ConnectionKind): boolean {
  return PROVIDER_KEY_BY_KIND[kind] !== undefined
}

// Build the connections list from the persisted provider keys. Only
// kinds whose key is set show up — we don't fake "Claude is connected"
// when no key has been saved. Custom display names come from providerMeta.
function deriveConnections(
  providerKeys: Record<string, string | null>,
  providerMeta: Record<string, { name?: string }>,
): Connection[] {
  const out: Connection[] = []
  for (const [kind, envKey] of Object.entries(PROVIDER_KEY_BY_KIND) as [ConnectionKind, string][]) {
    if (providerKeys[envKey]) {
      const catalogMeta = CONNECTION_CATALOG[kind]
      const customName = providerMeta[envKey]?.name
      out.push({
        id: `conn-${kind}`,
        kind,
        name: customName || catalogMeta.name,
        enabled: true,
      })
    }
  }
  return out
}

// ── Shared bits ──────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'active' | 'inactive'

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all',      label: 'All'      },
  { value: 'active',   label: 'Active'   },
  { value: 'inactive', label: 'Inactive' },
]

function StatusFilterPills({
  value, onChange,
}: { value: StatusFilter; onChange: (next: StatusFilter) => void }) {
  return (
    <div className="flex items-center rounded-lg border p-0.5">
      {STATUS_FILTERS.map(f => (
        <button
          key={f.value}
          onClick={() => onChange(f.value)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium transition-colors',
            value === f.value
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {f.label}
        </button>
      ))}
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
  testIdPrefix?: string
}

function SelectDropdown({ value, placeholder, onChange, options, disabled, testIdPrefix }: SelectDropdownProps) {
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
            <DropdownMenuItem
              key={o.value}
              onSelect={() => onChange(o.value)}
              data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
            >
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

// Sticky-footer scroll-shadow hook — top border on the footer fades in
// once content is hidden behind it.
function useScrolledUnder() {
  const ref = useRef<HTMLDivElement>(null)
  const [scrolledUnder, setScrolledUnder] = useState(false)
  useEffect(() => {
    const el = ref.current
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
  return { ref, scrolledUnder }
}

// ── Brand glyph (used by both Agents and Connections) ───────────────────────

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

// Picks the right glyph for an agent based on its model.provider; falls back
// to a neutral box for providers without a brand mark.
function AgentGlyph({ provider, size = 'lg' }: { provider: string | undefined; size?: 'sm' | 'md' | 'lg' }) {
  const kind = provider ? brandKindForProvider(provider) : null
  if (kind) return <ConnectionGlyph kind={kind} size={size} />
  const box = size === 'sm' ? 'h-5 w-5' : size === 'lg' ? 'h-10 w-10' : 'h-8 w-8'
  return <span className={cn('shrink-0 rounded-lg bg-muted', box)} />
}

// ── Workspace section ────────────────────────────────────────────────────────

function WorkspaceSection({
  workspace,
  canDelete,
  onUpdate,
  onDelete,
}: {
  workspace: WorkspaceInfo
  canDelete: boolean
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

  const { ref: scrollRef, scrolledUnder } = useScrolledUnder()

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-4">
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
        <Popover open={deleteOpen} onOpenChange={o => canDelete && setDeleteOpen(o)}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canDelete}
              title={canDelete ? undefined : "You need at least one workspace. Create another before deleting this one."}
              className="text-destructive hover:text-destructive gap-1.5 disabled:text-muted-foreground disabled:hover:text-muted-foreground"
            >
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

function providerLabel(provider: string): string {
  if (provider === 'anthropic') return 'Claude'
  if (provider === 'openai')    return 'ChatGPT'
  if (provider === 'opencode')  return 'OpenCode'
  return provider
}

// Returns models grouped by provider, merging /tools/models with fallback
// catalogs for any provider whose key is configured. This keeps the
// provider/model dropdowns functional even when the sandbox model
// listing endpoint is empty or failing.
function buildModelIndex(
  apiModels: ModelRef[],
  providerKeys: Record<string, string | null>,
  currentModel: string,
): Map<string, ModelRef[]> {
  const byProvider = new Map<string, ModelRef[]>()
  const seenIds = new Set<string>()

  const add = (m: ModelRef) => {
    if (seenIds.has(m.id)) return
    seenIds.add(m.id)
    const list = byProvider.get(m.provider) ?? []
    list.push(m)
    byProvider.set(m.provider, list)
  }

  for (const m of apiModels) add(m)

  // Fallback models for providers whose key is configured but the API
  // returned nothing (e.g. /tools/models is failing).
  for (const [kind, envKey] of Object.entries(PROVIDER_KEY_BY_KIND) as [ConnectionKind, string][]) {
    const providerId = MODEL_PROVIDER_BY_KIND[kind]
    if (!providerId) continue
    if (!providerKeys[envKey]) continue
    if (byProvider.has(providerId)) continue
    const fallback = FALLBACK_MODELS_BY_PROVIDER[providerId] ?? []
    for (const f of fallback) add({ provider: providerId, id: f.id, label: f.label })
  }

  // Always surface the agent's current model so editing an existing
  // agent doesn't drop the selection if the model isn't in either list.
  if (currentModel && !seenIds.has(currentModel)) {
    const slash = currentModel.indexOf('/')
    const provider = slash > 0 ? currentModel.slice(0, slash) : 'unknown'
    add({ provider, id: currentModel, label: currentModel })
  }

  return byProvider
}

function AgentsList({
  agents, modelIndex, enrolledIds, statusFilter, search,
  onOpen, onAdd, onDelete, onDuplicate, onToggleEnabled, onChatNow,
}: {
  agents: ServerAgent[]
  modelIndex: Map<string, ModelRef[]>
  enrolledIds: Set<string>
  statusFilter: StatusFilter
  search: string
  onOpen: (id: string) => void
  onAdd: () => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onToggleEnabled: (id: string, next: boolean) => void
  onChatNow?: (id: string) => void
}) {
  const q = search.trim().toLowerCase()
  const filtered = agents
    .filter(a => {
      const enrolled = enrolledIds.has(a.id)
      return statusFilter === 'all'
        || (statusFilter === 'active' && enrolled)
        || (statusFilter === 'inactive' && !enrolled)
    })
    .filter(a => !q || a.name.toLowerCase().includes(q) || a.model.toLowerCase().includes(q))

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
  if (filtered.length === 0) {
    return <EmptyState title="No matches" body={q ? `No agents match “${q}”.` : 'No agents in this filter.'} />
  }

  return (
    <div className="flex flex-col">
      {filtered.map((a, i) => {
        const allModels: ModelRef[] = []
        for (const ms of modelIndex.values()) allModels.push(...ms)
        const model = allModels.find(m => m.id === a.model)
        const provider = model?.provider
        const enrolled = enrolledIds.has(a.id)
        return (
          <motion.div
            key={a.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.02, duration: 0.15, ease: 'easeOut' }}
            className="group flex items-center gap-3 py-4 border-b last:border-b-0"
          >
            <Switch
              checked={enrolled}
              onCheckedChange={(next) => onToggleEnabled(a.id, next)}
              aria-label={`${enrolled ? 'Disable' : 'Enable'} ${a.name} in this workspace`}
            />
            <AgentGlyph provider={provider} size="lg" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{a.name}</p>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                {provider && <span className="shrink-0">{providerLabel(provider)}</span>}
                <span className="truncate">{model?.label ?? a.model}</span>
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
                  <DropdownMenuItem onSelect={() => onChatNow?.(a.id)}>
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

function AgentDetail({
  agents, modelIndex, focus, busy, onSave, onCancel, onDelete,
}: {
  agents: ServerAgent[]
  modelIndex: Map<string, ModelRef[]>
  focus: Exclude<AgentsFocus, null>
  busy: boolean
  onSave: (v: { id?: string; name: string; model: string; instructions: string }) => void
  onCancel: () => void
  onDelete: (id: string) => void
}) {
  const existing = focus.mode === 'edit' ? agents.find(a => a.id === focus.id) : undefined
  const providers = useMemo(
    () => [...modelIndex.keys()].sort((a, b) => a.localeCompare(b)),
    [modelIndex],
  )

  const flatModels = useMemo(() => {
    const out: ModelRef[] = []
    for (const ms of modelIndex.values()) out.push(...ms)
    return out
  }, [modelIndex])

  const initialModel    = existing?.model ?? flatModels[0]?.id ?? ''
  const initialModelRef = flatModels.find(m => m.id === initialModel)
  const initialProvider = initialModelRef?.provider ?? providers[0] ?? ''

  const [name, setName]                 = useState(existing?.name ?? '')
  const [provider, setProvider]         = useState(initialProvider)
  const [model, setModel]               = useState(initialModel)
  const [instructions, setInstructions] = useState(existing?.instructions ?? '')

  const modelOptions = useMemo(
    () => modelIndex.get(provider) ?? [],
    [modelIndex, provider],
  )

  const handleProviderChange = (next: string) => {
    setProvider(next)
    const list = modelIndex.get(next) ?? []
    if (!list.some(m => m.id === model)) {
      setModel(list[0]?.id ?? '')
    }
  }

  const canSave = name.trim().length > 0 && model.trim().length > 0
  const handleSave = () => {
    if (!canSave) return
    onSave({
      id: existing?.id,
      name: name.trim(),
      model: model.trim(),
      instructions: instructions.trim(),
    })
  }

  const [deleteOpen, setDeleteOpen] = useState(false)
  const { ref: scrollRef, scrolledUnder } = useScrolledUnder()

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-4">
        <Field label="Name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Copywriter" />
        </Field>

        <Field label="Provider" help="Determines which models are available.">
          <SelectDropdown
            value={provider}
            placeholder={providers.length ? 'Select provider' : 'No providers configured'}
            onChange={handleProviderChange}
            disabled={providers.length === 0}
            options={providers.map(p => ({ value: p, label: providerLabel(p) }))}
          />
        </Field>

        <Field label="Model">
          <SelectDropdown
            value={model}
            placeholder={provider ? 'Select model' : 'Pick a provider first'}
            onChange={setModel}
            disabled={!provider || modelOptions.length === 0}
            options={modelOptions.map(m => ({ value: m.id, label: m.label ?? m.id }))}
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
          'shrink-0 p-4 flex items-center justify-between gap-2 border-t border-transparent',
          scrolledUnder && 'border-border',
        )}
      >
        <div>
          {focus.mode === 'edit' && existing && (
            <Popover open={deleteOpen} onOpenChange={setDeleteOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive gap-1.5">
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete agent
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-4" align="start">
                <p className="text-sm font-medium mb-1">Delete {existing.name}?</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Any chats assigned to this agent will lose it. This can't be undone.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    onClick={() => { setDeleteOpen(false); onDelete(existing.id) }}
                  >
                    Delete
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDeleteOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave || busy}>
            {focus.mode === 'new' ? (busy ? 'Adding…' : 'Add agent') : (busy ? 'Saving…' : 'Save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Connections section ──────────────────────────────────────────────────────

type ConnectionsFocus =
  | { mode: 'picker' }
  | { mode: 'new'; kind: ConnectionKind }
  | { mode: 'edit'; id: string }
  | null

function ConnectionsList({
  connections, statusFilter, search,
  onOpen, onPickNew, onDelete, onToggleEnabled,
}: {
  connections: Connection[]
  statusFilter: StatusFilter
  search: string
  onOpen: (id: string) => void
  onPickNew: () => void
  onDelete: (id: string) => void
  onToggleEnabled: (id: string) => void
}) {
  const q = search.trim().toLowerCase()
  const filtered = connections
    .filter(c => statusFilter === 'all'
      || (statusFilter === 'active' && c.enabled)
      || (statusFilter === 'inactive' && !c.enabled))
    .filter(c => !q
      || c.name.toLowerCase().includes(q)
      || CONNECTION_CATALOG[c.kind].name.toLowerCase().includes(q))

  if (connections.length === 0) {
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
  if (filtered.length === 0) {
    return <EmptyState title="No matches" body={q ? `No connections match “${q}”.` : 'No connections in this filter.'} />
  }

  return (
    <div className="flex flex-col">
      {filtered.map((c, i) => {
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
              checked={c.enabled}
              onCheckedChange={() => onToggleEnabled(c.id)}
              aria-label={`${c.enabled ? 'Disable' : 'Enable'} ${c.name} in this workspace`}
            />
            <ConnectionGlyph kind={c.kind} size="lg" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{c.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground truncate">{meta.description}</p>
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
                  <DropdownMenuItem
                    onSelect={() => onDelete(c.id)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />Remove
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

function ConnectionsPicker({
  configuredKinds, onPick,
}: {
  configuredKinds: Set<ConnectionKind>
  onPick: (kind: ConnectionKind) => void
}) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const entries = (Object.entries(CONNECTION_CATALOG) as [ConnectionKind, typeof CONNECTION_CATALOG[ConnectionKind]][])
    .filter(([, meta]) => !q
      || meta.name.toLowerCase().includes(q)
      || meta.description.toLowerCase().includes(q))

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-4">
      <div className="flex items-center justify-end">
        <SearchInput value={search} onChange={setSearch} placeholder="Search connections…" />
      </div>
      {entries.length === 0 ? (
        <EmptyState title="No matches" body={`No connections match “${q}”.`} />
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {entries.map(([kind, meta], i) => {
            const functional = isFunctionalKind(kind)
            const alreadyAdded = configuredKinds.has(kind)
            const disabled = !functional || alreadyAdded
            const badge = !functional
              ? 'Coming soon'
              : alreadyAdded
                ? 'Added'
                : null
            return (
              <motion.button
                key={kind}
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: i * 0.03, duration: 0.18, ease: 'easeOut' }}
                onClick={() => !disabled && onPick(kind)}
                disabled={disabled}
                className={cn(
                  'group flex flex-col items-start gap-2 rounded-xl border bg-background p-4 text-left transition-colors',
                  disabled
                    ? 'cursor-not-allowed opacity-60'
                    : 'hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none',
                )}
              >
                <div className="flex w-full items-start justify-between gap-2">
                  <ConnectionGlyph kind={kind} size="lg" />
                  {badge && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {badge}
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{meta.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{meta.description}</p>
                </div>
              </motion.button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ConnectionDetail({
  connections, focus, providerKeys, providerMeta, busySaveKey, busySaveMeta,
  onSave, onCancel, onDelete, onSaveProviderKey,
}: {
  connections: Connection[]
  focus: Extract<ConnectionsFocus, { mode: 'new' } | { mode: 'edit' }>
  providerKeys: Record<string, string | null>
  providerMeta: Record<string, { name?: string }>
  busySaveKey: boolean
  busySaveMeta: boolean
  onSave: (c: Connection) => void
  onCancel: () => void
  onDelete: (id: string) => void
  onSaveProviderKey: (envKey: string, value: string) => void
}) {
  const existing = focus.mode === 'edit' ? connections.find(c => c.id === focus.id) : undefined
  const kind: ConnectionKind = existing?.kind ?? (focus.mode === 'new' ? focus.kind : 'claude')
  const catalogMeta = CONNECTION_CATALOG[kind]

  const providerEnvKey = PROVIDER_KEY_BY_KIND[kind]
  const persistedKey = providerEnvKey ? providerKeys[providerEnvKey] ?? '' : ''
  const persistedName = providerEnvKey ? providerMeta[providerEnvKey]?.name ?? '' : ''

  // For Claude/ChatGPT the API key is the persisted masked echo on first
  // load. The user has to type a fresh value to overwrite it.
  const [name, setName]       = useState(existing?.name ?? (persistedName || catalogMeta.name))
  const [apiKey, setApiKey]   = useState(persistedKey ?? '')
  const [apiKeyDirty, setApiKeyDirty] = useState(false)

  // Backfill the masked key once /me/providers resolves.
  useEffect(() => {
    if (providerEnvKey && !apiKeyDirty && persistedKey) {
      setApiKey(persistedKey)
    }
  }, [providerEnvKey, persistedKey, apiKeyDirty])

  // Backfill the custom name once /me/providers/meta resolves.
  useEffect(() => {
    if (persistedName) setName(persistedName)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedName])

  const handleSave = () => {
    onSave({
      id: existing?.id ?? `conn-${kind}-${Date.now()}`,
      kind,
      name: name.trim() || catalogMeta.name,
      enabled: existing?.enabled ?? true,
    })
  }

  const handleSaveKey = () => {
    if (!providerEnvKey || !apiKeyDirty) return
    onSaveProviderKey(providerEnvKey, apiKey.trim())
    setApiKeyDirty(false)
  }

  const [deleteOpen, setDeleteOpen] = useState(false)
  const { ref: scrollRef, scrolledUnder } = useScrolledUnder()

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-4">
        <div className="flex items-center gap-3">
          <ConnectionGlyph kind={kind} size="lg" />
          <div>
            <p className="text-sm font-medium">{catalogMeta.name}</p>
            <p className="text-xs text-muted-foreground">{catalogMeta.description}</p>
          </div>
        </div>

        <Field label="Display name" help="Optional custom label shown in the connections list.">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder={catalogMeta.name} />
        </Field>

        <Field
          label="API key"
          help={providerEnvKey
            ? 'Stored encrypted on the server. Saved keys appear masked on reload — submit a fresh value to overwrite.'
            : 'Stored locally. Used to authenticate against the service.'}
        >
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={apiKey}
              onChange={e => { setApiKey(e.target.value); setApiKeyDirty(true) }}
              data-testid={providerEnvKey ? `provider-key-${providerEnvKey}` : undefined}
              placeholder={kind === 'claude' ? 'sk-ant-…' : kind === 'chatgpt' ? 'sk-…' : 'Paste the API key or token'}
              className="flex-1"
            />
            {providerEnvKey && (
              <Button
                size="sm"
                disabled={!apiKeyDirty || busySaveKey}
                data-testid={`provider-save-${providerEnvKey}`}
                onClick={handleSaveKey}
              >
                {busySaveKey ? 'Saving…' : 'Apply'}
              </Button>
            )}
          </div>
        </Field>
      </div>

      <div
        className={cn(
          'shrink-0 p-4 flex items-center justify-between gap-2 border-t border-transparent',
          scrolledUnder && 'border-border',
        )}
      >
        <div>
          {focus.mode === 'edit' && existing && (
            <Popover open={deleteOpen} onOpenChange={setDeleteOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive gap-1.5">
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove connection
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-4" align="start">
                <p className="text-sm font-medium mb-1">Remove {existing.name}?</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Agents using this connection won't be able to run until a new one is configured. This can't be undone.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    onClick={() => { setDeleteOpen(false); onDelete(existing.id) }}
                  >
                    Remove
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDeleteOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busySaveMeta}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={busySaveMeta}>
            {focus.mode === 'new' ? (busySaveMeta ? 'Adding…' : 'Add connection') : (busySaveMeta ? 'Saving…' : 'Save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Preferences ──────────────────────────────────────────────────────────────

// Mirrors `RouteView` from `@/router/nav`. The pref offered 'chats' for a
// while, but there is no Chats route — chats are URL params layered onto
// any top-level view — so picking it had no effect. `loadPrefs` migrates
// stored 'chats' values to 'desk' on load.
type DefaultView = 'desk' | 'tasks' | 'context'

export interface PrefsShape {
  autoSave: boolean
  defaultView: DefaultView
  showBadges: boolean
  developerMode: boolean
}

const PREFS_DEFAULTS: PrefsShape = {
  autoSave: true,
  defaultView: 'desk',
  showBadges: true,
  developerMode: false,
}

function prefsKey(userId: string): string {
  return `desk.prefs.${userId}`
}

const VALID_VIEWS: readonly DefaultView[] = ['desk', 'tasks', 'context']

export function loadPrefs(userId: string | undefined): PrefsShape {
  if (!userId) return PREFS_DEFAULTS
  try {
    const raw = localStorage.getItem(prefsKey(userId))
    if (!raw) return PREFS_DEFAULTS
    const parsed = JSON.parse(raw) as Partial<PrefsShape>
    const merged = { ...PREFS_DEFAULTS, ...parsed }
    if (!VALID_VIEWS.includes(merged.defaultView)) {
      merged.defaultView = PREFS_DEFAULTS.defaultView
    }
    return merged
  } catch {
    return PREFS_DEFAULTS
  }
}

function savePrefs(userId: string | undefined, prefs: PrefsShape): void {
  if (!userId) return
  try {
    localStorage.setItem(prefsKey(userId), JSON.stringify(prefs))
    // Notify subscribers in the same tab — `storage` events only cross tabs.
    window.dispatchEvent(new CustomEvent('desk:prefs-changed'))
  } catch {
    /* ignore */
  }
}

function PreferenceRow({
  title, description, children,
}: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 border-b last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function PreferencesSection() {
  const { data: me } = useGetMeQuery()
  const userId = me?.id
  const [prefs, setPrefs] = useState<PrefsShape>(PREFS_DEFAULTS)
  useEffect(() => { setPrefs(loadPrefs(userId)) }, [userId])

  const update = (patch: Partial<PrefsShape>): void => {
    setPrefs(prev => {
      const next = { ...prev, ...patch }
      savePrefs(userId, next)
      return next
    })
  }

  const VIEW_OPTIONS: { value: DefaultView; label: string }[] = [
    { value: 'desk',    label: 'Desk'    },
    { value: 'tasks',   label: 'Tasks'   },
    { value: 'context', label: 'Library' },
  ]

  return (
    <div className="flex flex-col">
      <PreferenceRow
        title="Auto-save artifacts"
        description="Automatically save artifacts created in chats to your Desk."
      >
        <Switch
          data-testid="prefs-auto-save"
          checked={prefs.autoSave}
          onCheckedChange={v => update({ autoSave: v })}
        />
      </PreferenceRow>

      <PreferenceRow
        title="Show unread badges"
        description="Display unread counts on workspace tabs and nav items."
      >
        <Switch
          data-testid="prefs-show-badges"
          checked={prefs.showBadges}
          onCheckedChange={v => update({ showBadges: v })}
        />
      </PreferenceRow>

      <PreferenceRow
        title="Default view"
        description="The view you land on after sign-in and when switching workspaces."
      >
        <div className="flex rounded-md border overflow-hidden">
          {VIEW_OPTIONS.map(opt => (
            <button
              key={opt.value}
              data-testid={`prefs-default-view-${opt.value}`}
              onClick={() => update({ defaultView: opt.value })}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors',
                prefs.defaultView === opt.value
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </PreferenceRow>

      <PreferenceRow
        title="Developer mode"
        description="Show advanced tooling, debug panels, and experimental features."
      >
        <Switch
          data-testid="prefs-developer-mode"
          checked={prefs.developerMode}
          onCheckedChange={v => update({ developerMode: v })}
        />
      </PreferenceRow>
    </div>
  )
}

// ── Main modal ───────────────────────────────────────────────────────────────

interface SettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: WorkspaceInfo
  /** Whether the workspace can be deleted (false when it's the caller's last). */
  canDeleteWorkspace: boolean
  onUpdateWorkspace: (ws: WorkspaceInfo) => void
  onDeleteWorkspace: () => void
  /** Called when the user clicks "Chat now" on an agent. Receives the agent id. */
  onChatWithAgent?: (agentId: string) => void
}

export function SettingsModal({
  open,
  onOpenChange,
  workspace,
  canDeleteWorkspace,
  onUpdateWorkspace,
  onDeleteWorkspace,
  onChatWithAgent,
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<NavSection>('workspace')

  // ── Agents state ──────────────────────────────────────────────────────────
  const { data: serverAgents } = useGetAgentsQuery()
  const { data: workspaceAgents } = useGetWorkspaceAgentsQuery(workspace.id)
  const { data: models } = useGetModelsQuery()
  const [createAgent, { isLoading: creatingAgent }] = useCreateAgentMutation()
  const [patchAgent, { isLoading: patchingAgent }]  = usePatchAgentMutation()
  const [deleteAgent] = useDeleteAgentMutation()
  const [addWorkspaceAgent]    = useAddWorkspaceAgentMutation()
  const [removeWorkspaceAgent] = useRemoveWorkspaceAgentMutation()

  const agents = serverAgents ?? []
  const enrolledIds = useMemo(
    () => new Set((workspaceAgents ?? []).map(a => a.id)),
    [workspaceAgents],
  )

  const [agentsFocus, setAgentsFocus]                 = useState<AgentsFocus>(null)
  const [agentsSearch, setAgentsSearch]               = useState('')
  const [agentsStatusFilter, setAgentsStatusFilter]   = useState<StatusFilter>('all')

  const setAgentsFocusAndReset = (next: AgentsFocus) => {
    setAgentsFocus(next)
    setAgentsSearch('')
  }

  const handleSaveAgent = async (v: { id?: string; name: string; model: string; instructions: string }) => {
    try {
      if (v.id) {
        await patchAgent({ id: v.id, patch: { name: v.name, model: v.model, instructions: v.instructions } }).unwrap()
      } else {
        const created = await createAgent({ name: v.name, model: v.model, instructions: v.instructions }).unwrap()
        // Auto-enroll in the current workspace so the agent is active immediately.
        await addWorkspaceAgent({ workspaceId: workspace.id, agentId: created.id }).unwrap()
      }
      setAgentsFocus(null)
    } catch (err) {
      toast.error('Could not save agent', { description: describeApiError(err) })
    }
  }

  const handleDeleteAgent = async (id: string) => {
    try {
      await deleteAgent(id).unwrap()
      setAgentsFocus(null)
    } catch (err) {
      toast.error('Could not delete agent', { description: describeApiError(err) })
    }
  }

  const handleDuplicateAgent = async (id: string) => {
    const source = agents.find(a => a.id === id)
    if (!source) return
    try {
      await createAgent({
        name: `${source.name} (copy)`,
        model: source.model,
        instructions: source.instructions,
      }).unwrap()
    } catch (err) {
      toast.error('Could not duplicate agent', { description: describeApiError(err) })
    }
  }

  // Models are merged from /tools/models with hardcoded fallbacks for any
  // provider whose key is configured — keeps provider/model dropdowns
  // functional even when the sandbox model listing is empty or failing.
  // Built later (we need providerKeys), but referenced here.
  const editingAgentModel = (() => {
    if (agentsFocus?.mode !== 'edit') return ''
    return agents.find(a => a.id === agentsFocus.id)?.model ?? ''
  })()

  const handleToggleAgentEnabled = async (agentId: string, next: boolean) => {
    try {
      if (next) await addWorkspaceAgent({ workspaceId: workspace.id, agentId }).unwrap()
      else      await removeWorkspaceAgent({ workspaceId: workspace.id, agentId }).unwrap()
    } catch (err) {
      toast.error(next ? 'Could not enable agent' : 'Could not disable agent', { description: describeApiError(err) })
    }
  }

  // ── Connections state ─────────────────────────────────────────────────────
  // The connection list is derived from /me/providers — Claude / ChatGPT
  // entries appear once their API key is saved. Other catalog kinds stay
  // disabled in the picker until a backend lands.
  const { data: providerKeys } = useGetProviderKeysQuery()
  const [putProviderKeys, { isLoading: savingKey }] = usePutProviderKeysMutation()
  const { data: providersMeta } = useGetProvidersMetaQuery()
  const [putProvidersMeta, { isLoading: savingMeta }] = usePutProvidersMetaMutation()

  const providerKeysMap = providerKeys ?? {}
  const providersMetaMap = providersMeta ?? {}
  const connections = useMemo(
    () => deriveConnections(providerKeysMap, providersMetaMap),
    [providerKeysMap, providersMetaMap],
  )
  const configuredKinds = useMemo(
    () => new Set(connections.map(c => c.kind)),
    [connections],
  )

  // Per-workspace availability for connections is local-only for now —
  // a key being saved means the connection exists, this toggle gates
  // whether agents in this workspace see it. State resets on remount.
  const [connectionsDisabledLocal, setConnectionsDisabledLocal] = useState<Set<string>>(new Set())
  const connectionsView = useMemo(
    () => connections.map(c => ({ ...c, enabled: !connectionsDisabledLocal.has(c.id) })),
    [connections, connectionsDisabledLocal],
  )

  const [connectionsFocus, setConnectionsFocus]               = useState<ConnectionsFocus>(null)
  const [connectionsSearch, setConnectionsSearch]             = useState('')
  const [connectionsStatusFilter, setConnectionsStatusFilter] = useState<StatusFilter>('all')

  const setConnectionsFocusAndReset = (next: ConnectionsFocus) => {
    setConnectionsFocus(next)
    setConnectionsSearch('')
  }

  const handleSaveConnection = async (conn: Connection) => {
    // Persist the display name to /me/providers/meta if this is a
    // functional (API-key-backed) connection kind.
    const envKey = PROVIDER_KEY_BY_KIND[conn.kind]
    if (envKey) {
      const catalogName = CONNECTION_CATALOG[conn.kind].name
      // Only write if it differs from the catalog default or a prior custom name
      const metaName = conn.name === catalogName ? '' : conn.name
      try {
        await putProvidersMeta({ [envKey]: metaName ? { name: metaName } : null }).unwrap()
      } catch (err) {
        toast.error('Could not save connection name', { description: describeApiError(err) })
        return
      }
    }
    setConnectionsFocus(null)
  }

  const handleDeleteConnection = async (id: string) => {
    const conn = connections.find(c => c.id === id)
    if (!conn) { setConnectionsFocus(null); return }
    const envKey = PROVIDER_KEY_BY_KIND[conn.kind]
    if (envKey) {
      try {
        // Sending an empty string clears the key on the server — the row
        // disappears from the list because deriveConnections() drops it.
        await putProviderKeys({ [envKey]: '' }).unwrap()
      } catch (err) {
        toast.error('Could not remove connection', { description: describeApiError(err) })
        return
      }
    }
    setConnectionsFocus(null)
  }

  const handleToggleConnectionEnabled = (id: string) => {
    setConnectionsDisabledLocal(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleSaveProviderKey = async (envKey: string, value: string) => {
    try {
      await putProviderKeys({ [envKey]: value }).unwrap()
    } catch (err) {
      toast.error('Could not save provider key', { description: describeApiError(err) })
    }
  }

  const modelIndex = useMemo(
    () => buildModelIndex(models ?? [], providerKeysMap, editingAgentModel),
    [models, providerKeysMap, editingAgentModel],
  )

  // ── Route key for page transitions ────────────────────────────────────────
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
                  <button type="button" onClick={() => { setAgentsFocus(null); setAgentsSearch('') }}>
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
      const atNew = connectionsFocus?.mode === 'picker' || connectionsFocus?.mode === 'new'
      const leaf = connectionsFocus?.mode === 'new'
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
                      <button type="button" onClick={() => setConnectionsFocus({ mode: 'picker' })}>
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
        <DialogTitle className="sr-only">Workspace settings</DialogTitle>

        <div className="flex h-full">
          {/* Left nav */}
          <div className="w-52 shrink-0 flex flex-col border-r bg-muted/30">
            <div className="px-4 pt-5 pb-3">
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
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                    activeSection === id
                      ? 'bg-muted text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {/* Right content */}
          <div className="flex-1 flex flex-col min-w-0">
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
                  canDelete={canDeleteWorkspace}
                  onUpdate={ws => { onUpdateWorkspace(ws); onOpenChange(false) }}
                  onDelete={() => { onDeleteWorkspace(); onOpenChange(false) }}
                />
              ) : activeSection === 'agents' && agentsFocus !== null ? (
                <AgentDetail
                  agents={agents}
                  modelIndex={modelIndex}
                  focus={agentsFocus}
                  busy={creatingAgent || patchingAgent}
                  onSave={handleSaveAgent}
                  onCancel={() => setAgentsFocus(null)}
                  onDelete={handleDeleteAgent}
                />
              ) : activeSection === 'connections' && connectionsFocus?.mode === 'picker' ? (
                <ConnectionsPicker
                  configuredKinds={configuredKinds}
                  onPick={(kind) => setConnectionsFocus({ mode: 'new', kind })}
                />
              ) : activeSection === 'connections' && (connectionsFocus?.mode === 'new' || connectionsFocus?.mode === 'edit') ? (
                <ConnectionDetail
                  connections={connectionsView}
                  focus={connectionsFocus}
                  providerKeys={providerKeysMap}
                  providerMeta={providersMetaMap}
                  busySaveKey={savingKey}
                  busySaveMeta={savingMeta}
                  onSave={handleSaveConnection}
                  onCancel={() => setConnectionsFocus(null)}
                  onDelete={handleDeleteConnection}
                  onSaveProviderKey={handleSaveProviderKey}
                />
              ) : (
                <div className="flex-1 overflow-y-auto px-4 pt-3 pb-6">
                  {activeSection === 'agents' && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between gap-2">
                        <StatusFilterPills value={agentsStatusFilter} onChange={setAgentsStatusFilter} />
                        <div className="flex items-center gap-2">
                          <SearchInput value={agentsSearch} onChange={setAgentsSearch} placeholder="Search agents…" />
                          <Button size="sm" className="gap-1.5" onClick={() => setAgentsFocusAndReset({ mode: 'new' })}>
                            <Plus className="h-3.5 w-3.5" />Add
                          </Button>
                        </div>
                      </div>
                      <AgentsList
                        agents={agents}
                        modelIndex={modelIndex}
                        enrolledIds={enrolledIds}
                        statusFilter={agentsStatusFilter}
                        search={agentsSearch}
                        onOpen={(id) => setAgentsFocusAndReset({ mode: 'edit', id })}
                        onAdd={() => setAgentsFocusAndReset({ mode: 'new' })}
                        onDelete={handleDeleteAgent}
                        onDuplicate={handleDuplicateAgent}
                        onToggleEnabled={handleToggleAgentEnabled}
                        onChatNow={(id) => {
                          onOpenChange(false)
                          onChatWithAgent?.(id)
                        }}
                      />
                    </div>
                  )}
                  {activeSection === 'connections' && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between gap-2">
                        <StatusFilterPills value={connectionsStatusFilter} onChange={setConnectionsStatusFilter} />
                        <div className="flex items-center gap-2">
                          <SearchInput value={connectionsSearch} onChange={setConnectionsSearch} placeholder="Search connections…" />
                          <Button size="sm" className="gap-1.5" onClick={() => setConnectionsFocusAndReset({ mode: 'picker' })}>
                            <Plus className="h-3.5 w-3.5" />Add
                          </Button>
                        </div>
                      </div>
                      <ConnectionsList
                        connections={connectionsView}
                        statusFilter={connectionsStatusFilter}
                        search={connectionsSearch}
                        onOpen={(id) => setConnectionsFocusAndReset({ mode: 'edit', id })}
                        onPickNew={() => setConnectionsFocusAndReset({ mode: 'picker' })}
                        onDelete={handleDeleteConnection}
                        onToggleEnabled={handleToggleConnectionEnabled}
                      />
                    </div>
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
