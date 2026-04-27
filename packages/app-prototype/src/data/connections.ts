// Catalog + types for Settings → Connections.
//
// Connection state is derived from the real backend (currently
// `/me/providers` for Claude/ChatGPT). The other kinds are listed in the
// catalog so they appear in the picker as a roadmap, but they're disabled
// until a backend lands — there is no mock data seeded.

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

// Maps a provider-style connection kind to the env key in /me/providers
// where its API key is persisted. Kinds not in this map have no backend
// yet and stay disabled in the picker.
export const PROVIDER_KEY_BY_KIND: Partial<Record<ConnectionKind, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  chatgpt: 'OPENAI_API_KEY',
}

export interface Connection {
  id: string
  kind: ConnectionKind
  name: string
  baseUrl?: string
  enabled: boolean
}

// Default base URLs surfaced in the connection detail form. Display only —
// the server resolves the actual base URL from the provider key.
export const DEFAULT_BASE_URL_BY_KIND: Partial<Record<ConnectionKind, string>> = {
  claude: 'https://api.anthropic.com',
  chatgpt: 'https://api.openai.com/v1',
}

// Provider id (as used by /tools/models and stored on agent.model) that a
// connection kind authenticates. Used by the agent provider dropdown to
// turn a configured connection into an available provider.
export const MODEL_PROVIDER_BY_KIND: Partial<Record<ConnectionKind, string>> = {
  claude: 'anthropic',
  chatgpt: 'openai',
}

// Baseline models per provider so the agent edit form is functional even
// when /tools/models is empty (no key set yet) or the sandbox is failing
// to enumerate. Real models from /tools/models are merged on top, keyed
// by id.
export const FALLBACK_MODELS_BY_PROVIDER: Record<string, { id: string; label: string }[]> = {
  anthropic: [
    { id: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { id: 'anthropic/claude-opus-4-20250514',   label: 'Claude Opus 4'   },
    { id: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: 'openai/gpt-4o',      label: 'GPT-4o'      },
    { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'openai/gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
}
