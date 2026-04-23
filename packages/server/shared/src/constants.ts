export const ID_PREFIXES = {
  user: "usr_",
  agent: "agt_",
  workspace: "wks_",
  chat: "cht_",
  message: "msg_",
  sandboxSession: "sbs_",
} as const;

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 128 * 1024;
export const DEFAULT_LIBRARY_PAGE_SIZE = 50;

export const MESSAGE_ROLES = ["user", "agent", "system", "tool"] as const;

/** Kinds emitted by message.log_appended WS events. */
export const MESSAGE_LOG_KINDS = ["stdout", "stderr", "event"] as const;

/**
 * AI-provider credentials known to opencode. Used both for forwarding host
 * env into sandboxes and for keys the user can manage via /me/providers.
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
