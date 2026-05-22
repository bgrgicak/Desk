import {
  Zap, FolderOpen, Sun,
  User, Bot, Plug, Sliders, Briefcase,
  type LucideIcon,
} from 'lucide-react'
import type { RouteView } from '@/router/nav'
import type { SettingsSection } from '@/store/slices/uiSlice'

export interface NavTarget {
  kind: 'page'
  id: string
  label: string
  keywords?: string[]
  icon: LucideIcon
  /** RouteView to navigate to inside the active workspace. */
  view?: RouteView
  /** Navigate to the cross-room Home screen (Your day) instead of a workspace view. */
  goHome?: boolean
  /** Open the user's My Account modal. */
  openMyAccount?: boolean
}

export interface SettingsTarget {
  kind: 'settings'
  id: string
  label: string
  keywords?: string[]
  icon: LucideIcon
  section: SettingsSection
}

export type SearchTarget = NavTarget | SettingsTarget

/**
 * Workspace-scoped destinations: pages within the current workspace plus
 * settings sections that are configured per-workspace (workspace meta,
 * workspace agents, connections).
 */
export const WORKSPACE_TARGETS: SearchTarget[] = [
  { kind: 'page',     id: 'page:tasks',        label: 'Tasks',               icon: Zap,        view: 'tasks' },
  { kind: 'page',     id: 'page:library',      label: 'Library',             icon: FolderOpen, view: 'context', keywords: ['files', 'context'] },
  { kind: 'settings', id: 'set:agents',        label: 'Agents',              icon: Bot,        section: 'agents',      keywords: ['ai', 'bot', 'assistant'] },
  { kind: 'settings', id: 'set:connections',   label: 'Connections',         icon: Plug,       section: 'connections', keywords: ['api keys', 'integrations'] },
  { kind: 'settings', id: 'set:workspace',     label: 'Workspace settings',  icon: Briefcase,  section: 'workspace' },
]

/** Global / user-level destinations. */
export const SETTINGS_TARGETS: SearchTarget[] = [
  { kind: 'page',     id: 'page:your-day',     label: 'Your day',            icon: Sun,      goHome: true,        keywords: ['today', 'home', 'inbox'] },
  { kind: 'page',     id: 'page:account',      label: 'My account',          icon: User,     openMyAccount: true, keywords: ['profile', 'me', 'user settings'] },
  { kind: 'settings', id: 'set:customize',     label: 'Customize',           icon: Sliders,  section: 'workspace', keywords: ['preferences', 'theme', 'timezone', 'workspace settings'] },
]

function matches(target: SearchTarget, q: string): boolean {
  const needle = q.toLowerCase()
  if (target.label.toLowerCase().includes(needle)) return true
  return (target.keywords ?? []).some(k => k.toLowerCase().includes(needle))
}

export function filterWorkspaceTargets(query: string): SearchTarget[] {
  if (!query.trim()) return []
  return WORKSPACE_TARGETS.filter(t => matches(t, query))
}

export function filterSettingsTargets(query: string): SearchTarget[] {
  if (!query.trim()) return []
  return SETTINGS_TARGETS.filter(t => matches(t, query))
}
