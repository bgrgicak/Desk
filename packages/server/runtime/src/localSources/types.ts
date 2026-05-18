/**
 * Local sources are model providers the user already has running on their
 * own machine — Codex (ChatGPT-subscription tokens), LM Studio (HTTP API),
 * Ollama, etc. Desk detects them on the host and bridges them into the
 * sandbox via env vars; no API key is required.
 *
 * Cloud sources (Anthropic, OpenAI, Gemini, …) live on the other path:
 * the user pastes an API key, Desk stores it in the per-user KDBX vault,
 * and the connection machinery forwards it as a named env var.
 */

/** Kind discriminator. Add a new entry here when you register a new local source. */
export type LocalSourceKind = "codex";

export interface LocalSourceStatus {
  kind: LocalSourceKind;
  /** A usable instance is currently detected on the host. */
  available: boolean;
  /** Why the source isn't available; populated only when `available` is false. */
  reason?: string;
  /**
   * Free-form per-source detail surfaced in the UI (e.g. account email, plan
   * type, expiry, base URL). Never include token/credential material here.
   */
  detail?: Record<string, string | number | boolean>;
}

export interface LocalSource {
  kind: LocalSourceKind;
  /** Inspects the host without exposing secrets. Safe to call from API routes. */
  detect(): LocalSourceStatus;
  /**
   * Returns a map of env vars to inject into the sandbox when the user has
   * opted in. Returning null means the source is currently unusable (host
   * file missing, server down, …) and the runtime should treat the
   * connection as silently disabled for this run.
   */
  loadEnv(): Record<string, string> | null;
}
