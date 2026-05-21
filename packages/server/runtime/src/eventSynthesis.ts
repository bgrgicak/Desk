/**
 * Synthesize SSE-shaped events from a polled assistant message envelope.
 *
 * The opencode-serve poll path needs to emit reasoning-text deltas,
 * tool status transitions, and one-shot static parts (step-start,
 * step-finish, …) as if they had arrived over SSE — the rest of the
 * runtime treats every event the same way regardless of source.
 * Lives next to driver.ts so the daemon polling loop can import it
 * without dragging the rest of the driver surface along.
 */

export type PartEmissionState = Map<
  string,
  { reasoningTextEmitted?: number; toolStatus?: string; emitted?: boolean }
>;

export function* synthesizeNonTextEvents(
  messageOrEnvelope: unknown,
  sessionID: string,
  state?: PartEmissionState,
): Iterable<string> {
  if (!messageOrEnvelope || typeof messageOrEnvelope !== "object") return;
  // Accept either the raw assistant-message envelope `{info, parts}`
  // or just the inner message shape with a top-level `parts`.
  const env = messageOrEnvelope as { parts?: unknown; info?: unknown };
  if (!Array.isArray(env.parts)) return;
  // Pull the providerID/modelID/agent/mode the daemon actually used for
  // this assistant message. Surfacing it on every synthesized event
  // makes "what model produced this step?" answerable from the chat
  // log alone — invaluable when a session was bound to one model and
  // an upstream switch didn't propagate.
  const meta = extractAssistantInfoMeta(env.info);
  for (const partRaw of env.parts) {
    if (!partRaw || typeof partRaw !== "object") continue;
    const part = partRaw as { type?: unknown; id?: unknown; text?: unknown; state?: unknown };
    if (typeof part.type !== "string") continue;
    // Text parts already streamed via SSE deltas; re-emitting them
    // would duplicate the message body when `deriveTextFromLog`
    // concatenates `text` events.
    if (part.type === "text") continue;

    const partId = typeof part.id === "string" ? part.id : "";
    const prior = state && partId ? state.get(partId) ?? {} : {};

    // Reasoning: opencode-serve doesn't reliably broadcast reasoning
    // deltas over SSE for multi-step turns, so the polling loop is
    // the only path that sees reasoning growing. Mimic the SSE
    // delta shape — emit just the suffix added since the last
    // observation — so the UI streams reasoning text the same way
    // it streams the final answer.
    if (part.type === "reasoning") {
      const fullText = typeof part.text === "string" ? part.text : "";
      const previouslyEmitted = prior.reasoningTextEmitted ?? 0;
      if (fullText.length <= previouslyEmitted) {
        if (state && partId) state.set(partId, prior);
        continue;
      }
      const delta = fullText.slice(previouslyEmitted);
      const deltaPart: Record<string, unknown> = {
        type: "reasoning",
        text: delta,
        id: partId,
      };
      const messageID = (part as { messageID?: unknown }).messageID;
      if (typeof messageID === "string") deltaPart.messageID = messageID;
      const event: Record<string, unknown> = { type: "reasoning", part: deltaPart, sessionID };
      if (meta) event.model = meta;
      if (state && partId) state.set(partId, { ...prior, reasoningTextEmitted: fullText.length });
      yield JSON.stringify(event);
      continue;
    }

    // Tool parts mutate as the call moves through pending → running
    // → completed/error. Emit on every status transition so the UI
    // sees the tool card update; collapse repeated observations of
    // the same status.
    if (part.type === "tool") {
      const status = (part.state as { status?: unknown } | undefined)?.status;
      const statusStr = typeof status === "string" ? status : "";
      if (state && partId && prior.toolStatus === statusStr) continue;
      const event: Record<string, unknown> = { type: "tool", part, sessionID };
      if (meta) event.model = meta;
      if (state && partId) state.set(partId, { ...prior, toolStatus: statusStr });
      yield JSON.stringify(event);
      continue;
    }

    // Static parts (step-start, step-finish, …) — emit exactly once.
    if (state && partId) {
      if (prior.emitted) continue;
      state.set(partId, { ...prior, emitted: true });
    }
    const runFormatType = part.type.replace(/-/g, "_");
    const event: Record<string, unknown> = { type: runFormatType, part, sessionID };
    if (meta) event.model = meta;
    yield JSON.stringify(event);
  }
}

export function extractAssistantInfoMeta(info: unknown): {
  providerID: string;
  modelID: string;
  agent?: string;
  mode?: string;
} | null {
  if (!info || typeof info !== "object") return null;
  const i = info as { providerID?: unknown; modelID?: unknown; agent?: unknown; mode?: unknown };
  if (typeof i.providerID !== "string" || typeof i.modelID !== "string") return null;
  const out: { providerID: string; modelID: string; agent?: string; mode?: string } = {
    providerID: i.providerID,
    modelID: i.modelID,
  };
  if (typeof i.agent === "string") out.agent = i.agent;
  if (typeof i.mode === "string") out.mode = i.mode;
  return out;
}
