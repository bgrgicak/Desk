import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Settings2, Bot, Plug, Sliders,
  Trash2, Plus, Check, ChevronDown, X, Pencil,
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
  useGetMeQuery,
  type ModelRef,
} from '@/store/api'

function describeApiError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { data?: { message?: unknown }; error?: unknown }
    if (typeof e.data?.message === 'string') return e.data.message
    if (typeof e.error === 'string') return e.error
  }
  if (err instanceof Error) return err.message
  return 'Unknown error'
}
import type { ServerAgent } from '@/store/types'
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
        <Popover open={deleteOpen} onOpenChange={o => canDelete && setDeleteOpen(o)}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canDelete}
              title={
                canDelete
                  ? undefined
                  : "You need at least one workspace. Create another before deleting this one."
              }
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

// ── Agents ───────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'

/** Groups ModelRef[] by provider for the picker. */
function groupModels(models: ModelRef[]): { provider: string; models: ModelRef[] }[] {
  const by = new Map<string, ModelRef[]>()
  for (const m of models) {
    const list = by.get(m.provider) ?? []
    list.push(m)
    by.set(m.provider, list)
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, ms]) => ({
      provider,
      models: [...ms].sort((a, b) => a.id.localeCompare(b.id)),
    }))
}

function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (modelId: string) => void
  disabled?: boolean
}) {
  const { data: models, isLoading, isError } = useGetModelsQuery()
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => groupModels(models ?? []), [models])
  const hasModels = groups.length > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-0.5 disabled:opacity-60 disabled:pointer-events-none"
        >
          {value || 'Pick a model'}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1 max-h-80 overflow-y-auto" align="start">
        {isLoading && (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">Loading models…</p>
        )}
        {!isLoading && isError && (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">
            Couldn't reach the model catalog. Add a provider key in Preferences, then reopen.
          </p>
        )}
        {!isLoading && !isError && !hasModels && (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">
            No models available. Configure a provider key in Preferences.
          </p>
        )}
        {hasModels &&
          groups.map(({ provider, models: ms }) => (
            <div key={provider} className="mb-1 last:mb-0">
              <p className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {provider}
              </p>
              {ms.map(m => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onChange(m.id)
                    setOpen(false)
                  }}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 text-sm rounded-md hover:bg-muted/60 transition-colors text-left"
                >
                  {m.id === value
                    ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                    : <span className="w-3.5 shrink-0" />}
                  <span className="truncate">{m.label ?? m.id}</span>
                </button>
              ))}
            </div>
          ))}
      </PopoverContent>
    </Popover>
  )
}

function AgentEditor({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  busy,
}: {
  initial: { name: string; model: string; instructions: string }
  submitLabel: string
  onSubmit: (v: { name: string; model: string; instructions: string }) => void
  onCancel: () => void
  busy?: boolean
}) {
  const [name, setName]                 = useState(initial.name)
  const [model, setModel]               = useState(initial.model)
  const [instructions, setInstructions] = useState(initial.instructions)

  const canSave = name.trim().length > 0 && model.trim().length > 0

  return (
    <div className="border rounded-lg p-3 space-y-3 bg-muted/20">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Bot className="h-4 w-4 text-muted-foreground/70" />
        </div>
        <Input
          placeholder="Agent name"
          value={name}
          onChange={e => setName(e.target.value)}
          className="flex-1"
          aria-label="Agent name"
        />
      </div>

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1">
          Model
        </p>
        <ModelPicker value={model} onChange={setModel} />
      </div>

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-1">
          Instructions
        </p>
        <Textarea
          placeholder="How should this agent behave? (system prompt)"
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          rows={4}
          className="resize-none text-sm"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!canSave || busy}
          onClick={() => onSubmit({ name: name.trim(), model: model.trim(), instructions })}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

function AgentRow({
  agent,
  enrolled,
  canDelete,
  onToggleEnrolled,
  onEdit,
  onDelete,
  onModelChange,
}: {
  agent: ServerAgent
  enrolled: boolean
  canDelete: boolean
  onToggleEnrolled: (next: boolean) => void
  onEdit: () => void
  onDelete: () => void
  onModelChange: (modelId: string) => void
}) {
  const [deleteOpen, setDeleteOpen] = useState(false)

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/40 transition-colors group">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Bot className="h-4 w-4 text-muted-foreground/70" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{agent.name}</p>
        <ModelPicker value={agent.model} onChange={onModelChange} />
      </div>

      <div
        title={
          enrolled
            ? 'Disable access to this workspace'
            : 'Enable access to this workspace'
        }
      >
        <Switch
          checked={enrolled}
          onCheckedChange={onToggleEnrolled}
          aria-label={
            enrolled
              ? `Disable ${agent.name} in this workspace`
              : `Enable ${agent.name} in this workspace`
          }
        />
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={onEdit}
        aria-label={`Edit ${agent.name}`}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>

      <Popover open={deleteOpen} onOpenChange={o => canDelete && setDeleteOpen(o)}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={!canDelete}
            title={
              canDelete
                ? undefined
                : "You need at least one agent. Create another before deleting this one."
            }
            className="h-7 w-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity disabled:hover:text-muted-foreground"
            aria-label={`Delete ${agent.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-4" align="end">
          <p className="text-sm font-medium mb-1">Delete "{agent.name}"?</p>
          <p className="text-xs text-muted-foreground mb-3">
            Chats that used this agent will also be deleted. This can't be undone.
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              className="flex-1"
              onClick={() => {
                setDeleteOpen(false)
                onDelete()
              }}
            >
              Delete
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function AgentsSection({ workspaceId }: { workspaceId: string }) {
  const { data: serverAgents, isLoading } = useGetAgentsQuery()
  const { data: workspaceAgents } = useGetWorkspaceAgentsQuery(workspaceId)
  const { data: models } = useGetModelsQuery()
  const [createAgent, { isLoading: creating }] = useCreateAgentMutation()
  const [patchAgent]  = usePatchAgentMutation()
  const [deleteAgent] = useDeleteAgentMutation()
  const [addWorkspaceAgent]    = useAddWorkspaceAgentMutation()
  const [removeWorkspaceAgent] = useRemoveWorkspaceAgentMutation()

  // null = none; 'NEW' = create form; otherwise = agent id being edited.
  const [editing, setEditing] = useState<'NEW' | string | null>(null)

  const agents = serverAgents ?? []
  const firstAvailableModel = models?.[0]?.id ?? DEFAULT_MODEL
  const enrolledIds = useMemo(
    () => new Set((workspaceAgents ?? []).map(a => a.id)),
    [workspaceAgents],
  )

  const handleCreate = async (v: { name: string; model: string; instructions: string }) => {
    await createAgent({
      name: v.name,
      model: v.model,
      instructions: v.instructions,
    }).unwrap()
    setEditing(null)
  }

  const handlePatch = async (
    agent: ServerAgent,
    v: { name: string; model: string; instructions: string },
  ) => {
    await patchAgent({
      id: agent.id,
      patch: { name: v.name, model: v.model, instructions: v.instructions },
    }).unwrap()
    setEditing(null)
  }

  const handleDelete = async (id: string) => {
    await deleteAgent(id).unwrap()
  }

  const handleToggleEnrolled = async (agentId: string, next: boolean) => {
    try {
      if (next) {
        await addWorkspaceAgent({ workspaceId, agentId }).unwrap()
      } else {
        await removeWorkspaceAgent({ workspaceId, agentId }).unwrap()
      }
    } catch (err) {
      toast.error(
        next ? 'Could not enable agent' : 'Could not disable agent',
        { description: describeApiError(err) },
      )
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-0.5">Agents</h3>
        <p className="text-xs text-muted-foreground">
          Toggle which agents can be used in this workspace. New chats open
          with the first enrolled agent selected; pick a different one per
          chat from the compose bar.
        </p>
      </div>

      <div className="space-y-1">
        {isLoading && agents.length === 0 && (
          <p className="text-xs text-muted-foreground px-3 py-2">Loading agents…</p>
        )}
        {agents.map(agent => {
          const enrolled = enrolledIds.has(agent.id)
          return editing === agent.id ? (
            <AgentEditor
              key={agent.id}
              initial={{
                name: agent.name,
                model: agent.model,
                instructions: agent.instructions,
              }}
              submitLabel="Save"
              onCancel={() => setEditing(null)}
              onSubmit={v => handlePatch(agent, v)}
            />
          ) : (
            <AgentRow
              key={agent.id}
              agent={agent}
              enrolled={enrolled}
              canDelete={agents.length > 1}
              onToggleEnrolled={next => handleToggleEnrolled(agent.id, next)}
              onEdit={() => setEditing(agent.id)}
              onDelete={() => handleDelete(agent.id)}
              onModelChange={model => patchAgent({ id: agent.id, patch: { model } })}
            />
          )
        })}
      </div>

      {editing === 'NEW' ? (
        <AgentEditor
          initial={{ name: '', model: firstAvailableModel, instructions: '' }}
          submitLabel={creating ? 'Creating…' : 'Create agent'}
          onCancel={() => setEditing(null)}
          onSubmit={handleCreate}
          busy={creating}
        />
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setEditing('NEW')}
        >
          <Plus className="h-3.5 w-3.5" />
          Add custom agent
        </Button>
      )}

      {/* Provider keys — feeds the model picker via /tools/models. */}
      <ProvidersPanel />
    </div>
  )
}

// ── Providers ────────────────────────────────────────────────────────────────

function ProvidersPanel() {
  const { data: keys, isLoading } = useGetProviderKeysQuery()
  const [putKeys, putState] = usePutProviderKeysMutation()
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const PROVIDERS: { id: string; label: string; placeholder: string }[] = [
    { id: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)', placeholder: 'sk-ant-…' },
    { id: 'OPENAI_API_KEY',    label: 'OpenAI (ChatGPT)',   placeholder: 'sk-…' },
  ]

  // Server returns masked echoes like `sk-ant-...1f4a` for stored keys.
  const isMaskedKey = (v: string | null | undefined) => !!v && v.includes('...')

  return (
    <div className="space-y-3 pt-4 border-t">
      <div>
        <h3 className="text-sm font-semibold mb-0.5">Providers</h3>
        <p className="text-xs text-muted-foreground">
          API keys are stored encrypted on the server. Saved keys appear masked
          on reload — submit a fresh value to overwrite.
        </p>
      </div>
      {isLoading && (
        <p className="text-xs text-muted-foreground px-3 py-2">Loading providers…</p>
      )}
      <div className="space-y-2">
        {PROVIDERS.map(p => {
          const stored = keys?.[p.id] ?? null
          const draft = drafts[p.id]
          const value = draft ?? (isMaskedKey(stored) ? stored ?? '' : (stored ?? ''))
          return (
            <div key={p.id} className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground w-44 shrink-0">
                {p.label}
              </label>
              <Input
                type="password"
                placeholder={p.placeholder}
                value={value}
                data-testid={`provider-key-${p.id}`}
                onChange={(e) => setDrafts(prev => ({ ...prev, [p.id]: e.target.value }))}
                className="flex-1"
              />
              <Button
                size="sm"
                disabled={draft === undefined || putState.isLoading}
                data-testid={`provider-save-${p.id}`}
                onClick={async () => {
                  if (draft === undefined) return
                  try {
                    await putKeys({ [p.id]: draft }).unwrap()
                    setDrafts(prev => {
                      const next = { ...prev }
                      delete next[p.id]
                      return next
                    })
                  } catch (err) {
                    toast.error('Could not save provider key', { description: describeApiError(err) })
                  }
                }}
              >
                Apply
              </Button>
            </div>
          )
        })}
      </div>
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
        <div className="flex items-center gap-2 mb-0.5">
          <h3 className="text-sm font-semibold">Connections</h3>
          <span
            data-testid="connections-coming-soon"
            className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700"
          >
            Coming soon
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Preview of the connections surface. Toggles are local to your browser
          until the server connections backend ships.
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

interface PrefsShape {
  autoSave: boolean
  defaultView: DefaultView
  showBadges: boolean
}

const PREFS_DEFAULTS: PrefsShape = {
  autoSave: true,
  defaultView: 'desk',
  showBadges: true,
}

function prefsKey(userId: string): string {
  return `desk.prefs.${userId}`
}

export function loadPrefs(userId: string | undefined): PrefsShape {
  if (!userId) return PREFS_DEFAULTS
  try {
    const raw = localStorage.getItem(prefsKey(userId))
    if (!raw) return PREFS_DEFAULTS
    const parsed = JSON.parse(raw) as Partial<PrefsShape>
    return { ...PREFS_DEFAULTS, ...parsed }
  } catch {
    return PREFS_DEFAULTS
  }
}

function savePrefs(userId: string | undefined, prefs: PrefsShape): void {
  if (!userId) return
  try {
    localStorage.setItem(prefsKey(userId), JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
}

function PreferencesSection() {
  const { data: me } = useGetMeQuery()
  const userId = me?.id
  const [prefs, setPrefs] = useState<PrefsShape>(PREFS_DEFAULTS)
  // The /me query is async; backfill once it resolves so the toggles
  // reflect what's persisted instead of always the defaults.
  useEffect(() => {
    setPrefs(loadPrefs(userId))
  }, [userId])

  const update = (patch: Partial<PrefsShape>): void => {
    setPrefs(prev => {
      const next = { ...prev, ...patch }
      savePrefs(userId, next)
      return next
    })
  }

  const VIEW_OPTIONS: { value: DefaultView; label: string }[] = [
    { value: 'desk',    label: 'Desk'    },
    { value: 'chats',   label: 'Chats'   },
    { value: 'context', label: 'Library' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-0.5">Preferences</h3>
        <p className="text-xs text-muted-foreground">
          Behaviour settings for this workspace. Saved to your browser; a
          server-side store for cross-device sync is on the roadmap.
        </p>
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
          <Switch
            data-testid="prefs-auto-save"
            checked={prefs.autoSave}
            onCheckedChange={v => update({ autoSave: v })}
          />
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
          <Switch
            data-testid="prefs-show-badges"
            checked={prefs.showBadges}
            onCheckedChange={v => update({ showBadges: v })}
          />
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
                data-testid={`prefs-default-view-${opt.value}`}
                onClick={() => update({ defaultView: opt.value })}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  prefs.defaultView === opt.value
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
  /** Whether the workspace can be deleted (false when it's the caller's last). */
  canDeleteWorkspace: boolean
  onUpdateWorkspace: (ws: WorkspaceInfo) => void
  onDeleteWorkspace: () => void
}

export function SettingsModal({
  open,
  onOpenChange,
  workspace,
  canDeleteWorkspace,
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
                  canDelete={canDeleteWorkspace}
                  onUpdate={ws => { onUpdateWorkspace(ws); onOpenChange(false) }}
                  onDelete={() => { onDeleteWorkspace(); onOpenChange(false) }}
                />
              )}
              {activeSection === 'agents' && <AgentsSection workspaceId={workspace.id} />}
              {activeSection === 'connections' && <ConnectionsSection />}
              {activeSection === 'preferences' && <PreferencesSection />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
