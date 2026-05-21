/**
 * JS-side diagnostic / structured-payload classifiers used by the
 * message-listing queries in `messages-internal.ts` when compacting
 * `events` log entries and `toolResult` payloads for non-`full` views.
 *
 * Everything in this module is package-private; consumers go through
 * `queries.messages`.
 */

export function isUserVisibleDiagnosticLine(line: string): boolean {
  if (isStructuredToolPayloadLine(line)) return false;
  return /\b(error|failed|failure|exception|traceback|not found|permission denied|unauthori[sz]ed|forbidden|invalid|cannot|can't)\b/i.test(line);
}

export function isStructuredToolPayloadLine(line: string): boolean {
  const trimmed = line.trimStart();
  return /^<(path|type|content|skill_content|system-reminder|env|available_skills)\b/i.test(trimmed)
    || /<\/path>\s*<type>/.test(trimmed)
    || /<skill_content\b/i.test(trimmed);
}

export function firstDiagnosticString(value: unknown): string | null {
  if (typeof value === "string") return isUserVisibleDiagnosticLine(value) ? value : null;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstDiagnosticString(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const preferredKeys = new Set(["message", "error", "details", "detail", "text", "reason", "data"]);
  for (const key of preferredKeys) {
    const found = firstDiagnosticString(record[key]);
    if (found) return found;
  }
  for (const [key, child] of Object.entries(record)) {
    if (preferredKeys.has(key)) continue;
    const found = firstDiagnosticString(child);
    if (found) return found;
  }
  return null;
}

export function eventHasUserVisibleDiagnostic(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  if (typeof record.type !== "string" || !isUserVisibleDiagnosticLine(record.type)) return false;
  return !!(firstDiagnosticString(record.part) ?? firstDiagnosticString(record) ?? (typeof record.type === "string" && isUserVisibleDiagnosticLine(record.type)));
}
