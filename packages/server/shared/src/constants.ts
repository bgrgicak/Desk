export const ID_PREFIXES = {
  user: "usr_",
  agent: "agt_",
  workspace: "wks_",
  chat: "cht_",
  message: "msg_",
  sandboxSession: "sbs_",
  appSession: "aps_",
} as const;

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 128 * 1024;
export const DEFAULT_LIBRARY_PAGE_SIZE = 50;

export const MESSAGE_ROLES = ["user", "agent", "system"] as const;

/** Kinds emitted by message.log_appended WS events. */
export const MESSAGE_LOG_KINDS = ["stdout", "stderr", "event"] as const;

/**
 * AI-provider credentials known to opencode. Used both for forwarding host
 * env into sandboxes and for model provider keys the user can manage via
 * /me/providers.
 */
export const PROVIDER_KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "COHERE_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "AZURE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  // Bedrock needs these alongside the AWS pair above to actually reach a
  // regional endpoint — not opencode-recognized auth keys on their own.
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

export type ProviderKeyName = (typeof PROVIDER_KEY_VARS)[number];

/**
 * Non-model service credentials that Desk can forward into sandboxes.
 * These live in the same encrypted vault-backed Settings → Connections flow
 * as provider keys, but are used by command-line tools rather than opencode's
 * model provider auto-detection.
 */
export const SANDBOX_CONNECTION_ENV_VARS = [
  "GITHUB_TOKEN",
] as const;

export type SandboxConnectionEnvName = (typeof SANDBOX_CONNECTION_ENV_VARS)[number];

/** All encrypted connection env vars accepted by /me/providers. */
export const CONNECTION_ENV_VARS = [
  ...PROVIDER_KEY_VARS,
  ...SANDBOX_CONNECTION_ENV_VARS,
] as const;

export type ConnectionEnvName = (typeof CONNECTION_ENV_VARS)[number];

export type ConnectionAuthKind = "api-key";
export type SandboxAuthSetup = "github-askpass";
export type ConnectionManualGuide = "github-pat";

export interface ManagedConnectionDefinition {
  kind: string;
  name: string;
  description: string;
  icon: string;
  envKey: ConnectionEnvName;
  authKinds: readonly ConnectionAuthKind[];
  secretLabel: string;
  secretPlaceholder: string;
  manualGuide?: ConnectionManualGuide;
  envAliases?: readonly string[];
  sandboxSetup?: SandboxAuthSetup;
}

export const MANAGED_CONNECTIONS = {
  claude: {
    kind: "claude",
    name: "Claude",
    description: "Claude models via the Anthropic API",
    icon: "🅰️",
    envKey: "ANTHROPIC_API_KEY",
    authKinds: ["api-key"],
    secretLabel: "API key",
    secretPlaceholder: "sk-ant-…",
  },
  chatgpt: {
    kind: "chatgpt",
    name: "ChatGPT",
    description: "OpenAI models via the OpenAI API",
    icon: "🅶",
    envKey: "OPENAI_API_KEY",
    authKinds: ["api-key"],
    secretLabel: "API key",
    secretPlaceholder: "sk-…",
  },
  github: {
    kind: "github",
    name: "GitHub",
    description: "Repositories and issues",
    icon: "🐙",
    envKey: "GITHUB_TOKEN",
    authKinds: ["api-key"],
    secretLabel: "Classic personal access token",
    secretPlaceholder: "ghp_…",
    manualGuide: "github-pat",
    envAliases: ["GH_TOKEN"],
    sandboxSetup: "github-askpass",
  },
} as const satisfies Record<string, ManagedConnectionDefinition>;

export const MANAGED_CONNECTION_DEFINITIONS = Object.values(MANAGED_CONNECTIONS) as ManagedConnectionDefinition[];

export const MANAGED_CONNECTION_ENV_ALIASES = MANAGED_CONNECTION_DEFINITIONS
  .flatMap((definition) => definition.envAliases ?? []);

export const MANAGED_CONNECTION_ENV_KEYS = MANAGED_CONNECTION_DEFINITIONS
  .map((definition) => definition.envKey);

export const MANAGED_CONNECTION_BY_ENV_KEY = Object.fromEntries(
  MANAGED_CONNECTION_DEFINITIONS.map((definition) => [definition.envKey, definition]),
) as Partial<Record<ConnectionEnvName, ManagedConnectionDefinition>>;

export const MANAGED_CONNECTION_BY_KIND = Object.fromEntries(
  MANAGED_CONNECTION_DEFINITIONS.map((definition) => [definition.kind, definition]),
) as Partial<Record<string, ManagedConnectionDefinition>>;

export const MANAGED_CONNECTION_ENV_KEY_BY_KIND = Object.fromEntries(
  MANAGED_CONNECTION_DEFINITIONS.map((definition) => [definition.kind, definition.envKey]),
) as Partial<Record<string, ConnectionEnvName>>;

export function connectionDefinitionForEnvKey(envKey: string): ManagedConnectionDefinition | undefined {
  return MANAGED_CONNECTION_BY_ENV_KEY[envKey as ConnectionEnvName]
    ?? MANAGED_CONNECTION_DEFINITIONS.find((definition) => definition.envKey === envKey);
}

export function connectionDefinitionForKind(kind: string): ManagedConnectionDefinition | undefined {
  return MANAGED_CONNECTION_BY_KIND[kind];
}

export function managedConnectionDefinitions(): ManagedConnectionDefinition[] {
  return MANAGED_CONNECTION_DEFINITIONS;
}

export function managedConnectionAuthSetupDefinitions(): ManagedConnectionDefinition[] {
  return MANAGED_CONNECTION_DEFINITIONS.filter(definition => Boolean(definition.sandboxSetup));
}

export function managedConnectionDefinitionForKind(kind: string): ManagedConnectionDefinition | undefined {
  return (MANAGED_CONNECTIONS as Record<string, ManagedConnectionDefinition>)[kind];
}

export function managedConnectionEnvKeyForKind(kind: string): ConnectionEnvName | undefined {
  return managedConnectionDefinitionForKind(kind)?.envKey;
}
