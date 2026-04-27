// Catalog + seed data for Settings → Connections.
// Claude / ChatGPT entries here drive the API-key UI; their API keys are
// persisted via /me/providers (see SettingsModal). Everything else is
// prototype-level mock state until a real backend lands.

export type ConnectionKind =
  | 'claude' | 'chatgpt'
  | 'google-drive' | 'notion' | 'github' | 'slack' | 'figma' | 'linear' | 'web-clipper'

export interface ConnectionMeta {
  name: string
  description: string
  // Emoji fallback shown when no brand mark applies.
  icon: string
}

export const CONNECTION_CATALOG: Record<ConnectionKind, ConnectionMeta> = {
  'claude':       { name: 'Claude',       description: 'Claude models via the Anthropic API',  icon: '🅰️' },
  'chatgpt':      { name: 'ChatGPT',      description: 'OpenAI models via the OpenAI API',     icon: '🅶' },
  'google-drive': { name: 'Google Drive', description: 'Docs, Sheets and Slides',              icon: '📁' },
  'notion':       { name: 'Notion',       description: 'Pages and databases',                  icon: '📝' },
  'github':       { name: 'GitHub',       description: 'Repositories and issues',              icon: '🐙' },
  'slack':        { name: 'Slack',        description: 'Messages and channels',                icon: '💬' },
  'figma':        { name: 'Figma',        description: 'Design files and prototypes',          icon: '🎨' },
  'linear':       { name: 'Linear',       description: 'Issues, projects and cycles',          icon: '🔷' },
  'web-clipper':  { name: 'Web Clipper',  description: 'Save pages from your browser',         icon: '🌐' },
}

export interface Connection {
  id: string
  kind: ConnectionKind
  name: string
  // Local-only config for non-provider kinds. Claude/ChatGPT use the real
  // /me/providers API; the field here is only used as a UI cache while the
  // detail page is open.
  apiKey?: string
  baseUrl?: string
  enabled: boolean
}

export const MOCK_CONNECTIONS: Connection[] = [
  {
    id: 'conn-claude',
    kind: 'claude',
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    enabled: true,
  },
  {
    id: 'conn-chatgpt',
    kind: 'chatgpt',
    name: 'ChatGPT',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
  },
]

export const PROVIDER_KEY_BY_KIND: Partial<Record<ConnectionKind, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  chatgpt: 'OPENAI_API_KEY',
}
