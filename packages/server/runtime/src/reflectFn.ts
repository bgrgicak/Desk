/**
 * Memory-system Phase 5 — production-grade `reflectWorkspace` /
 * `reflectUser` implementations. The orchestrator in `@agent-desk/scheduler`
 * accepts a `ReflectFn`; tests inject deterministic stubs, but on the
 * server we shell out to the real `opencode` CLI on the host.
 *
 * Why host-side (not in a sandbox): the reflection input is workspace
 * activity that the host already has in its DB and on disk. There's no
 * untrusted code being executed — only an LLM call against text the
 * server already trusts. Keeping it on the host avoids the per-call
 * sandbox spin-up cost and the bind-mount dance.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Local copies of the scheduler types. We can't depend on
// `@agent-desk/scheduler` here without creating a cycle (scheduler
// already depends on runtime), so we duplicate the small shape and
// rely on TypeScript's structural typing to match at the call site
// in `api/src/main.ts`.

interface ReflectionResult {
  journal: string;
  memoryEdits?: Array<{ path: string; body: string }>;
}

interface WorkspaceReflectionInput {
  workspaceSlug: string;
  workspaceName: string;
  date: string;
  activity: Array<{
    chatId: string;
    role: string;
    createdAt: string;
    body: string;
  }>;
}

interface UserReflectionInput {
  userId: string;
  date: string;
  workspaceJournals: Array<{ workspaceSlug: string; body: string }>;
}

type ReflectFn<I> = (input: I) => Promise<ReflectionResult>;

const here = path.dirname(fileURLToPath(import.meta.url));

// Match prompt.ts: read from src/prompts when running under the dev
// export condition, dist/prompts otherwise. The copy-assets postbuild
// step keeps the latter in sync.
const PROMPTS_DIR = path.resolve(here, "prompts");

const DEFAULT_MODEL = "opencode/gpt-5-nano";
const DEFAULT_TIMEOUT_MS = 120_000;

function reflectionModel(): string {
  return process.env.DESK_REFLECTION_MODEL ?? DEFAULT_MODEL;
}

function reflectionTimeoutMs(): number {
  const raw = process.env.DESK_REFLECTION_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

async function readPrompt(rel: string): Promise<string> {
  const abs = path.resolve(PROMPTS_DIR, rel);
  return await fs.readFile(abs, "utf-8");
}

function serializeWorkspaceInput(input: WorkspaceReflectionInput): string {
  const header = [
    `Workspace: ${input.workspaceName} (${input.workspaceSlug})`,
    `Date: ${input.date}`,
    "",
    "Activity (oldest first):",
    "",
  ].join("\n");
  if (input.activity.length === 0) return `${header}(no activity)`;
  const bullets = input.activity
    .map(
      (a) =>
        `- ${a.createdAt} [${a.role}] (${a.chatId}): ${a.body.replace(/\n/g, " ")}`,
    )
    .join("\n");
  return `${header}${bullets}`;
}

function serializeUserInput(input: UserReflectionInput): string {
  const header = [
    `User: ${input.userId}`,
    `Date: ${input.date}`,
    "",
    "Per-workspace journal entries from yesterday:",
    "",
  ].join("\n");
  if (input.workspaceJournals.length === 0) return `${header}(no journals)`;
  const sections = input.workspaceJournals
    .map(
      (j) => `### Workspace ${j.workspaceSlug}\n\n${j.body}`,
    )
    .join("\n\n");
  return `${header}${sections}`;
}

interface OpencodeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function runOpencode(
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<OpencodeResult> {
  return new Promise<OpencodeResult>((resolve) => {
    // `--pure` skips user/project plugin loading so this call can't be
    // disturbed by an unrelated MCP or hook from the user's own
    // ~/.opencode config; `run` is one-shot non-interactive.
    const child = spawn(
      "opencode",
      ["run", "--pure", "-m", model, prompt],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + (stderr ? "\n" : "") + String(err),
        exitCode: null,
        signal: null,
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, signal, timedOut });
    });
  });
}

// The reflection prompt asks for a JSON object back. Models occasionally
// wrap it in a ```json fence or add a leading explanation; pull the
// first balanced { … } block out of the response before parsing.
function extractJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseReflection(raw: string): ReflectionResult | null {
  const blob = extractJsonObject(raw);
  if (!blob) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.journal !== "string" || obj.journal.length === 0) return null;
  const result: ReflectionResult = { journal: obj.journal };
  if (Array.isArray(obj.memoryEdits)) {
    const edits: Array<{ path: string; body: string }> = [];
    for (const entry of obj.memoryEdits) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).path === "string" &&
        typeof (entry as Record<string, unknown>).body === "string"
      ) {
        edits.push({
          path: (entry as { path: string }).path,
          body: (entry as { body: string }).body,
        });
      }
    }
    if (edits.length > 0) result.memoryEdits = edits;
  }
  return result;
}

function degraded(reason: string): ReflectionResult {
  return { journal: `(reflection failed: ${reason})`, memoryEdits: [] };
}

async function callReflection(
  promptFile: string,
  serializedInput: string,
): Promise<ReflectionResult> {
  let promptHeader: string;
  try {
    promptHeader = await readPrompt(promptFile);
  } catch (err) {
    return degraded(`prompt read failed: ${(err as Error).message}`);
  }
  const fullPrompt = `${promptHeader}\n\n---\n\n${serializedInput}`;
  const result = await runOpencode(reflectionModel(), fullPrompt, reflectionTimeoutMs());
  if (result.timedOut) return degraded("opencode call timed out");
  if (result.exitCode !== 0) {
    return degraded(
      `opencode exited ${result.exitCode ?? "?"}${result.signal ? `/${result.signal}` : ""}: ${result.stderr.trim().slice(0, 400)}`,
    );
  }
  const parsed = parseReflection(result.stdout);
  if (!parsed) {
    return degraded(`could not parse JSON from opencode output (got ${result.stdout.length} bytes)`);
  }
  return parsed;
}

export const productionReflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async (
  input,
) => callReflection("reflection-workspace.md", serializeWorkspaceInput(input));

export const productionReflectUser: ReflectFn<UserReflectionInput> = async (
  input,
) => callReflection("reflection-user.md", serializeUserInput(input));
