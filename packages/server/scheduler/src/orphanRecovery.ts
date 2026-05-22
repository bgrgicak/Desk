import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Crash signatures emitted to stderr when an in-container child dies from
 * a fatal signal. We treat any of these as "do not retry — the previous
 * attempt panicked, retrying re-fires the same panic." This is distinct
 * from a clean non-zero exit (handled by classifyResourceError /
 * finalizeExecution in the normal path) and from SIGKILL/OOM (recovered
 * by sandbox auto-grow). The patterns below are emitted by libc / shell
 * (`fault from waitpid`-style messages), not by our code, so they survive
 * the API crashing mid-run and remain in the on-disk log.
 */
const CRASH_SIGNATURES: ReadonlyArray<{ pattern: RegExp; kind: string }> = [
  { pattern: /Trace\/breakpoint trap/i, kind: "SIGTRAP" },
  { pattern: /Segmentation fault/i, kind: "SIGSEGV" },
  { pattern: /\bAborted\b.*core dumped|\bcore dumped\b/i, kind: "core_dumped" },
  { pattern: /Illegal instruction/i, kind: "SIGILL" },
  { pattern: /Bus error/i, kind: "SIGBUS" },
];

/**
 * Only read the tail of the log file. A long-running run can produce
 * MB of output; crash markers are always near the end (the process
 * exited right after emitting them).
 */
const TAIL_BYTES = 16 * 1024;

export interface OrphanCandidate {
  /** Message id (the run id). */
  id: string;
  /** Chat id — needed to locate the log file under .chats/{chatId}/logs/. */
  chatId: string;
  /** Workspace slug (workspaces.path) — the top-level directory under ROOMY_HOME. */
  workspacePath: string;
}

export interface CrashedOrphan extends OrphanCandidate {
  /** Which signature matched. Reported to ops logs. */
  signature: string;
}

/**
 * Reads the tail of `${home}/${workspacePath}/.chats/${chatId}/logs/${id}.log`
 * and reports whether the most recent run for this message died from a
 * fatal signal. A missing log file is treated as "no crash detected" —
 * recoverOrphanedRuns will requeue and re-fire as usual, which is the
 * correct behaviour for a run that was interrupted before it ever wrote
 * to its log.
 */
export async function detectCrashedOrphans(
  home: string,
  candidates: ReadonlyArray<OrphanCandidate>,
): Promise<CrashedOrphan[]> {
  const out: CrashedOrphan[] = [];
  for (const c of candidates) {
    const logPath = path.join(home, c.workspacePath, ".chats", c.chatId, "logs", `${c.id}.log`);
    const sig = await readCrashSignature(logPath);
    if (sig) out.push({ ...c, signature: sig });
  }
  return out;
}

async function readCrashSignature(logPath: string): Promise<string | null> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(logPath, "r");
    const stat = await fh.stat();
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const len = stat.size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const tail = buf.toString("utf8");
    for (const { pattern, kind } of CRASH_SIGNATURES) {
      if (pattern.test(tail)) return kind;
    }
    return null;
  } catch {
    // ENOENT (no log yet — never started) or read error — treat as
    // "no crash evidence", let normal requeue handle it.
    return null;
  } finally {
    await fh?.close().catch(() => { /* best-effort */ });
  }
}
