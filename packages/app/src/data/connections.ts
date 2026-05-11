// Catalog + types for Settings → Connections.
//
// Connection state is derived from the real backend (currently
// `/me/providers` for Claude/ChatGPT/GitHub). The other kinds are listed in the
// catalog so they appear in the picker as a roadmap, but they're disabled
// until a backend lands — there is no mock data seeded.
import { managedConnectionDefinitions, type ManagedConnectionDefinition } from '@agent-desk/shared'

export type ConnectionKind =
  | 'claude' | 'chatgpt' | 'codex'
  | 'google-drive' | 'notion' | 'github' | 'slack' | 'figma' | 'linear' | 'web-clipper'

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
  'google-drive': { name: 'Google Drive', description: 'Docs, Sheets and Slides',              icon: '📁' },
  'notion':       { name: 'Notion',       description: 'Pages and databases',                  icon: '📝' },
  'slack':        { name: 'Slack',        description: 'Messages and channels',                icon: '💬' },
  'figma':        { name: 'Figma',        description: 'Design files and prototypes',          icon: '🎨' },
  'linear':       { name: 'Linear',       description: 'Issues, projects and cycles',          icon: '🔷' },
  'web-clipper':  { name: 'Web Clipper',  description: 'Save pages from your browser',         icon: '🌐' },
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
}
