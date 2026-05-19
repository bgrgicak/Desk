/**
 * SQL-fragment builders and JS-side classifiers shared by the
 * message-listing queries in `messages.ts`. Extracted to keep the
 * call-site file under a sane line count while preserving the
 * tightly-coupled relationships between these helpers (every
 * compactContentSql call cascades into the diagnostic + structured-
 * payload helpers, which is why they shipped together originally).
 *
 * Everything in this module is package-private (`export` is for
 * messages.ts; consumers go through `queries.messages`).
 */

export function userVisibleDiagnosticSql(expr: string): string {
  const line = `lower(COALESCE(${expr}, ''))`;
  return `(
    NOT ${structuredToolPayloadSql(expr)} AND (
    instr(${line}, 'error') > 0 OR
    instr(${line}, 'failed') > 0 OR
    instr(${line}, 'failure') > 0 OR
    instr(${line}, 'exception') > 0 OR
    instr(${line}, 'traceback') > 0 OR
    instr(${line}, 'not found') > 0 OR
    instr(${line}, 'permission denied') > 0 OR
    instr(${line}, 'unauthorized') > 0 OR
    instr(${line}, 'unauthorised') > 0 OR
    instr(${line}, 'forbidden') > 0 OR
    instr(${line}, 'invalid') > 0 OR
    instr(${line}, 'cannot') > 0 OR
    instr(${line}, 'can''t') > 0
    )
  )`;
}

export function structuredToolPayloadSql(expr: string): string {
  const line = `lower(ltrim(COALESCE(${expr}, '')))`;
  return `(
    substr(${line}, 1, 6) = '<path>' OR
    substr(${line}, 1, 6) = '<type>' OR
    substr(${line}, 1, 9) = '<content>' OR
    substr(${line}, 1, 14) = '<skill_content' OR
    substr(${line}, 1, 16) = '<system-reminder' OR
    substr(${line}, 1, 5) = '<env>' OR
    substr(${line}, 1, 17) = '<available_skills' OR
    instr(${line}, '</path> <type>') > 0 OR
    instr(${line}, '<skill_content') > 0
  )`;
}

export function userVisibleDiagnosticEventSql(expr: string): string {
  return `(
    ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.type')`)} AND (
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.message')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.error')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.error.message')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.error.data.message')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.details')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.detail')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.text')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.reason')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.data')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.data.message')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.part.message')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.part.error')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.part.error.message')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.part.error.data.message')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.part.details')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.part.detail')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.part.text')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.part.reason')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.part.data')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.part.data.message')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.part')`)} OR
      ${userVisibleDiagnosticSql(`json_extract(${expr}, '$.event.type')`)}
    )
  )`;
}

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
