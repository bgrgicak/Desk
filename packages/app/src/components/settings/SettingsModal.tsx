import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import {
  Settings2, Bot, Plug, Sliders,
  Trash2, Plus, ChevronDown, X, Search,
  Pencil, MessageSquare, Copy, MoreHorizontal,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Button,
  Input,
  Switch,
  Textarea,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from '@agent-desk/ui'
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
  useGetConnectorConnectionsQuery,
  useCreateConnectorConnectionMutation,
  usePatchConnectorConnectionMutation,
  useDeleteConnectorConnectionMutation,
  useGetProvidersMetaQuery,
  usePutProvidersMetaMutation,
  useGetLocalSourcesQuery,
  usePutLocalSourceMutation,
  useGetMeQuery,
  type ModelRef,
} from '@/store/api'
import type { ConnectorConnection as ServerConnectorConnection, ServerAgent } from '@/store/types'
import {
  CONNECTION_CATALOG,
  CONNECTOR_PROVIDER_BY_KIND,
  DEFAULT_CAPABILITIES_BY_CONNECTOR_KIND,
  DEFAULT_SCOPES_BY_CONNECTOR_KIND,
  allowsMultipleConnections,
  isLocalSourceKind,
  managedConnectionDefinitionForKind,
  providerKeyEntries,
  providerKeyForKind,
  type Connection,
  type ConnectionKind,
} from '@/data/connections'
import { useCompactViewport } from '@/hooks/use-compact-viewport'
import type { ManagedConnectionDefinition } from '@agent-desk/shared'
import { LOCAL_FILESYSTEM_CONNECTION_KIND } from '@agent-desk/shared'

interface LocalSourceState {
  kind: string
  available: boolean
  enabled: boolean
  reason?: string
  detail?: Record<string, string | number | boolean>
}

type LocalFilesystemDirectoryForm = {
  id: string
  hostPath: string
  access: 'read_only' | 'read_write'
  description: string
}

function localFilesystemDirectoriesFromMetadata(metadata: Record<string, unknown> | undefined): LocalFilesystemDirectoryForm[] {
  const root = metadata?.localFilesystem
  const dirs = root && typeof root === 'object' && !Array.isArray(root)
    ? (root as { directories?: unknown }).directories
    : undefined
  if (!Array.isArray(dirs)) return []
  return dirs.map((raw, index) => {
    const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    return {
      id: typeof entry.id === 'string' ? entry.id : `dir_${index + 1}`,
      hostPath: typeof entry.hostPath === 'string' ? entry.hostPath : '',
      access: entry.access === 'read_only' ? 'read_only' : 'read_write',
      description: typeof entry.description === 'string' ? entry.description : '',
    }
  })
}

function defaultLocalDirectory(): LocalFilesystemDirectoryForm {
  return { id: `dir_${Date.now()}`, hostPath: '', access: 'read_write', description: '' }
}

type ProviderMetaEntry = {
  name?: string
  enabled?: boolean
}

/**
 * Per-kind copy for the unavailable-source state. The set of recognised
 * reasons grows as we register more local sources; falling back to a
 * generic "not detected" message keeps the UI safe for unknown reasons.
 */
function describeLocalSourceReason(kind: string, reason: string | undefined): string {
  if (kind === 'codex') {
    if (reason === 'missing') return 'No `~/.codex/auth.json` was found on this machine. Run `codex` and sign in to your ChatGPT account.'
    if (reason === 'wrong_mode') return 'Codex is configured with an API key, not a ChatGPT subscription. Sign in via `codex` with your ChatGPT account.'
    if (reason === 'no_tokens' || reason === 'invalid') return 'The Codex auth file is incomplete or invalid. Re-run `codex` to refresh it.'
    if (reason === 'expired_no_refresh') return 'The Codex tokens are expired and cannot be refreshed. Re-run `codex` to sign back in.'
  }
  return 'Not detected on this machine.'
}
import type { WorkspaceInfo } from '@/components/layout/WorkspaceBar'
import { WorkspaceForm, type WorkspaceFormValues } from '@/components/workspace/WorkspaceForm'
import { useScrolledUnder } from '@/hooks/use-scrolled-under'
import { PreferenceRow } from '@/components/settings/shared'
import { describeApiError } from '@/components/settings/errors'

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


// ── Nav sections ─────────────────────────────────────────────────────────────

type NavSection = 'workspace' | 'agents' | 'connections' | 'preferences'

const NAV: { id: NavSection; label: string; icon: typeof Settings2 }[] = [
  { id: 'workspace',   label: 'Workspace',   icon: Settings2 },
  { id: 'agents',      label: 'Agents',      icon: Bot       },
  { id: 'connections', label: 'Connections', icon: Plug      },
  { id: 'preferences', label: 'Preferences', icon: Sliders   },
]

// Provider id → brand glyph kind. Anything not in the map renders the
// generic muted square. `codex` is the Codex-via-ChatGPT-subscription path
// for OpenAI models — distinct from the API-key-backed `openai` provider.
function brandKindForProvider(provider: string): ConnectionKind | null {
  if (provider === 'anthropic') return 'claude'
  if (provider === 'openai')    return 'chatgpt'
  if (provider === 'codex')     return 'codex'
  return null
}

// Connection kinds that the picker can actually configure (i.e. we have a
// backend to persist them). Other catalog entries appear in the picker
// but are disabled. Local-source kinds (Codex, future LM Studio / Ollama)
// count as functional only when the host has them available; cloud kinds
// count as functional whenever they have a registered env-key mapping.
function isFunctionalKind(
  kind: ConnectionKind,
  localSources: Record<string, LocalSourceState>,
): boolean {
  if (isLocalSourceKind(kind)) return localSources[kind]?.available === true
  if (CONNECTOR_PROVIDER_BY_KIND[kind] !== undefined) return true
  return providerKeyForKind(kind) !== undefined
}

// Build the connections list from the persisted connection keys + every
// host-detected local source. Cloud (API-key) kinds show up once their
// key is saved; local-source kinds show up whenever the host has them
// available, and their switch reflects the per-user server-side opt-in.
// Custom display names come from providerMeta (cloud only).
function deriveConnections(
  providerKeys: Record<string, string | null>,
  providerMeta: Record<string, { name?: string; enabled?: boolean }>,
  connectorConnections: ServerConnectorConnection[],
  localSources: Record<string, LocalSourceState>,
): Connection[] {
  const out: Connection[] = []
  for (const [kind, envKey] of providerKeyEntries()) {
    if (providerKeys[envKey]) {
      const catalogMeta = CONNECTION_CATALOG[kind]
      const entry = providerMeta[envKey]
      out.push({
        id: `conn-${kind}`,
        kind,
        name: entry?.name || catalogMeta.name,
        // The flag is opt-out: omitted/`true` = on. Disable persists via
        // providersMeta and is honored server-side when forwarding keys
        // to the sandbox.
        enabled: entry?.enabled !== false,
      })
    }
  }
  for (const [kind, providerId] of Object.entries(CONNECTOR_PROVIDER_BY_KIND) as [ConnectionKind, string][]) {
    for (const connection of connectorConnections.filter(c => c.providerId === providerId)) {
      const catalogMeta = CONNECTION_CATALOG[kind]
      out.push({
        id: connection.id,
        kind,
        name: connection.displayName || catalogMeta.name,
        enabled: connection.status === 'active' && connection.hasCredentials,
        externalAccountId: connection.externalAccountId,
      })
    }
  }
  for (const [kind, source] of Object.entries(localSources) as [ConnectionKind, LocalSourceState][]) {
    if (!source.available) continue
    const catalogMeta = CONNECTION_CATALOG[kind]
    if (!catalogMeta) continue
    out.push({
      id: `conn-${kind}`,
      kind,
      name: catalogMeta.name,
      enabled: source.enabled === true,
    })
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

function GitHubTokenGuide() {
  return (
    <div
      className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground space-y-2"
      data-testid="github-token-guide"
    >
      <p className="font-medium text-foreground">Create a GitHub classic token for Desk</p>
      <ol className="list-decimal space-y-1 pl-4">
        <li>
          Open{' '}
          <a
            className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
            href="https://github.com/settings/tokens/new?description=Desk&scopes=repo,workflow"
            target="_blank"
            rel="noreferrer"
          >
            GitHub → Tokens (classic)
          </a>
          {' '}and create a token named “Desk”.
        </li>
        <li>Set an expiration you are comfortable with.</li>
        <li>
          Select the <strong>repo</strong> scope so agents can clone, push, open pull requests,
          and work with issues across repositories your GitHub account can access.
        </li>
        <li>
          Keep <strong>workflow</strong> selected if agents should edit GitHub Actions workflow files;
          otherwise you can remove it.
        </li>
        <li>Copy the token once, paste it below, then Apply. Sandboxes receive it as <code>GITHUB_TOKEN</code> and <code>GH_TOKEN</code> for <code>git</code> and <code>gh</code>.</li>
      </ol>
      <p>
        Classic tokens are the simplest path for now and match how <code>gh</code> and HTTPS <code>git</code>
        expect to authenticate from a sandbox.
      </p>
    </div>
  )
}

function connectionManualGuide(definition: ManagedConnectionDefinition | undefined): React.ReactNode {
  switch (definition?.manualGuide) {
    case 'github-pat':
      return <GitHubTokenGuide />
    default:
      return null
  }
}

function TokenConnectionForm({
  definition, envKey, value, dirty, busy, onChange, onSave,
}: {
  definition: ManagedConnectionDefinition | undefined
  envKey: string | undefined
  value: string
  dirty: boolean
  busy: boolean
  onChange: (value: string) => void
  onSave: () => void | Promise<void>
}) {
  return (
    <>
      {connectionManualGuide(definition)}
      <Field
        label={definition?.secretLabel ?? 'API key'}
        help={envKey
          ? 'Stored encrypted on the server. Saved keys appear masked on reload — submit a fresh value to overwrite.'
          : 'Stored locally. Used to authenticate against the service.'}
      >
        <div className="flex min-w-0 max-w-full flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            type="password"
            value={value}
            onChange={e => onChange(e.target.value)}
            data-testid={envKey ? `provider-key-${envKey}` : undefined}
            placeholder={definition?.secretPlaceholder ?? 'Paste the API key or token'}
            className="min-w-0 flex-1"
          />
          {envKey && (
            <Button
              type="button"
              size="sm"
              className="w-full sm:w-auto"
              disabled={!dirty || busy}
              data-testid={`provider-save-${envKey}`}
              onClick={onSave}
            >
              {busy ? 'Saving…' : 'Apply'}
            </Button>
          )}
        </div>
      </Field>
    </>
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

// Sticky-footer scroll-shadow hook — top border on the footer fades in
// once content is hidden behind it.
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
  const [deleteOpen, setDeleteOpen] = useState(false)

  const handleSubmit = async (vals: WorkspaceFormValues): Promise<string | undefined> => {
    onUpdate({ ...workspace, name: vals.name, bg: vals.color, description: vals.description })
    return workspace.id
  }

  return (
    <WorkspaceForm
      mode="edit"
      workspaceId={workspace.id}
      initial={{ name: workspace.name, description: workspace.description, color: workspace.bg }}
      submitLabel="Save changes"
      onSubmit={handleSubmit}
      footerStart={
        <Popover open={deleteOpen} onOpenChange={o => canDelete && setDeleteOpen(o)}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canDelete}
              title={canDelete ? undefined : "You need at least one workspace. Create another before deleting this one."}
              className="min-w-0 justify-start text-destructive hover:text-destructive gap-1.5 disabled:text-muted-foreground disabled:hover:text-muted-foreground"
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
      }
    />
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
  if (provider === 'codex')     return 'Codex'
  if (provider === 'opencode')  return 'OpenCode'
  return provider
}

// Builds a provider → model map from the live /tools/models response.
// opencode is the single source of truth; no fallbacks are injected.
// The agent's current model is always included so an existing selection
// is never silently dropped (e.g. if the sandbox is temporarily down).
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

  // Always surface the agent's current model so editing an existing
  // agent doesn't drop the selection if the model isn't in the live list.
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
        body="Every workspace should start with a default opencode agent. If one is missing, refresh this panel; you can change its model here once it appears."
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
    <div className="flex min-w-0 flex-col overflow-hidden">
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
            className="group flex min-w-0 max-w-full items-center gap-2 py-4 border-b last:border-b-0 sm:gap-3"
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
            <div className="flex shrink-0 items-center gap-1.5">
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
  onSave: (v: { id?: string; name: string; model: string }) => void
  onCancel: () => void
  onDelete: (id: string) => void
}) {
  const existing = focus.mode === 'edit' ? agents.find(a => a.id === focus.id) : undefined
  const flatModels = useMemo(() => {
    const out: ModelRef[] = []
    for (const ms of modelIndex.values()) out.push(...ms)
    return out
  }, [modelIndex])

  const initialModel = existing?.model ?? flatModels[0]?.id ?? ''

  const [name, setName] = useState(existing?.name ?? '')
  const [model, setModel] = useState(initialModel)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelPickerPortalContainer, setModelPickerPortalContainer] = useState<HTMLElement | null>(null)

  const canSave = name.trim().length > 0 && model.trim().length > 0
  const handleSave = () => {
    if (!canSave) return
    onSave({
      id: existing?.id,
      name: name.trim(),
      model: model.trim(),
    })
  }

  const [deleteOpen, setDeleteOpen] = useState(false)
  const { ref: scrollRef, scrolledUnder } = useScrolledUnder()

  return (
    <div ref={setModelPickerPortalContainer} className="flex-1 flex min-w-0 flex-col min-h-0 overflow-hidden">
      <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 pt-3 pb-4 space-y-4">
        <Field label="Name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Copywriter" />
        </Field>

        <Field label="Model">
          <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
            <PopoverTrigger asChild disabled={flatModels.length === 0}>
              <button
                type="button"
                disabled={flatModels.length === 0}
                className={cn(
                  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs text-left flex items-center justify-between gap-2 transition-colors',
                  'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none',
                  flatModels.length === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-muted/30',
                )}
              >
                <span className={cn('truncate', !model && 'text-muted-foreground')}>
                  {(flatModels.find(m => m.id === model)?.label ?? model) || 'Select model'}
                </span>
                <ChevronDown className="h-4 w-4 opacity-60 shrink-0" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              container={modelPickerPortalContainer ?? undefined}
              className="p-0 w-[var(--radix-popover-trigger-width)] overflow-hidden"
              align="start"
              onEscapeKeyDown={() => {
                // cmdk swallows Escape via preventDefault, which would
                // stop Radix's auto-dismiss of this Popover. We force-
                // close here instead so the outer Dialog stays open.
                setModelPickerOpen(false)
              }}
            >
              <Command>
                <CommandInput placeholder="Search models…" />
                <CommandList className="overscroll-contain">
                  <CommandEmpty>No models found.</CommandEmpty>
                  {[...modelIndex.entries()].map(([prov, models]) => (
                    <CommandGroup key={prov} heading={providerLabel(prov)}>
                      {models.map(m => (
                        <CommandItem
                          key={m.id}
                          value={m.id}
                          keywords={[m.label ?? m.id, prov]}
                          onSelect={() => { setModel(m.id); setModelPickerOpen(false) }}
                        >
                          {m.label ?? m.id}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </Field>
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
        <div className="flex min-w-0 items-center gap-2 sm:justify-end">
          <Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" className="flex-1 sm:flex-none" onClick={handleSave} disabled={!canSave || busy}>
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
  connections, availableKinds, statusFilter, search,
  onOpen, onPickNew, onPickKind, onDelete, onToggleEnabled,
}: {
  connections: Connection[]
  availableKinds: ConnectionKind[]
  statusFilter: StatusFilter
  search: string
  onOpen: (id: string) => void
  onPickNew: () => void
  onPickKind: (kind: ConnectionKind) => void
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
  const available = availableKinds.filter(kind => {
    const meta = CONNECTION_CATALOG[kind]
    return !q || meta.name.toLowerCase().includes(q) || meta.description.toLowerCase().includes(q)
  })
  const visibleAvailable = statusFilter === 'all' ? available : []

  if (connections.length === 0 && visibleAvailable.length === 0) {
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
  if (filtered.length === 0 && visibleAvailable.length === 0) {
    return <EmptyState title="No matches" body={q ? `No connections match “${q}”.` : 'No connections in this filter.'} />
  }

  return (
    <div className="flex min-w-0 flex-col overflow-hidden">
      {filtered.map((c, i) => {
        const meta = CONNECTION_CATALOG[c.kind]
        return (
          <motion.div
            key={c.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.02, duration: 0.15, ease: 'easeOut' }}
            className="group flex min-w-0 max-w-full items-center gap-2 py-4 border-b last:border-b-0 sm:gap-3"
          >
            <Switch
              checked={c.enabled}
              onCheckedChange={() => onToggleEnabled(c.id)}
              aria-label={`${c.enabled ? 'Disable' : 'Enable'} ${c.name} in this workspace`}
            />
            <ConnectionGlyph kind={c.kind} size="lg" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{c.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground truncate">
                {c.externalAccountId ? `${c.externalAccountId} · ${meta.description}` : meta.description}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="hidden opacity-0 transition-opacity group-hover:opacity-100 sm:inline-flex"
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
      {visibleAvailable.length > 0 && (
        <div className={cn('min-w-0', filtered.length > 0 && 'pt-4')}>
          {filtered.length > 0 && (
            <p className="pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Available</p>
          )}
          {visibleAvailable.map((kind, i) => {
            const meta = CONNECTION_CATALOG[kind]
            const hasExistingKind = connections.some(c => c.kind === kind)
            return (
              <motion.div
                key={`available-${kind}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: (filtered.length + i) * 0.02, duration: 0.15, ease: 'easeOut' }}
                className="group flex min-w-0 max-w-full items-center gap-2 py-4 border-b last:border-b-0 sm:gap-3"
              >
                <ConnectionGlyph kind={kind} size="lg" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{meta.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground truncate">{meta.description}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => onPickKind(kind)}
                >
                  {hasExistingKind ? 'Connect another' : 'Connect'}
                </Button>
              </motion.div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ConnectionsPicker({
  configuredKinds, localSources, onPick,
}: {
  configuredKinds: Set<ConnectionKind>
  localSources: Record<string, LocalSourceState>
  onPick: (kind: ConnectionKind) => void
}) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const entries = (Object.entries(CONNECTION_CATALOG) as [ConnectionKind, typeof CONNECTION_CATALOG[ConnectionKind]][])
    .filter(([, meta]) => !q
      || meta.name.toLowerCase().includes(q)
      || meta.description.toLowerCase().includes(q))

  return (
    <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 pt-3 pb-4 space-y-4">
      <div className="flex min-w-0 items-center justify-end">
        <SearchInput value={search} onChange={setSearch} placeholder="Search connections…" />
      </div>
      {entries.length === 0 ? (
        <EmptyState title="No matches" body={`No connections match “${q}”.`} />
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map(([kind, meta], i) => {
            const functional = isFunctionalKind(kind, localSources)
            const alreadyAdded = configuredKinds.has(kind)
            const allowsMultiple = CONNECTOR_PROVIDER_BY_KIND[kind] !== undefined
            const disabled = !functional || (alreadyAdded && !allowsMultiple)
            const localKind = isLocalSourceKind(kind)
            const badge = !functional
              ? (localKind ? 'Not detected' : 'Coming soon')
              : alreadyAdded && !allowsMultiple
                ? 'Added'
                : (localKind ? 'Detected' : null)
            return (
              <motion.button
                key={kind}
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: i * 0.03, duration: 0.18, ease: 'easeOut' }}
                onClick={() => !disabled && onPick(kind)}
                disabled={disabled}
                className={cn(
                  'group flex min-w-0 flex-col items-start gap-2 rounded-xl border bg-background p-4 text-left transition-colors',
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
                <div className="w-full min-w-0">
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
  connections, connectorConnections, focus, providerKeys, providerMeta, localSource, busySaveKey, busySaveMeta, busyGenericConnector, busyLocalSource,
  onSave, onCancel, onDelete, onSaveProviderKey, onSaveGenericConnector, onToggleLocalSource,
}: {
  connections: Connection[]
  connectorConnections: ServerConnectorConnection[]
  focus: Extract<ConnectionsFocus, { mode: 'new' } | { mode: 'edit' }>
  providerKeys: Record<string, string | null>
  providerMeta: Record<string, ProviderMetaEntry>
  localSource: LocalSourceState | undefined
  busySaveKey: boolean
  busySaveMeta: boolean
  busyGenericConnector: boolean
  busyLocalSource: boolean
  onSave: (c: Connection) => Promise<boolean>
  onCancel: () => void
  onDelete: (id: string) => void
  onSaveProviderKey: (envKey: string, value: string) => Promise<boolean>
  onSaveGenericConnector: (input: { id?: string; kind: ConnectionKind; displayName: string; externalAccountId?: string; credentials?: Record<string, unknown>; metadata?: Record<string, unknown> }) => void
  onToggleLocalSource: (kind: string, enabled: boolean) => void
}) {
  const existing = focus.mode === 'edit' ? connections.find(c => c.id === focus.id) : undefined
  const kind: ConnectionKind = existing?.kind ?? (focus.mode === 'new' ? focus.kind : 'claude')
  const catalogMeta = CONNECTION_CATALOG[kind]

  const providerEnvKey = providerKeyForKind(kind)
  const connectionDefinition = managedConnectionDefinitionForKind(kind)
  const connectorProviderId = CONNECTOR_PROVIDER_BY_KIND[kind]
  const connectorConnection = connectorProviderId && focus.mode === 'edit'
    ? connectorConnections.find(c => c.id === focus.id)
    : undefined
  const persistedKey = providerEnvKey ? providerKeys[providerEnvKey] ?? '' : ''
  const persistedName = providerEnvKey ? providerMeta[providerEnvKey]?.name ?? '' : ''
  const persistedExternalAccountId = connectorConnection?.externalAccountId ?? ''

  // For API-key/token backed connections, the secret field is the persisted masked echo on first
  // load. The user has to type a fresh value to overwrite it.
  const [name, setName]       = useState(existing?.name ?? (persistedName || catalogMeta.name))
  const [apiKey, setApiKey]   = useState(persistedKey ?? '')
  const [apiKeyDirty, setApiKeyDirty] = useState(false)
  const [externalAccountId, setExternalAccountId] = useState(persistedExternalAccountId)
  const isLocalFilesystem = kind === LOCAL_FILESYSTEM_CONNECTION_KIND
  const [localDirectories, setLocalDirectories] = useState<LocalFilesystemDirectoryForm[]>(() => {
    const existingDirs = localFilesystemDirectoriesFromMetadata(connectorConnection?.metadata)
    return existingDirs.length > 0 ? existingDirs : [defaultLocalDirectory()]
  })

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

  useEffect(() => {
    if (!isLocalFilesystem) return
    const existingDirs = localFilesystemDirectoriesFromMetadata(connectorConnection?.metadata)
    setLocalDirectories(existingDirs.length > 0 ? existingDirs : [defaultLocalDirectory()])
  }, [connectorConnection?.metadata, isLocalFilesystem])

  const handleSave = async () => {
    if (isLocalFilesystem) {
      const directories = localDirectories.map((directory, index) => ({
        id: directory.id || `dir_${index + 1}`,
        hostPath: directory.hostPath.trim(),
        access: directory.access,
        description: directory.description.trim() || undefined,
      }))
      const invalid = directories.find(directory => !directory.hostPath)
      if (invalid) {
        toast.error('Directory path is required')
        return
      }
      onSaveGenericConnector({
        id: connectorConnection?.id,
        kind,
        displayName: catalogMeta.name,
        metadata: { localFilesystem: { directories } },
      })
      return
    }
    if (connectorProviderId) {
      let credentials: Record<string, unknown> | undefined
      {
        const trimmedCredentials = apiKey.trim()
        if (focus.mode === 'new' && !trimmedCredentials) {
          toast.error('Credentials are required', {
            description: `Paste the ${catalogMeta.name} OAuth token JSON before adding this connection.`,
          })
          return
        }
        if (apiKeyDirty && trimmedCredentials) {
          try {
            credentials = JSON.parse(trimmedCredentials) as Record<string, unknown>
          } catch {
            credentials = { token: trimmedCredentials }
          }
        }
      }
      onSaveGenericConnector({
        id: connectorConnection?.id,
        kind,
        displayName: name.trim() || catalogMeta.name,
        externalAccountId: externalAccountId.trim() || undefined,
        credentials,
      })
      return
    }
    if (providerEnvKey && apiKeyDirty) {
      const savedKey = await onSaveProviderKey(providerEnvKey, apiKey.trim())
      if (!savedKey) return
      setApiKeyDirty(false)
    }

    const savedMeta = await onSave({
      id: existing?.id ?? `conn-${kind}-${Date.now()}`,
      kind,
      name: name.trim() || catalogMeta.name,
      enabled: existing?.enabled ?? true,
    })
    if (!savedMeta) return
  }

  const handleSaveKey = async () => {
    if (!providerEnvKey || !apiKeyDirty) return
    const saved = await onSaveProviderKey(providerEnvKey, apiKey.trim())
    if (saved) setApiKeyDirty(false)
  }

  const [deleteOpen, setDeleteOpen] = useState(false)
  const { ref: scrollRef, scrolledUnder } = useScrolledUnder()

  if (isLocalSourceKind(kind)) {
    const detail = localSource?.detail ?? {}
    const email = typeof detail.email === 'string' ? detail.email : undefined
    const plan = typeof detail.plan === 'string' ? detail.plan : undefined
    const expMs = typeof detail.expiresAt === 'number' ? detail.expiresAt : undefined
    const expiry = expMs ? new Date(expMs) : undefined
    const reasonLabel = describeLocalSourceReason(kind, localSource?.reason)
    return (
      <div className="flex-1 flex min-w-0 flex-col min-h-0 overflow-hidden">
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 pt-3 pb-4 space-y-4">
          <div className="flex min-w-0 max-w-full items-center gap-3">
            <ConnectionGlyph kind={kind} size="lg" />
            <div className="min-w-0 max-w-full">
              <p className="text-sm font-medium truncate">{catalogMeta.name}</p>
              <p className="text-xs text-muted-foreground break-words">{catalogMeta.description}</p>
            </div>
          </div>

          <Field
            label="Status"
            help={`Desk detects this source on the host at run time and forwards it to the sandbox — no API key required.`}
          >
            {localSource?.available ? (
              <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1">
                <p>Detected on this machine{email ? ` — ${email}` : ''}.</p>
                {(plan || expiry) && (
                  <p className="text-xs text-muted-foreground">
                    {plan ? `Plan: ${plan}` : ''}
                    {plan && expiry ? ' · ' : ''}
                    {expiry ? `Token expires ${expiry.toLocaleString()}` : ''}
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">
                {reasonLabel}
              </div>
            )}
          </Field>

          <Field
            label="Use in sandboxes"
            help="When enabled, Desk forwards this source's auth/credentials to OpenCode so it can call its models from inside the sandbox."
          >
            <div className="flex items-center gap-3">
              <Switch
                checked={localSource?.enabled === true}
                disabled={!localSource?.available || busyLocalSource}
                onCheckedChange={(next) => onToggleLocalSource(kind, next)}
                aria-label={`Toggle ${catalogMeta.name} in sandboxes`}
                data-testid={`local-source-toggle-${kind}`}
              />
              <span className="text-xs text-muted-foreground">
                {busyLocalSource ? 'Saving…' : localSource?.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </Field>
        </div>

        <div
          className={cn(
            'shrink-0 p-4 flex min-w-0 flex-col items-stretch gap-2 border-t border-transparent sm:flex-row sm:items-center sm:justify-between',
            scrolledUnder && 'border-border',
          )}
        >
          <div />
          <div className="flex min-w-0 items-center gap-2 sm:justify-end">
            <Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={onCancel}>Close</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex min-w-0 flex-col min-h-0 overflow-hidden">
      <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 pt-3 pb-4 space-y-4">
          <div className="flex min-w-0 max-w-full items-center gap-3">
            <ConnectionGlyph kind={kind} size="lg" />
            <div className="min-w-0 max-w-full">
              <p className="text-sm font-medium truncate">{catalogMeta.name}</p>
              <p className="text-xs text-muted-foreground break-words">{catalogMeta.description}</p>
            </div>
          </div>

        {!isLocalFilesystem && (
          <Field label="Display name" help="Optional custom label shown in the connections list.">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder={catalogMeta.name} />
          </Field>
        )}

        {isLocalFilesystem && (
          <Field
            label="Mounted directories"
            help="Add the server-local folders this workspace can use. Desk mounts each one into the sandbox automatically."
          >
            <div className="space-y-3">
              {localDirectories.map((directory, index) => (
                <div key={directory.id} className="space-y-3 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-muted-foreground">Directory {index + 1}</p>
                    {localDirectories.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-destructive hover:text-destructive"
                        onClick={() => setLocalDirectories((dirs) => dirs.filter((d) => d.id !== directory.id))}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                  <div className="grid gap-3">
                    <Field label="Server path" help="Absolute path on the Desk server.">
                      <Input
                        value={directory.hostPath}
                        onChange={e => setLocalDirectories((dirs) => dirs.map(d => d.id === directory.id ? { ...d, hostPath: e.target.value } : d))}
                        placeholder="/Users/you/Projects/client"
                      />
                    </Field>
                  </div>
                  <Field label="Access" help="Read-write is the default; choose read-only for reference folders.">
                    <div className="flex flex-wrap gap-2">
                      {(['read_write', 'read_only'] as const).map(access => (
                        <Button
                          key={access}
                          type="button"
                          size="sm"
                          variant={directory.access === access ? 'default' : 'outline'}
                          onClick={() => setLocalDirectories((dirs) => dirs.map(d => d.id === directory.id ? { ...d, access } : d))}
                        >
                          {access === 'read_write' ? 'Read-write' : 'Read-only'}
                        </Button>
                      ))}
                    </div>
                  </Field>
                  <Field label="Description" help="Helps the agent understand when to use this folder. Optional, but recommended.">
                    <Textarea
                      value={directory.description}
                      onChange={e => setLocalDirectories((dirs) => dirs.map(d => d.id === directory.id ? { ...d, description: e.target.value } : d))}
                      placeholder="What can the agent find here?"
                      className="min-h-20"
                    />
                  </Field>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setLocalDirectories((dirs) => [...dirs, defaultLocalDirectory()])}>
                <Plus className="h-3.5 w-3.5" />Add directory
              </Button>
            </div>
          </Field>
        )}

        {connectorProviderId && !isLocalFilesystem && (
          <Field label="Account email or ID" help="Used to distinguish multiple accounts for the same connector.">
            <Input value={externalAccountId} onChange={e => setExternalAccountId(e.target.value)} placeholder="name@example.com" />
          </Field>
        )}

        {connectorProviderId && !isLocalFilesystem ? (
          <Field
            label="Credentials"
            help="Paste OAuth token JSON; Desk stores it encrypted server-side and never echoes it back."
          >
            <Textarea
              value={apiKey}
              onChange={e => { setApiKey(e.target.value); setApiKeyDirty(true) }}
              data-testid={`connector-credentials-${connectorProviderId}`}
              placeholder={'{\n  "token": "..."\n}'}
              className="min-h-24 min-w-0 flex-1 font-mono text-xs"
            />
          </Field>
        ) : !isLocalFilesystem ? (
          <TokenConnectionForm
            definition={connectionDefinition}
            envKey={providerEnvKey}
            value={apiKey}
            dirty={apiKeyDirty}
            busy={busySaveKey}
            onChange={(value) => { setApiKey(value); setApiKeyDirty(true) }}
            onSave={handleSaveKey}
          />
        ) : null}
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
        <div className="flex min-w-0 items-center gap-2 sm:justify-end">
          <Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={onCancel} disabled={busySaveMeta || busySaveKey}>Cancel</Button>
          <Button
            type="button"
            size="sm"
            className="flex-1 sm:flex-none"
            onClick={handleSave}
            disabled={busySaveMeta || busySaveKey || busyGenericConnector || Boolean(connectorProviderId && !isLocalFilesystem && focus.mode === 'new' && !apiKey.trim())}
          >
            {focus.mode === 'new'
              ? ((busySaveMeta || busySaveKey || busyGenericConnector) ? 'Adding…' : 'Add connection')
              : ((busySaveMeta || busySaveKey || busyGenericConnector) ? 'Saving…' : 'Save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Preferences ──────────────────────────────────────────────────────────────

// Mirrors `RouteView` from `@/router/nav`, plus the special new-chat landing
// state. 'desk' is kept as a valid stored value during the deprecation window;
// `loadPrefs` normalises it to 'pinned'.
type DefaultView = 'new-chat' | 'pinned' | 'desk' | 'tasks' | 'context'

export interface PrefsShape {
  defaultView: DefaultView
  showBadges: boolean
  developerMode: boolean
}

const PREFS_DEFAULTS: PrefsShape = {
  defaultView: 'new-chat',
  showBadges: true,
  developerMode: false,
}

function prefsKey(userId: string): string {
  return `desk.prefs.${userId}`
}

const VALID_VIEWS: readonly DefaultView[] = ['new-chat', 'pinned', 'desk', 'tasks', 'context']

export function loadPrefs(userId: string | undefined): PrefsShape {
  if (!userId) return PREFS_DEFAULTS
  try {
    const raw = localStorage.getItem(prefsKey(userId))
    if (!raw) return PREFS_DEFAULTS
    const parsed = JSON.parse(raw) as Partial<PrefsShape>
    const merged = { ...PREFS_DEFAULTS, ...parsed }
    // Migrate stored 'desk' → 'pinned' (Desk was renamed to Pinned).
    if ((merged.defaultView as string) === 'desk') merged.defaultView = 'pinned'
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
    { value: 'new-chat', label: 'New chat' },
    { value: 'tasks',   label: 'Tasks'   },
    { value: 'context', label: 'Library' },
  ]

  return (
    <div className="flex min-w-0 flex-col overflow-hidden">
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
        <div className="flex w-full min-w-0 max-w-full flex-wrap overflow-hidden rounded-md border sm:w-auto">
          {VIEW_OPTIONS.map(opt => (
            <button
              key={opt.value}
              data-testid={`prefs-default-view-${opt.value}`}
              onClick={() => update({ defaultView: opt.value })}
              className={cn(
                'min-w-0 flex-1 px-3 py-1.5 text-xs font-medium transition-colors sm:flex-none',
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
  /** Optional section to focus when the modal opens. Re-applied on every
   * open so deep-links from the global palette land on the right page. */
  initialSection?: NavSection
}

export function SettingsModal({
  open,
  onOpenChange,
  workspace,
  canDeleteWorkspace,
  onUpdateWorkspace,
  onDeleteWorkspace,
  onChatWithAgent,
  initialSection,
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<NavSection>(initialSection ?? 'workspace')
  const isCompactViewport = useCompactViewport()

  useEffect(() => {
    if (open && initialSection) setActiveSection(initialSection)
  }, [open, initialSection])

  // ── Agents state ──────────────────────────────────────────────────────────
  const { data: serverAgents } = useGetAgentsQuery()
  const { data: workspaceAgents } = useGetWorkspaceAgentsQuery(workspace.id, {
    skip: !open || workspace.id === '__loading__',
  })
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

  const handleSaveAgent = async (v: { id?: string; name: string; model: string }) => {
    try {
      if (v.id) {
        await patchAgent({ id: v.id, patch: { name: v.name, model: v.model } }).unwrap()
      } else {
        const created = await createAgent({ name: v.name, model: v.model }).unwrap()
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
  // The connection list merges legacy API-key providers, generic
  // multi-account connector rows, and host-detected local sources.
  const { data: providerKeys } = useGetProviderKeysQuery()
  const [putProviderKeys, { isLoading: savingKey }] = usePutProviderKeysMutation()
  const { data: connectorConnectionsData } = useGetConnectorConnectionsQuery()
  const [createConnectorConnection, { isLoading: creatingConnectorConnection }] = useCreateConnectorConnectionMutation()
  const [patchConnectorConnection, { isLoading: patchingConnectorConnection }] = usePatchConnectorConnectionMutation()
  const [deleteConnectorConnection] = useDeleteConnectorConnectionMutation()
  const { data: providersMeta } = useGetProvidersMetaQuery()
  const [putProvidersMeta, { isLoading: savingMeta }] = usePutProvidersMetaMutation()
  const { data: localSourcesData } = useGetLocalSourcesQuery()
  const [putLocalSource, { isLoading: savingLocalSource }] = usePutLocalSourceMutation()

  const providerKeysMap = providerKeys ?? {}
  const providersMetaMap = providersMeta ?? {}
  const connectorConnections = connectorConnectionsData ?? []
  const savingGenericConnector = creatingConnectorConnection || patchingConnectorConnection
  const localSourcesByKind = useMemo<Record<string, LocalSourceState>>(() => {
    const map: Record<string, LocalSourceState> = {}
    for (const s of localSourcesData?.sources ?? []) map[s.kind] = s as LocalSourceState
    return map
  }, [localSourcesData])
  const connections = useMemo(
    () => deriveConnections(providerKeysMap, providersMetaMap, connectorConnections, localSourcesByKind),
    [providerKeysMap, providersMetaMap, connectorConnections, localSourcesByKind],
  )
  const configuredKinds = useMemo(
    () => new Set(connections.map(c => c.kind)),
    [connections],
  )
  const availableConnectionKinds = useMemo(
    () => (Object.keys(CONNECTION_CATALOG) as ConnectionKind[]).filter(kind => (
      isFunctionalKind(kind, localSourcesByKind) && (!configuredKinds.has(kind) || allowsMultipleConnections(kind))
    )),
    [configuredKinds, localSourcesByKind],
  )

  // The "enabled" flag is server state for every kind: API-key kinds
  // store it in provider_meta[envKey].enabled; local-source kinds (Codex,
  // future LM Studio / Ollama) store it via /me/providers/local. The
  // runtime filters disabled providers before forwarding keys to the
  // sandbox, so toggling actually hides the provider from the model
  // picker (not just from this list).
  const connectionsView = connections

  const [connectionsFocus, setConnectionsFocus]               = useState<ConnectionsFocus>(null)
  const [connectionsSearch, setConnectionsSearch]             = useState('')
  const [connectionsStatusFilter, setConnectionsStatusFilter] = useState<StatusFilter>('all')

  const setConnectionsFocusAndReset = (next: ConnectionsFocus) => {
    setConnectionsFocus(next)
    setConnectionsSearch('')
  }

  const handleSaveConnection = async (conn: Connection) => {
    // Local sources (Codex, future LM Studio / Ollama) are host-managed —
    // there is no API key, no display name. Picking one from the picker
    // is the user's opt-in signal.
    if (isLocalSourceKind(conn.kind)) {
      try {
        await putLocalSource({ kind: conn.kind, enabled: true }).unwrap()
      } catch (err) {
        toast.error(`Could not enable ${CONNECTION_CATALOG[conn.kind].name}`, { description: describeApiError(err) })
        return false
      }
      setConnectionsFocus(null)
      return true
    }
    // Persist the display name to /me/providers/meta if this is a
    // functional (API-key-backed) connection kind.
    const envKey = providerKeyForKind(conn.kind)
    if (envKey) {
      const catalogName = CONNECTION_CATALOG[conn.kind].name
      // Only set a custom display name when it differs from the catalog
      // default. Use an empty name to clear the custom label.
      const metaName = conn.name === catalogName ? '' : conn.name
      try {
        await putProvidersMeta({ [envKey]: { name: metaName } }).unwrap()
      } catch (err) {
        toast.error('Could not save connection name', { description: describeApiError(err) })
        return false
      }
    }
    setConnectionsFocus(null)
    return true
  }

  const handleDeleteConnection = async (id: string) => {
    const conn = connections.find(c => c.id === id)
    if (!conn) { setConnectionsFocus(null); return }
    if (CONNECTOR_PROVIDER_BY_KIND[conn.kind]) {
      try {
        await deleteConnectorConnection(id).unwrap()
      } catch (err) {
        toast.error('Could not remove connection', { description: describeApiError(err) })
        return
      }
      setConnectionsFocus(null)
      return
    }
    if (isLocalSourceKind(conn.kind)) {
      try {
        await putLocalSource({ kind: conn.kind, enabled: false }).unwrap()
      } catch (err) {
        toast.error(`Could not disable ${CONNECTION_CATALOG[conn.kind].name}`, { description: describeApiError(err) })
        return
      }
      setConnectionsFocus(null)
      return
    }
    const envKey = providerKeyForKind(conn.kind)
    if (envKey) {
      try {
        // null deletes the key server-side; "" would store an empty string
        // and the masked echo keeps the row visible.
        await putProviderKeys({ [envKey]: null }).unwrap()
      } catch (err) {
        toast.error('Could not remove connection', { description: describeApiError(err) })
        return
      }
    }
    setConnectionsFocus(null)
  }

  const handleToggleLocalSource = async (kind: string, enabled: boolean) => {
    try {
      await putLocalSource({ kind, enabled }).unwrap()
    } catch (err) {
      toast.error('Could not update connection', { description: describeApiError(err) })
    }
  }

  const handleToggleConnectionEnabled = (id: string) => {
    const conn = connections.find(c => c.id === id)
    if (!conn) return
    if (CONNECTOR_PROVIDER_BY_KIND[conn.kind]) {
      const next = !conn.enabled
      void patchConnectorConnection({ id, patch: { status: next ? 'active' : 'disabled' } })
        .unwrap()
        .catch((err) => toast.error(
          next ? 'Could not enable connection' : 'Could not disable connection',
          { description: describeApiError(err) },
        ))
      return
    }
    if (isLocalSourceKind(conn.kind)) {
      const next = !(localSourcesByKind[conn.kind]?.enabled === true)
      void putLocalSource({ kind: conn.kind, enabled: next })
        .unwrap()
        .catch((err) => toast.error(
          next ? 'Could not enable connection' : 'Could not disable connection',
          { description: describeApiError(err) },
        ))
      return
    }
    const envKey = providerKeyForKind(conn.kind)
    if (!envKey) return
    const next = !conn.enabled
    void putProvidersMeta({ [envKey]: { enabled: next } })
      .unwrap()
      .catch((err) => toast.error(
        next ? 'Could not enable connection' : 'Could not disable connection',
        { description: describeApiError(err) },
      ))
  }

  const handleSaveProviderKey = async (envKey: string, value: string) => {
    try {
      await putProviderKeys({ [envKey]: value }).unwrap()
      return true
    } catch (err) {
      toast.error('Could not save provider key', { description: describeApiError(err) })
      return false
    }
  }

  const handleSaveGenericConnector = async (input: {
    id?: string
    kind: ConnectionKind
    displayName: string
    externalAccountId?: string
    credentials?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }) => {
    const providerId = CONNECTOR_PROVIDER_BY_KIND[input.kind]
    if (!providerId) return
    try {
      if (input.id) {
        await patchConnectorConnection({
          id: input.id,
          patch: {
            displayName: input.displayName,
            externalAccountId: input.externalAccountId,
            metadata: input.metadata,
            credentials: input.credentials,
            status: 'active',
          },
        }).unwrap()
      } else {
        await createConnectorConnection({
          providerId,
          displayName: input.displayName,
          externalAccountId: input.externalAccountId,
          scopes: DEFAULT_SCOPES_BY_CONNECTOR_KIND[input.kind] ?? [],
          capabilities: DEFAULT_CAPABILITIES_BY_CONNECTOR_KIND[input.kind] ?? [],
          metadata: { connectorKind: input.kind, ...(input.metadata ?? {}) },
          credentials: input.credentials,
          status: 'active',
          isDefault: true,
        }).unwrap()
      }
      setConnectionsFocus(null)
    } catch (err) {
      toast.error('Could not save connection', { description: describeApiError(err) })
    }
  }

  const modelIndex = useMemo(
    () => buildModelIndex(models ?? [], editingAgentModel),
    [models, editingAgentModel],
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
        className="w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] p-0 gap-0 sm:max-w-[900px] overflow-hidden"
        showCloseButton={false}
        style={{ height: 'min(620px, calc(100dvh - 1rem))' }}
      >
        <DialogTitle className="sr-only">Workspace settings</DialogTitle>
        <Button
          variant="ghost"
          size="icon"
          className={cn('absolute right-3 top-3 z-20 h-7 w-7 text-muted-foreground', !isCompactViewport && 'hidden')}
          onClick={() => onOpenChange(false)}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </Button>

        <div className={cn('flex h-full min-h-0 min-w-0 overflow-hidden', isCompactViewport ? 'flex-col' : 'flex-row')}>
          {/* Left nav */}
          <div className={cn('shrink-0 flex flex-col bg-muted/30', isCompactViewport ? 'w-full border-b' : 'h-full w-52 border-r')}>
            <div className={cn('px-4', isCompactViewport ? 'pt-4 pb-2 pr-12' : 'pt-5 pb-3 pr-4')}>
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

            <nav className={cn('flex gap-1 px-2', isCompactViewport ? 'overflow-x-auto pb-2' : 'flex-1 flex-col gap-0 space-y-0.5 overflow-x-visible pb-0')}>
              {NAV.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveSection(id)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                    isCompactViewport ? 'shrink-0' : 'w-full shrink',
                    activeSection === id
                      ? 'bg-muted text-foreground font-medium'
                      : 'text-foreground/70 hover:text-foreground hover:bg-muted/60',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {/* Right content */}
          <div className={cn('flex w-full flex-1 flex-col min-w-0 min-h-0 overflow-hidden', !isCompactViewport && 'w-auto')}>
            <div className={cn('min-h-[52px] items-center justify-between gap-3 border-b px-4 shrink-0', isCompactViewport ? 'hidden' : 'flex')}>
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
              className="flex-1 flex w-full min-w-0 max-w-full flex-col min-h-0 overflow-hidden"
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
                  localSources={localSourcesByKind}
                  onPick={(kind) => setConnectionsFocus({ mode: 'new', kind })}
                />
              ) : activeSection === 'connections' && (connectionsFocus?.mode === 'new' || connectionsFocus?.mode === 'edit') ? (
                <ConnectionDetail
                  connections={connectionsView}
                  connectorConnections={connectorConnections}
                  focus={connectionsFocus}
                  providerKeys={providerKeysMap}
                  providerMeta={providersMetaMap}
                  localSource={(() => {
                    const k = connectionsFocus.mode === 'edit'
                      ? connectionsView.find(c => c.id === connectionsFocus.id)?.kind
                      : connectionsFocus.kind
                    return k ? localSourcesByKind[k] : undefined
                  })()}
                  busySaveKey={savingKey}
                  busySaveMeta={savingMeta}
                  busyGenericConnector={savingGenericConnector}
                  busyLocalSource={savingLocalSource}
                  onSave={handleSaveConnection}
                  onCancel={() => setConnectionsFocus(null)}
                  onDelete={handleDeleteConnection}
                  onSaveProviderKey={handleSaveProviderKey}
                  onSaveGenericConnector={handleSaveGenericConnector}
                  onToggleLocalSource={handleToggleLocalSource}
                />
              ) : (
                <div className="flex-1 w-full min-w-0 max-w-full overflow-y-auto overflow-x-hidden px-4 pt-3 pb-6">
                  {activeSection === 'agents' && (
                    <div className="min-w-0 max-w-full space-y-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <StatusFilterPills value={agentsStatusFilter} onChange={setAgentsStatusFilter} />
                        <div className="flex w-full min-w-0 max-w-full items-center gap-2 sm:w-auto">
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
                    <div className="min-w-0 max-w-full space-y-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <StatusFilterPills value={connectionsStatusFilter} onChange={setConnectionsStatusFilter} />
                        <div className="flex w-full min-w-0 max-w-full items-center gap-2 sm:w-auto">
                          <SearchInput value={connectionsSearch} onChange={setConnectionsSearch} placeholder="Search connections…" />
                          <Button size="sm" className="gap-1.5" onClick={() => setConnectionsFocusAndReset({ mode: 'picker' })}>
                            <Plus className="h-3.5 w-3.5" />Add
                          </Button>
                        </div>
                      </div>
                      <ConnectionsList
                        connections={connectionsView}
                        availableKinds={availableConnectionKinds}
                        statusFilter={connectionsStatusFilter}
                        search={connectionsSearch}
                        onOpen={(id) => setConnectionsFocusAndReset({ mode: 'edit', id })}
                        onPickNew={() => setConnectionsFocusAndReset({ mode: 'picker' })}
                        onPickKind={(kind) => setConnectionsFocusAndReset({ mode: 'new', kind })}
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
