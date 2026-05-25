import { useMemo, useRef, useState, type DragEvent } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  cn,
} from '@roomy-ai/ui'
import {
  useCreateAgentMutation,
  useDeleteAgentMutation,
  useGetAgentsQuery,
  useGetLocalSourcesQuery,
  useGetModelsQuery,
  useGetProviderKeysQuery,
  usePatchAgentMutation,
  usePreviewModelsMutation,
  usePutLocalSourceMutation,
  usePutProviderKeysMutation,
  useReorderAgentsMutation,
  type ModelRef,
} from '@/store/api'
import type { ServerAgent } from '@/store/types'
import {
  CONNECTION_CATALOG,
  managedConnectionDefinitionForKind,
  providerKeyForKind,
  type ConnectionKind,
} from '@/data/connections'
import { useScrolledUnder } from '@/hooks/use-scrolled-under'
import { describeApiError } from '@/components/settings/errors'
import { isVaultLockedError } from '@/lib/api-error'
import { useAppDispatch } from '@/store/hooks'
import { openVaultDialog } from '@/store/slices/uiSlice'

type StatusFilter = 'all' | 'active' | 'inactive'

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all',      label: 'All'      },
  { value: 'active',   label: 'Active'   },
  { value: 'inactive', label: 'Inactive' },
]

type ModelsFocus =
  | { mode: 'edit'; id: string }
  | { mode: 'new' }
  | null

type DropPosition = 'before' | 'after'

interface LocalSourceState {
  kind: string
  available: boolean
  enabled: boolean
  reason?: string
  detail?: Record<string, string | number | boolean>
}

type ModelProviderOption = {
  provider: string
  label: string
  description: string
  placeholder: string
  kind?: ConnectionKind
  localSourceKind?: string
}

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  codex: 'codex/gpt-5.5',
  anthropic: 'anthropic/claude-sonnet-4-6',
  openai: 'openai/gpt-5.4',
}

const MODEL_PROVIDER_OPTIONS: ModelProviderOption[] = [
  {
    provider: 'codex',
    label: 'Codex',
    description: CONNECTION_CATALOG.codex.description,
    placeholder: DEFAULT_MODEL_BY_PROVIDER.codex,
    kind: 'codex',
    localSourceKind: 'codex',
  },
  {
    provider: 'anthropic',
    label: 'Claude',
    description: CONNECTION_CATALOG.claude.description,
    placeholder: DEFAULT_MODEL_BY_PROVIDER.anthropic,
    kind: 'claude',
  },
  {
    provider: 'openai',
    label: 'ChatGPT',
    description: CONNECTION_CATALOG.chatgpt.description,
    placeholder: DEFAULT_MODEL_BY_PROVIDER.openai,
    kind: 'chatgpt',
  },
]

function modelProviderOption(provider: string): ModelProviderOption | undefined {
  return MODEL_PROVIDER_OPTIONS.find(option => option.provider === provider)
}

function modelProviderConnectionKind(provider: string): ConnectionKind | undefined {
  return modelProviderOption(provider)?.kind
}

export function modelProviderConnectionEnvKey(provider: string): string | undefined {
  const kind = modelProviderConnectionKind(provider)
  if (!kind || kind === 'codex') return undefined
  return providerKeyForKind(kind)
}

export function modelProviderFromModelId(model: string): string {
  const trimmed = model.trim()
  const slash = trimmed.indexOf('/')
  return slash > 0 ? trimmed.slice(0, slash) : ''
}

export function normalizeModelIdForProvider(provider: string, model: string): string {
  const trimmed = model.trim()
  if (!trimmed) return ''
  if (!provider) return trimmed
  if (trimmed.includes('/')) return trimmed
  return `${provider}/${trimmed}`
}

export function reorderModelIds(
  ids: string[],
  activeId: string,
  overId: string,
  position: DropPosition,
): string[] {
  if (activeId === overId) return ids
  const from = ids.indexOf(activeId)
  const over = ids.indexOf(overId)
  if (from < 0 || over < 0) return ids

  const next = ids.filter(id => id !== activeId)
  const overAfterRemoval = next.indexOf(overId)
  if (overAfterRemoval < 0) return ids
  const insertAt = position === 'before' ? overAfterRemoval : overAfterRemoval + 1
  next.splice(insertAt, 0, activeId)
  return next
}

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

function providerLabel(provider: string): string {
  if (provider === 'anthropic') return 'Claude'
  if (provider === 'openai')    return 'ChatGPT'
  if (provider === 'codex')     return 'Codex'
  return provider
}

export function modelProviderCredentialScopeText(
  provider: string,
  mode: 'new' | 'edit',
  hasSavedCredential = false,
): string | undefined {
  if (!modelProviderConnectionEnvKey(provider)) return undefined
  const label = providerLabel(provider)
  if (mode === 'new') {
    if (hasSavedCredential) {
      return `This model will reuse the shared ${label} API key unless you enter a replacement.`
    }
    return `This saves one shared ${label} API key for every ${label} model.`
  }
  return `One ${label} API key is shared by every ${label} model. Updating it here replaces that shared key.`
}

export function modelProviderCredentialRequired(
  provider: string,
  mode: 'new' | 'edit',
  hasSavedCredential: boolean,
): boolean {
  return mode === 'new' && Boolean(modelProviderConnectionEnvKey(provider)) && !hasSavedCredential
}

function brandKindForProvider(provider: string): ConnectionKind | null {
  if (provider === 'anthropic') return 'claude'
  if (provider === 'openai')    return 'chatgpt'
  if (provider === 'codex')     return 'codex'
  return null
}

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

function AgentGlyph({ provider, size = 'lg' }: { provider: string | undefined; size?: 'sm' | 'md' | 'lg' }) {
  const kind = provider ? brandKindForProvider(provider) : null
  if (kind) return <ConnectionGlyph kind={kind} size={size} />
  const box = size === 'sm' ? 'h-5 w-5' : size === 'lg' ? 'h-10 w-10' : 'h-8 w-8'
  return <span className={cn('shrink-0 rounded-lg bg-muted', box)} />
}

function StatusFilterPills({
  value, onChange,
}: { value: StatusFilter; onChange: (next: StatusFilter) => void }) {
  return (
    <div className="flex w-full items-center rounded-lg border p-0.5 sm:w-auto">
      {STATUS_FILTERS.map(f => (
        <button
          key={f.value}
          onClick={() => onChange(f.value)}
          className={cn(
            'flex-1 rounded-md px-3 py-1 text-xs font-medium transition-colors sm:flex-none',
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
    <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
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
    <div className="min-w-0 max-w-full space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
      {help && <p className="text-xs text-muted-foreground/80 break-words">{help}</p>}
    </div>
  )
}

function EmptyState({
  title, body, action,
}: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="min-w-0 max-w-full rounded-xl border border-dashed px-4 py-10 text-center flex flex-col items-center gap-3 sm:px-6">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground max-w-sm break-words">{body}</p>
      {action}
    </div>
  )
}

function buildModelIndex(
  apiModels: ModelRef[],
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

  if (currentModel && !seenIds.has(currentModel)) {
    const slash = currentModel.indexOf('/')
    const provider = slash > 0 ? currentModel.slice(0, slash) : 'unknown'
    add({ provider, id: currentModel, label: currentModel })
  }

  return byProvider
}

function allModels(modelIndex: Map<string, ModelRef[]>): ModelRef[] {
  const out: ModelRef[] = []
  for (const models of modelIndex.values()) out.push(...models)
  return out
}

function modelsForProvider(modelIndex: Map<string, ModelRef[]>, provider: string): ModelRef[] {
  return modelIndex.get(provider) ?? []
}

function defaultModelForProvider(modelIndex: Map<string, ModelRef[]>, provider: string): string {
  return modelsForProvider(modelIndex, provider)[0]?.id
    ?? DEFAULT_MODEL_BY_PROVIDER[provider]
    ?? (provider ? `${provider}/` : '')
}

function providerOptionsWithCurrent(provider: string): ModelProviderOption[] {
  if (!provider || modelProviderOption(provider)) return MODEL_PROVIDER_OPTIONS
  return [
    ...MODEL_PROVIDER_OPTIONS,
    {
      provider,
      label: providerLabel(provider),
      description: 'Custom provider',
      placeholder: DEFAULT_MODEL_BY_PROVIDER[provider] ?? `${provider}/model-name`,
    },
  ]
}

function localSourceStatusText(provider: string, localSource: LocalSourceState | undefined): string {
  if (!localSource) return 'Checking local sign-in...'
  if (localSource.available) {
    const email = typeof localSource.detail?.email === 'string' ? localSource.detail.email : undefined
    return email ? `Detected as ${email}` : 'Detected on this machine'
  }
  if (provider === 'codex') {
    if (localSource.reason === 'missing') return 'Codex sign-in was not detected on this machine.'
    if (localSource.reason === 'wrong_mode') return 'Codex is using an API key instead of a ChatGPT sign-in.'
    if (localSource.reason === 'expired_no_refresh') return 'Codex sign-in is expired.'
  }
  return 'Not detected on this machine.'
}

function dropPositionFromEvent(event: DragEvent<HTMLElement>): DropPosition {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

function ModelsList({
  agents, modelIndex, statusFilter, search,
  onOpen, onAdd, onDelete, onToggleEnabled, onMove, onReorder,
}: {
  agents: ServerAgent[]
  modelIndex: Map<string, ModelRef[]>
  statusFilter: StatusFilter
  search: string
  onOpen: (id: string) => void
  onAdd: () => void
  onDelete: (id: string) => void
  onToggleEnabled: (id: string, next: boolean) => void
  onMove: (id: string, direction: -1 | 1) => void
  onReorder: (ids: string[]) => void
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition } | null>(null)
  const q = search.trim().toLowerCase()
  const filtered = agents
    .filter(a => statusFilter === 'all'
      || (statusFilter === 'active' && a.enabled)
      || (statusFilter === 'inactive' && !a.enabled))
    .filter(a => !q || a.name.toLowerCase().includes(q) || a.model.toLowerCase().includes(q))
  const modelRefs = allModels(modelIndex)

  if (agents.length === 0) {
    return (
      <EmptyState
        title="No models yet"
        body="Add a model to make it available across your workspaces."
        action={
          <Button size="sm" className="gap-1.5" onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" />Add model
          </Button>
        }
      />
    )
  }
  if (filtered.length === 0) {
    return <EmptyState title="No matches" body={q ? `No models match "${q}".` : 'No models in this filter.'} />
  }

  return (
    <div className="flex min-w-0 flex-col overflow-hidden">
      {filtered.map((a, i) => {
        const model = modelRefs.find(m => m.id === a.model)
        const provider = model?.provider ?? modelProviderFromModelId(a.model)
        const orderIndex = agents.findIndex(item => item.id === a.id)
        const showDropBefore = dropTarget?.id === a.id && dropTarget?.position === 'before'
        const showDropAfter = dropTarget?.id === a.id && dropTarget?.position === 'after'
        const handleDrop = (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault()
          const activeId = draggingId ?? event.dataTransfer.getData('application/x-roomy-model-id')
          const position = dropPositionFromEvent(event)
          setDraggingId(null)
          setDropTarget(null)
          if (!activeId) return
          const next = reorderModelIds(agents.map(item => item.id), activeId, a.id, position)
          if (next.join('\0') !== agents.map(item => item.id).join('\0')) onReorder(next)
        }
        return (
          <motion.div
            key={a.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.02, duration: 0.15, ease: 'easeOut' }}
            onDragOver={(event) => {
              if (!draggingId || draggingId === a.id) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDropTarget({ id: a.id, position: dropPositionFromEvent(event) })
            }}
            onDrop={handleDrop}
            className={cn(
              'group relative flex min-w-0 max-w-full items-center gap-2 py-4 border-b last:border-b-0 sm:gap-3',
              draggingId === a.id && 'opacity-45',
            )}
          >
            {showDropBefore && <span className="absolute inset-x-0 top-0 h-0.5 rounded-full bg-foreground/70" />}
            {showDropAfter && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-foreground/70" />}
            <button
              type="button"
              draggable
              title={`Drag ${a.name}`}
              aria-label={`Drag ${a.name} to reorder`}
              onDragStart={(event) => {
                setDraggingId(a.id)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('application/x-roomy-model-id', a.id)
              }}
              onDragEnd={() => {
                setDraggingId(null)
                setDropTarget(null)
              }}
              className="hidden h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing sm:flex"
            >
              <GripVertical className="h-4 w-4" aria-hidden />
            </button>
            <Switch
              checked={a.enabled}
              onCheckedChange={(next) => onToggleEnabled(a.id, next)}
              aria-label={`${a.enabled ? 'Disable' : 'Enable'} ${a.name} globally`}
            />
            <AgentGlyph provider={provider} size="lg" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{a.name}</p>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                {provider && <span className="shrink-0">{providerLabel(provider)}</span>}
                <span className="truncate">{model?.label ?? a.model}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                title="Move up"
                aria-label={`Move ${a.name} up`}
                disabled={orderIndex <= 0}
                onClick={() => onMove(a.id, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                title="Move down"
                aria-label={`Move ${a.name} down`}
                disabled={orderIndex < 0 || orderIndex >= agents.length - 1}
                onClick={() => onMove(a.id, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="hidden opacity-0 transition-opacity group-hover:opacity-100 sm:inline-flex"
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

function ModelDropdown({
  models, selected, placeholder, open, onOpenChange, query, onQueryChange, onSelect, loading,
}: {
  models: ModelRef[]
  selected: string
  placeholder?: string
  open: boolean
  onOpenChange: (next: boolean) => void
  query: string
  onQueryChange: (next: string) => void
  onSelect: (id: string) => void
  loading?: boolean
}) {
  const q = query.trim().toLowerCase()
  const filtered = q
    ? models.filter(m => (m.label ?? m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
    : models
  const selectedModel = models.find(m => m.id === selected)
  const selectedLabel = loading ? undefined : (selectedModel?.label ?? selected)
  return (
    <div className="rounded-md border overflow-hidden">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        disabled={loading}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60"
        aria-expanded={open}
      >
        <span className={cn('truncate', (!selectedLabel || loading) && 'text-muted-foreground')}>
          {loading ? 'Loading models…' : (selectedLabel || placeholder || 'Select a model')}
        </span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={e => onQueryChange(e.target.value)}
              placeholder="Search models..."
              className="h-9 rounded-none border-0 border-b pl-8 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>
          <div className="max-h-56 overflow-y-auto overscroll-contain">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-center text-xs text-muted-foreground">No models found.</p>
            ) : (
              filtered.map(m => {
                const isSelected = selected === m.id
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onSelect(m.id)
                      onOpenChange(false)
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50',
                      isSelected && 'bg-muted/70',
                    )}
                  >
                    <span className="truncate">{m.label ?? m.id}</span>
                    {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ModelDetail({
  agents, modelIndex, modelsLoading, localSources, providerKeys, focus, busy, onSave, onCancel, onDelete,
}: {
  agents: ServerAgent[]
  modelIndex: Map<string, ModelRef[]>
  modelsLoading: boolean
  localSources: Record<string, LocalSourceState>
  providerKeys: Record<string, string | null>
  focus: Exclude<ModelsFocus, null>
  busy: boolean
  onSave: (v: { id?: string; name: string; model: string; provider: string; credentialSecret?: string }) => void
  onCancel: () => void
  onDelete: (id: string) => void
}) {
  const [previewModels, { isLoading: previewingModels }] = usePreviewModelsMutation()
  const existing = focus.mode === 'edit' ? agents.find(a => a.id === focus.id) : undefined
  const flatModels = useMemo(() => allModels(modelIndex), [modelIndex])
  const initialProvider = existing
    ? modelProviderFromModelId(existing.model)
    : (flatModels[0]?.provider ?? MODEL_PROVIDER_OPTIONS[0].provider)
  const initialModel = existing?.model ?? defaultModelForProvider(modelIndex, initialProvider)

  const [name, setName] = useState(existing?.name ?? (agents.length === 0 ? 'Default' : ''))
  const [model, setModel] = useState(initialModel)
  const [provider, setProvider] = useState(initialProvider)
  const [credentialSecret, setCredentialSecret] = useState('')
  // The picker is inline (not a popover) because the form is rendered
  // inside small constrained surfaces (signup card, account modal); a
  // floating popover got clipped by their overflow containers.
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  // Cache preview results per-provider for the lifetime of this form so
  // switching providers and back doesn't drop the dynamically-fetched
  // catalog. Key is the provider id, value is the model list.
  const [previewByProvider, setPreviewByProvider] = useState<Record<string, ModelRef[]>>({})
  // Tracks the last (provider, secret) pair we've issued a preview for,
  // so repeated blurs without a change don't re-fire the request.
  const lastPreviewRef = useRef<string>('')
  const { ref: scrollRef, scrolledUnder } = useScrolledUnder()

  const providerOption = modelProviderOption(provider)
  const providerOptions = providerOptionsWithCurrent(provider)
  const providerModels = useMemo<ModelRef[]>(() => {
    const fetched = modelsForProvider(modelIndex, provider)
    const previewed = previewByProvider[provider] ?? []
    const seen = new Set<string>()
    const merged: ModelRef[] = []
    for (const m of [...fetched, ...previewed]) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      merged.push(m)
    }
    // Make sure the currently selected model is always selectable once the
    // catalog has loaded (e.g. brand-new provider key, or the default
    // placeholder model for a provider with no live listing). Skip while
    // loading so the dropdown shows nothing until real data arrives.
    if (!modelsLoading && model && !seen.has(model)) {
      merged.unshift({ provider, id: model, label: model })
    }
    return merged
  }, [modelIndex, modelsLoading, previewByProvider, provider, model])
  const connectionEnvKey = modelProviderConnectionEnvKey(provider)
  const connectionKind = modelProviderConnectionKind(provider)
  const connectionDefinition = connectionKind ? managedConnectionDefinitionForKind(connectionKind) : undefined
  const savedCredentialMask = connectionEnvKey ? providerKeys[connectionEnvKey] : null
  const hasSavedCredential = Boolean(savedCredentialMask)
  const credentialScopeText = modelProviderCredentialScopeText(provider, focus.mode, hasSavedCredential)
  const localSource = providerOption?.localSourceKind ? localSources[providerOption.localSourceKind] : undefined
  const localSourceUnavailable = providerOption?.localSourceKind !== undefined && localSource?.available === false
  const normalizedModel = normalizeModelIdForProvider(provider, model)
  const needsCredential = modelProviderCredentialRequired(provider, focus.mode, hasSavedCredential)
  // The Model ID field is only meaningful once we know how the agent will
  // authenticate — otherwise we'd be asking the user to pick a model we
  // can't list yet (the listing endpoint requires saved keys / opted-in
  // local sources). For credential providers, "ready" means a key is
  // saved OR being entered now; for local-source providers (Codex),
  // "ready" means the sign-in is detected on this host; for unknown /
  // custom providers we don't gate.
  const credentialReady = connectionEnvKey
    ? hasSavedCredential || credentialSecret.trim().length > 0
    : providerOption?.localSourceKind
      ? !localSourceUnavailable
      : true
  const canSave = name.trim().length > 0
    && normalizedModel.length > 0
    && (!needsCredential || credentialSecret.trim().length > 0)
    && !localSourceUnavailable

  const selectProvider = (next: string) => {
    setProvider(next)
    setModel(defaultModelForProvider(modelIndex, next))
    setCredentialSecret('')
  }

  const runPreview = async (forProvider: string, secret: string) => {
    const envKey = modelProviderConnectionEnvKey(forProvider)
    if (!envKey) return
    const trimmed = secret.trim()
    if (trimmed.length < 10) return  // skip until the user has typed a plausible key
    const fingerprint = `${forProvider}:${trimmed}`
    if (lastPreviewRef.current === fingerprint) return
    lastPreviewRef.current = fingerprint
    try {
      const list = await previewModels({
        provider: forProvider,
        providerKeys: { [envKey]: trimmed },
      }).unwrap()
      setPreviewByProvider(prev => ({ ...prev, [forProvider]: list }))
    } catch {
      // Bad key (sandbox rejects), network error, etc. — leave the picker
      // empty and let the user proceed with the placeholder default.
    }
  }

  const handleSave = () => {
    if (!canSave) return
    onSave({
      id: existing?.id,
      name: name.trim(),
      model: normalizedModel,
      provider,
      credentialSecret: credentialSecret.trim() || undefined,
    })
  }

  return (
    <div className="flex-1 flex min-w-0 flex-col min-h-0 overflow-hidden">
      <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 pt-3 pb-4 space-y-4">
        <Field label="Name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Daily driver" />
        </Field>

        <Field label="Connection">
          <select
            value={provider}
            aria-label="Connection"
            onChange={e => selectProvider(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent pl-3 pr-8 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20fill%3D%22none%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22M4%206l4%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.5rem_center]"
          >
            {providerOptions.map(option => (
              <option key={option.provider} value={option.provider}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground/80 break-words">
            {providerOption?.description ?? providerLabel(provider)}
          </p>
        </Field>

        {connectionEnvKey && (
          <div className="space-y-2">
            {credentialScopeText && (
              <div
                data-testid={`model-provider-credential-scope-${connectionEnvKey}`}
                className="rounded-md border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
              >
                <p>{credentialScopeText}</p>
                <p className="mt-1 font-mono text-[11px] text-muted-foreground/75">{connectionEnvKey}</p>
                {savedCredentialMask && (
                  <p className="mt-1 text-muted-foreground/85">Saved shared key: {savedCredentialMask}</p>
                )}
              </div>
            )}
            <Field
              label={connectionDefinition?.secretLabel ?? 'API key'}
            >
              <Input
                type="password"
                value={credentialSecret}
                onChange={e => setCredentialSecret(e.target.value)}
                onBlur={() => { void runPreview(provider, credentialSecret) }}
                placeholder={savedCredentialMask ?? connectionDefinition?.secretPlaceholder ?? 'API key'}
                autoComplete="off"
                data-testid={connectionEnvKey ? `model-provider-credential-${connectionEnvKey}` : undefined}
              />
            </Field>
          </div>
        )}

        {providerOption?.localSourceKind && (
          <Field label="Local sign-in">
            <div className={cn(
              'rounded-md border px-3 py-2 text-sm',
              localSourceUnavailable ? 'border-destructive/30 text-destructive' : 'bg-muted/30 text-muted-foreground',
            )}>
              {localSourceStatusText(provider, localSource)}
            </div>
          </Field>
        )}

        {credentialReady && (
          <Field
            label="Model"
            help={previewingModels ? 'Fetching available models…' : undefined}
          >
            <ModelDropdown
              models={providerModels}
              selected={model}
              placeholder={providerOption?.placeholder ?? `${provider}/model-name`}
              open={modelPickerOpen}
              onOpenChange={setModelPickerOpen}
              query={modelQuery}
              onQueryChange={setModelQuery}
              onSelect={(id) => setModel(id)}
              loading={modelsLoading}
            />
          </Field>
        )}
      </div>

      <div
        className={cn(
          'shrink-0 p-4 flex min-w-0 flex-col items-stretch gap-2 border-t border-transparent sm:flex-row sm:items-center sm:justify-between',
          scrolledUnder && 'border-border',
        )}
      >
        <div>
          {focus.mode === 'edit' && existing && (
            <Popover open={deleteOpen} onOpenChange={setDeleteOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive gap-1.5">
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete model
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-4" align="start">
                <p className="text-sm font-medium mb-1">Delete {existing.name}?</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Any chats assigned to this model will lose it. This cannot be undone.
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
        <div className="flex min-w-0 items-center gap-2 sm:justify-end">
          <Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" className="flex-1 sm:flex-none" onClick={handleSave} disabled={!canSave || busy}>
            {focus.mode === 'new' ? (busy ? 'Adding...' : 'Add model') : (busy ? 'Saving...' : 'Save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface ModelsSectionProps {
  /** Controlled focus state (new / edit / null). Lives in the URL so
   * deep-linking + reload preserves the open detail page. */
  focus: ModelsFocus
  onChangeFocus: (next: ModelsFocus) => void
}

export function ModelsSection({ focus, onChangeFocus }: ModelsSectionProps) {
  const dispatch = useAppDispatch()
  const { data: serverAgents } = useGetAgentsQuery()
  const { data: models, isLoading: modelsLoading } = useGetModelsQuery()
  const { data: localSourcesData } = useGetLocalSourcesQuery()
  const { data: providerKeys } = useGetProviderKeysQuery()
  const [createAgent, { isLoading: creatingAgent }] = useCreateAgentMutation()
  const [patchAgent, { isLoading: patchingAgent }] = usePatchAgentMutation()
  const [putProviderKeys, { isLoading: savingProviderKey }] = usePutProviderKeysMutation()
  const [putLocalSource, { isLoading: savingLocalSource }] = usePutLocalSourceMutation()
  const [deleteAgent] = useDeleteAgentMutation()
  const [reorderAgents] = useReorderAgentsMutation()

  const agents = serverAgents ?? []
  const localSources = useMemo<Record<string, LocalSourceState>>(() => {
    const out: Record<string, LocalSourceState> = {}
    for (const source of localSourcesData?.sources ?? []) out[source.kind] = source
    return out
  }, [localSourcesData])
  const setFocus = onChangeFocus
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const setFocusAndReset = (next: ModelsFocus) => {
    setFocus(next)
    setSearch('')
  }

  const editingModel = focus?.mode === 'edit'
    ? agents.find(a => a.id === focus.id)?.model ?? ''
    : ''
  const modelIndex = useMemo(
    () => buildModelIndex(models ?? [], editingModel),
    [models, editingModel],
  )

  const handleSave = async (v: { id?: string; name: string; model: string; provider: string; credentialSecret?: string }) => {
    try {
      const envKey = modelProviderConnectionEnvKey(v.provider)
      if (envKey) {
        const secret = v.credentialSecret?.trim()
        const hasSavedCredential = Boolean(providerKeys?.[envKey])
        const needsCredential = modelProviderCredentialRequired(v.provider, v.id ? 'edit' : 'new', hasSavedCredential)
        if (needsCredential && !secret) {
          toast.error('API key is required')
          return
        }
        if (secret) await putProviderKeys({ [envKey]: secret }).unwrap()
      }
      if (v.provider === 'codex') {
        await putLocalSource({ kind: 'codex', enabled: true }).unwrap()
      }
      if (v.id) {
        await patchAgent({ id: v.id, patch: { name: v.name, model: v.model } }).unwrap()
      } else {
        await createAgent({ name: v.name, model: v.model }).unwrap()
      }
      setFocus(null)
    } catch (err) {
      if (isVaultLockedError(err)) {
        dispatch(openVaultDialog({}))
        return
      }
      toast.error('Could not save model', { description: describeApiError(err) })
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteAgent(id).unwrap()
      setFocus(null)
    } catch (err) {
      toast.error('Could not delete model', { description: describeApiError(err) })
    }
  }

  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    try {
      await patchAgent({ id, patch: { enabled } }).unwrap()
    } catch (err) {
      toast.error(enabled ? 'Could not enable model' : 'Could not disable model', { description: describeApiError(err) })
    }
  }

  const handleMove = async (id: string, direction: -1 | 1) => {
    const index = agents.findIndex(a => a.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= agents.length) return
    const ids = reorderModelIds(
      agents.map(a => a.id),
      id,
      agents[target].id,
      direction === -1 ? 'before' : 'after',
    )
    await handleReorder(ids)
  }

  const handleReorder = async (ids: string[]) => {
    const current = agents.map(a => a.id)
    if (ids.join('\0') === current.join('\0')) return
    try {
      await reorderAgents(ids).unwrap()
    } catch (err) {
      toast.error('Could not reorder models', { description: describeApiError(err) })
    }
  }

  if (focus !== null) {
    return (
      <ModelDetail
        agents={agents}
        modelIndex={modelIndex}
        modelsLoading={modelsLoading}
        localSources={localSources}
        providerKeys={providerKeys ?? {}}
        focus={focus}
        busy={creatingAgent || patchingAgent || savingProviderKey || savingLocalSource}
        onSave={handleSave}
        onCancel={() => setFocus(null)}
        onDelete={handleDelete}
        key={focus.mode === 'edit' ? focus.id : 'new'}
      />
    )
  }

  return (
    <div className="flex-1 w-full min-w-0 max-w-full overflow-y-auto overflow-x-hidden px-4 pt-3 pb-6">
      <div className="min-w-0 max-w-full space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <StatusFilterPills value={statusFilter} onChange={setStatusFilter} />
          <div className="flex w-full min-w-0 max-w-full items-center gap-2 sm:w-auto">
            <SearchInput value={search} onChange={setSearch} placeholder="Search models..." />
            <Button size="sm" className="gap-1.5" onClick={() => setFocusAndReset({ mode: 'new' })}>
              <Plus className="h-3.5 w-3.5" />Add
            </Button>
          </div>
        </div>
        <ModelsList
          agents={agents}
          modelIndex={modelIndex}
          statusFilter={statusFilter}
          search={search}
          onOpen={(id) => setFocusAndReset({ mode: 'edit', id })}
          onAdd={() => setFocusAndReset({ mode: 'new' })}
          onDelete={handleDelete}
          onToggleEnabled={handleToggleEnabled}
          onMove={handleMove}
          onReorder={handleReorder}
        />
      </div>
    </div>
  )
}
