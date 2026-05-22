/**
 * Memory-system Phase 5 — production-grade `reflectWorkspace` implementation.
 * The scheduler injects a test stub in unit tests; production runs the
 * workspace's own agent inside that workspace's sandbox so memory decisions
 * stay scoped to the same agent/environment that owns the workspace.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { queries, type Pool } from "@agent-desk/db";
import { generateId } from "@agent-desk/shared";
import { createOrReuse } from "./docker.js";
import { buildWorkspaceMountPlan } from "./mounts.js";
import { execRun } from "./execRun.js";

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
  pool: Pool;
  home: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  userId: string;
  userName: string;
  userTimezone?: string;
  agent: { id: string; name: string; model: string };
  providerKeys?: Record<string, string>;
  /** Codex-bridge env (`PI_AUTH_JSON_BASE64`), injected into the reflection sandbox exec. */
  extraEnv?: Record<string, string>;
  date: string;
  activity: Array<{
    chatId: string;
    role: string;
    createdAt: string;
    body: string;
  }>;
  priorJournals: Array<{ date: string; body: string }>;
}

type ReflectFn<I> = (input: I) => Promise<ReflectionResult>;

const here = path.dirname(fileURLToPath(import.meta.url));

// Match prompt.ts: read from src/prompts when running under the dev
// export condition, dist/prompts otherwise. The copy-assets postbuild
// step keeps the latter in sync.
const PROMPTS_DIR = path.resolve(here, "prompts");

function reflectionModel(agentModel: string): string {
  return process.env.DESK_REFLECTION_MODEL ?? agentModel;
}

async function readPrompt(rel: string): Promise<string> {
  const abs = path.resolve(PROMPTS_DIR, rel);
  return await fs.readFile(abs, "utf-8");
}

function serializeWorkspaceInput(input: WorkspaceReflectionInput): string {
  const header = [
    `Workspace: ${input.workspaceName} (${input.workspaceSlug})`,
    `Agent: ${input.agent.name} (${input.agent.id}, ${input.agent.model})`,
    `User: ${input.userName} (${input.userId})`,
    `Date: ${input.date}`,
    "",
    "Activity (oldest first):",
    "",
  ].join("\n");
  const activity = input.activity.length === 0
    ? "(no activity)"
    : input.activity
    .map(
      (a) =>
        `- ${a.createdAt} [${a.role}] (${a.chatId}): ${a.body.replace(/\n/g, " ")}`,
    )
    .join("\n");
  const journalHeader = [
    "",
    "",
    `Prior journals for memory curation (newest first, max ${input.priorJournals.length}):`,
    "",
  ].join("\n");
  const journals = input.priorJournals.length === 0
    ? "(no prior journals)"
    : input.priorJournals
      .map((j) => `## ${j.date}\n\n${j.body.trim()}`)
      .join("\n\n---\n\n");
  return `${header}${activity}${journalHeader}${journals}`;
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

function extractPiText(raw: string): string | null {
  const texts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        part?: { type?: string; text?: string };
      };
      if (event.type === "text" && typeof event.part?.text === "string") {
        texts.push(event.part.text);
      }
    } catch {
      // Non-JSON stdout is handled by the fallback object extractor below.
    }
  }
  return texts.length > 0 ? texts.join("") : null;
}

function parseReflection(raw: string): ReflectionResult | null {
  const blob = extractJsonObject(extractPiText(raw) ?? raw);
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
  input: WorkspaceReflectionInput,
): Promise<ReflectionResult> {
  let promptHeader: string;
  try {
    promptHeader = await readPrompt("reflection-workspace.md");
  } catch (err) {
    return degraded(`prompt read failed: ${(err as Error).message}`);
  }
  const fullPrompt = `${promptHeader}\n\n---\n\n${serializeWorkspaceInput(input)}`;
  const runId = generateId("message");
  let stdout = "";
  let stderr = "";
  // Reuse the workspace's existing sandbox by reproducing the mount plan
  // a regular chat fire would build. Without this, a hub reflection
  // recreates the container with only the 2-bind default plan and the
  // very next chat turn drift-recreates it back to the full sibling-
  // mount plan — pi never stays up long enough for a turn
  // to complete. Mirrors scheduler/runs.ts:fireMessage.
  const workspace = await queries.workspaces.findById(input.pool, input.workspaceId);
  const workspaceKind: "project" | "hub" = workspace?.kind === "hub" ? "hub" : "project";
  const siblingSlugs = workspaceKind === "hub" && input.userId
    ? (await queries.workspaces.listByUser(input.pool, input.userId))
        .filter((w) => w.id !== input.workspaceId)
        .map((w) => w.path)
    : [];
  const localFsResolution = await buildWorkspaceMountPlan(input.pool, {
    home: input.home,
    workspaceId: input.workspaceId,
    workspaceSlug: input.workspaceSlug,
    userId: input.userId || null,
    siblingWorkspaceSlugs: siblingSlugs,
  });
  const mountPlan = workspaceKind === "hub" || localFsResolution.agentDirectories.length > 0
    ? localFsResolution.mountPlan
    : undefined;
  const handle = await createOrReuse(
    input.workspaceId,
    input.workspaceSlug,
    input.home,
    input.providerKeys,
    mountPlan,
    input.extraEnv,
    workspaceKind,
  );
  const result = await execRun(input.pool, handle, {
    runId,
    prompt: fullPrompt,
    home: input.home,
    workspaceId: input.workspaceId,
    workspaceSlug: input.workspaceSlug,
    agent: {
      agentId: input.agent.id,
      agentName: input.agent.name,
      model: reflectionModel(input.agent.model),
      userName: input.userName,
      userTimezone: input.userTimezone,
      runMode: "reflection",
    },
    providerKeys: input.providerKeys,
    extraEnv: input.extraEnv,
    mountPlan,
    onLog: (event) => {
      // The runtime emits per-turn output as `kind: "event"` (translated
      // SSE events from pi, each a JSON line like
      // `{"type":"text","part":{"text":"…"}}`). Legacy `kind: "stdout"`
      // entries are still accepted for the fake driver and any future
      // raw-output path.
      if (event.kind === "stdout" || event.kind === "event") {
        stdout += `${event.payload}\n`;
      }
      if (event.kind === "stderr") stderr += `${event.payload}\n`;
    },
  });
  if (result.exitCode !== 0) {
    // The driver now folds the daemon's own `/tmp/pi.log`
    // tail into stderr on failure paths (see driver.ts), so the message
    // length budget has to be larger than the old 400 char cap or the
    // useful part gets clipped.
    return degraded(`sandbox reflection exited ${result.exitCode}: ${stderr.trim().slice(0, 4000)}`);
  }
  const parsed = parseReflection(stdout);
  if (!parsed) {
    return degraded(
      `could not parse JSON from sandbox reflection output (got ${stdout.length} bytes): ${stdout.trim().slice(0, 400)}`,
    );
  }
  return parsed;
}

export const productionReflectWorkspace: ReflectFn<WorkspaceReflectionInput> = async (
  input,
) => callReflection(input);
