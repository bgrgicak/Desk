// Catalog + types for Settings → Connections.
//
// Connection state is derived from the real backend (currently
// `/me/providers` for Claude/ChatGPT/GitHub). The other kinds are listed in the
// catalog so they appear in the picker as a roadmap, but they're disabled
// until a backend lands — there is no mock data seeded.
import { LOCAL_FILESYSTEM_CONNECTION_KIND, LOCAL_FILESYSTEM_PROVIDER_ID, LOCAL_FILESYSTEM_CAPABILITIES, managedConnectionDefinitions, type ManagedConnectionDefinition } from '@roomy-ai/shared'

export type ConnectionKind =
  | 'claude' | 'chatgpt' | 'codex'
  | 'notion' | 'github' | 'slack' | 'figma' | 'linear' | 'web-clipper' | typeof LOCAL_FILESYSTEM_CONNECTION_KIND

export const MODEL_CONNECTION_KINDS = ['claude', 'chatgpt', 'codex'] as const satisfies readonly ConnectionKind[]

export function isModelConnectionKind(kind: ConnectionKind): boolean {
  return (MODEL_CONNECTION_KINDS as readonly string[]).includes(kind)
}

export interface ConnectionMeta {
  name: string
  description: string
  // Emoji fallback shown when no brand mark applies.
  icon: string
}

const MANAGED_CONNECTION_CATALOG = Object.fromEntries(
  managedConnectionDefinitions().map(definition => [definition.kind, {
    name: definition.name,
    description: definition.description,
    icon: definition.icon,
  }]),
) as Partial<Record<ConnectionKind, ConnectionMeta>>

export const CONNECTION_CATALOG = {
  ...MANAGED_CONNECTION_CATALOG,
  'codex':        { name: 'Codex',        description: 'OpenAI models via your ChatGPT subscription (Codex on this machine)', icon: '🌀' },
  'notion':       { name: 'Notion',       description: 'Pages and databases',                  icon: '📝' },
  'slack':        { name: 'Slack',        description: 'Messages and channels',                icon: '💬' },
  'figma':        { name: 'Figma',        description: 'Design files and prototypes',          icon: '🎨' },
  'linear':       { name: 'Linear',       description: 'Issues, projects and cycles',          icon: '🔷' },
  'web-clipper':  { name: 'Web Clipper',  description: 'Save pages from your browser',         icon: '🌐' },
  [LOCAL_FILESYSTEM_CONNECTION_KIND]: { name: 'Local folders', description: 'Mount server-local directories into the sandbox home folder', icon: '📁' },
} as Record<ConnectionKind, ConnectionMeta>

// Maps a cloud connection kind to the env key in /me/providers where its
// API key is persisted. Kinds not in this map have no cloud backend yet
// and stay disabled in the picker. Local-source kinds (`codex`, future
// `lm-studio`, `ollama`, …) are handled separately — see
// `LOCAL_SOURCE_KINDS` and the /me/providers/local endpoints.
export const CONNECTION_DEFINITIONS: Partial<Record<ConnectionKind, ManagedConnectionDefinition>> = Object.fromEntries(
  managedConnectionDefinitions().map(definition => [definition.kind, definition]),
) as Partial<Record<ConnectionKind, ManagedConnectionDefinition>>

export const PROVIDER_KEY_BY_KIND: Partial<Record<ConnectionKind, string>> = Object.fromEntries(
  managedConnectionDefinitions().map(definition => [definition.kind, definition.envKey]),
) as Partial<Record<ConnectionKind, string>>

export function managedConnectionDefinitionForKind(kind: ConnectionKind): ManagedConnectionDefinition | undefined {
  return CONNECTION_DEFINITIONS[kind]
}

export function providerKeyForKind(kind: ConnectionKind): string | undefined {
  return managedConnectionDefinitionForKind(kind)?.envKey
}

export function providerKeyEntries(): [ConnectionKind, string][] {
  return managedConnectionDefinitions()
    .map(definition => [definition.kind as ConnectionKind, definition.envKey] as [ConnectionKind, string])
}

// Maps product connectors to the generic multi-account connector backend.
// These are not API-key providers; they create rows in connector_connections
// and can later be upgraded from manual credential entry to OAuth without
// changing provider IDs or workspace grants.
/**
 * Maps product connectors to the generic multi-account connector backend.
 * Empty for now — connectors that should appear in Settings → Connections
 * with persistent multi-account state register their kind → providerId
 * here. Single-key API connectors (Claude, ChatGPT, …) do not belong here;
 * they use the legacy /me/providers env-key surface.
 */
export const CONNECTOR_PROVIDER_BY_KIND: Partial<Record<ConnectionKind, string>> = {
  [LOCAL_FILESYSTEM_CONNECTION_KIND]: LOCAL_FILESYSTEM_PROVIDER_ID,
}

export const WORKSPACE_CONNECTION_PROVIDER_BY_KIND: Partial<Record<ConnectionKind, string>> = {
  ...CONNECTOR_PROVIDER_BY_KIND,
  ...(PROVIDER_KEY_BY_KIND.github ? { github: PROVIDER_KEY_BY_KIND.github } : {}),
}

export function workspaceConnectionProviderForKind(kind: ConnectionKind): string | undefined {
  if (isModelConnectionKind(kind)) return undefined
  return WORKSPACE_CONNECTION_PROVIDER_BY_KIND[kind]
}

export function allowsMultipleConnections(kind: ConnectionKind): boolean {
  if (kind === LOCAL_FILESYSTEM_CONNECTION_KIND) return false
  if (WORKSPACE_CONNECTION_PROVIDER_BY_KIND[kind] !== undefined) return false
  return CONNECTOR_PROVIDER_BY_KIND[kind] !== undefined
}

export const DEFAULT_CAPABILITIES_BY_CONNECTOR_KIND: Partial<Record<ConnectionKind, string[]>> = {
  [LOCAL_FILESYSTEM_CONNECTION_KIND]: [...LOCAL_FILESYSTEM_CAPABILITIES],
}

export const DEFAULT_SCOPES_BY_CONNECTOR_KIND: Partial<Record<ConnectionKind, string[]>> = {}

export function connectionKindForProvider(providerId: string): ConnectionKind | null {
  for (const [kind, provider] of Object.entries(CONNECTOR_PROVIDER_BY_KIND) as [ConnectionKind, string][]) {
    if (provider === providerId) return kind
  }
  return null
}

/**
 * Connection kinds that are host-detected rather than API-key-backed.
 * The server reports their detection state via /me/providers/local; the
 * UI surfaces them as connections with a server-persisted enable toggle
 * and no API-key form.
 */
export const LOCAL_SOURCE_KINDS: readonly ConnectionKind[] = ['codex']

export function isLocalSourceKind(kind: ConnectionKind): boolean {
  return (LOCAL_SOURCE_KINDS as readonly string[]).includes(kind)
}

export interface Connection {
  id: string
  kind: ConnectionKind
  name: string
  enabled: boolean
  connectionId?: string
  providerId?: string
  externalAccountId?: string
}
