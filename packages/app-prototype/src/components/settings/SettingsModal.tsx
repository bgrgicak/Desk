import { useState } from 'react'
import {
  Settings2, Bot, Plug, Sliders,
  Trash2, Plus, Check, ChevronDown, X,
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
import { MOCK_AGENTS } from '@/data/mock-data'
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

// ── Agent row ────────────────────────────────────────────────────────────────

interface AgentConfig {
  name: string
  model: string
  enabled: boolean
}

function AgentsSection() {
  const [agents, setAgents] = useState<AgentConfig[]>(
    MOCK_AGENTS.map(a => ({ ...a, enabled: true }))
  )
  const [modelPickerOpen, setModelPickerOpen] = useState<string | null>(null)

  const MODELS = ['Claude Opus 4', 'Claude Sonnet 4', 'Claude Haiku 3.5', 'GPT-4o', 'GPT-4o mini']

  const toggle = (name: string) =>
    setAgents(prev => prev.map(a => a.name === name ? { ...a, enabled: !a.enabled } : a))

  const setModel = (name: string, model: string) => {
    setAgents(prev => prev.map(a => a.name === name ? { ...a, model } : a))
    setModelPickerOpen(null)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-0.5">Agents</h3>
        <p className="text-xs text-muted-foreground">
          Manage which agents are available in this workspace and configure their models.
        </p>
      </div>

      <div className="space-y-1">
        {agents.map(agent => (
          <div
            key={agent.name}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/40 transition-colors"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Bot className="h-4 w-4 text-muted-foreground/70" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{agent.name}</p>
              {/* Model picker */}
              <Popover
                open={modelPickerOpen === agent.name}
                onOpenChange={open => setModelPickerOpen(open ? agent.name : null)}
              >
                <PopoverTrigger asChild>
                  <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-0.5">
                    {agent.model}
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-48 p-1" align="start">
                  {MODELS.map(m => (
                    <button
                      key={m}
                      onClick={() => setModel(agent.name, m)}
                      className="flex items-center gap-2 w-full px-2.5 py-1.5 text-sm rounded-md hover:bg-muted/60 transition-colors text-left"
                    >
                      {m === agent.model && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                      {m !== agent.model && <span className="w-3.5 shrink-0" />}
                      {m}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            </div>
            <Switch
              checked={agent.enabled}
              onCheckedChange={() => toggle(agent.name)}
            />
          </div>
        ))}
      </div>

      <Button variant="outline" size="sm" className="gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        Add custom agent
      </Button>
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
