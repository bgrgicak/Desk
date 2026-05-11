import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type GoalKey, type WorkspaceKind } from "@agent-desk/shared";
import {
  userMemoryIndexPath,
  workspaceMemoryIndexPath,
} from "@agent-desk/storage";

/**
 * System-prompt rendering pipeline.
 *
 * Every prose fragment of the agent file's body lives as a markdown file
 * under `prompts/`. The order is the array `SYSTEM_PROMPT_ORDER` below;
 * to reorder, edit the array. Conditional fragments return `null` when
 * the input doesn't apply (e.g. no goal set, no chat id), and are
 * filtered out before joining.
 *
 * `{{name}}` placeholders are substituted strictly — an unknown
 * placeholder throws and names the offending fragment so typos surface
 * in tests rather than at runtime.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(here, "prompts");

const rawCache = new Map<string, string>();

function readRaw(rel: string): string {
  const cached = rawCache.get(rel);
  if (cached !== undefined) return cached;
  const full = path.resolve(PROMPTS_DIR, rel);
  const text = fs.readFileSync(full, "utf-8");
  rawCache.set(rel, text);
  return text;
}

/**
 * Reads a fragment and substitutes `{{name}}` placeholders. Throws if any
 * placeholder is missing from `vars`, naming the fragment file so the
 * offender is obvious. Memoizes the raw read; substitution runs every
 * call.
 */
export function loadAndSub(rel: string, vars: Record<string, string>): string {
  const raw = readRaw(rel);
  return raw.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(
        `Missing placeholder "{{${name}}}" while rendering prompt fragment "${rel}"`,
      );
    }
    return vars[name];
  });
}

export interface RenderPromptInput {
  agentName: string;
  userName: string;
  userTimezone?: string;
  chatId?: string;
  goal?: GoalKey | null;
  includeGoalAutodetect?: boolean;
  runMode?: "chat" | "summary" | "reflection";
  /**
   * DESK_HOME root used to read the user / workspace memory index files.
   * When unset, memory injection is skipped (lets unit tests render the
   * prompt without a real home tree).
   */
  home?: string;
  /**
   * Workspace slug whose `.memory/workspace.md` should be injected. Pass
   * with `home`; without both, workspace memory is skipped.
   */
  workspaceSlug?: string;
  /**
   * Kind of the workspace this run belongs to. Drives kind-specific
   * prompt fragments — currently the `hub.md` section, only injected
   * when `kind === 'hub'`.
   */
  workspaceKind?: WorkspaceKind;
}

const EMPTY_USER_MEMORY = `# User memory\n\n_(empty — nothing remembered yet)_\n`;
const EMPTY_WORKSPACE_MEMORY = `# Workspace memory\n\n_(empty — nothing remembered yet)_\n`;

/**
 * Reads a memory index file. Missing or empty files inject a stub so the
 * agent still sees the memory section header. Unexpected filesystem errors
 * are surfaced in the prompt instead of pretending memory is empty.
 */
function readMemoryIndex(filePath: string, fallback: string, label: string): string {
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    return raw.length > 0 ? raw : fallback;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return fallback;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `# ${label} memory\n\n_(memory unavailable: ${message})_\n`;
  }
}

function userMemoryFragment(home: string): string {
  const body = readMemoryIndex(userMemoryIndexPath(home), EMPTY_USER_MEMORY, "User");
  return `<!-- Desk user memory index -->\n${body}`;
}

function workspaceMemoryFragment(home: string, slug: string): string {
  const body = readMemoryIndex(workspaceMemoryIndexPath(home, slug), EMPTY_WORKSPACE_MEMORY, "Workspace");
  return `<!-- Desk workspace memory index -->\n${body}`;
}

type Fragment = (input: RenderPromptInput) => string | null;

const SYSTEM_PROMPT_ORDER: Fragment[] = [
  (input) =>
    loadAndSub("mandate.md", {
      agentName: input.agentName,
      userName: input.userName,
    }),
  (input) => {
    if (input.runMode === "summary") {
      const chatPaths = input.chatId
        ? `Chat summaries: ~/.chats/${input.chatId}/notes/\n` +
          `Chat artifacts:  ~/.chats/${input.chatId}/artifacts/\n`
        : "";
      return loadAndSub("summary.md", { chatPaths });
    }
    if (input.runMode === "reflection") return null;
    const chatPaths = input.chatId
      ? `\nChat artifacts:   ~/.chats/${input.chatId}/artifacts/\n` +
        `Chat attachments: ~/.chats/${input.chatId}/attachments/\n` +
        `Chat summaries:   ~/.chats/${input.chatId}/notes/\n`
      : "";
    const attachArtifactInstruction = input.chatId
      ? `**Surface in chat.** Always run \`desk-agent chat attach-artifact --chat ${input.chatId} "<path>"\` as the last step of any turn in which you create, significantly update, or retrieve from the current chat/workspace library an artifact the user is asking to see — no exceptions for type (file, app, directory, image, library item, etc.). Library search is scoped to the current chat/workspace; do not expect cross-workspace results. If the artifact is a directory (e.g. a Desk app), pass the directory path. Quote the path. Do not reply to the user until the attach command has been executed or you have determined no attachable current-workspace path exists. If the command fails, report the error inline instead of silently skipping. Load \`desk-cli-chat-attach-artifact\` if you need syntax details or examples.`
      : "";
    return loadAndSub("artifacts.md", { chatPaths, attachArtifactInstruction });
  },
  (input) => input.runMode === "summary" || input.runMode === "reflection" ? null : loadAndSub("task-context.md", {}),
  (input) =>
    input.runMode === "summary" || input.runMode === "reflection"
      ? null
      : input.userTimezone
      ? loadAndSub("scheduling-tz-known.md", {
          userName: input.userName,
          userTimezone: input.userTimezone,
        })
      : loadAndSub("scheduling-tz-unknown.md", {}),
  (input) => input.runMode === "summary" || input.runMode === "reflection" || input.includeGoalAutodetect === false ? null : loadAndSub("goal-autodetect.md", {}),
  (input) => input.runMode === "summary" || input.runMode === "reflection" ? null : loadAndSub("persistence.md", {}),
  // Memory rules + retrieval pointers, then the user and workspace memory
  // indexes. Order: rules → user index → workspace index. The agent
  // resolves conflicts itself; workspace wins on workspace-specific
  // topics, user wins on cross-cutting style.
  (input) => input.runMode === "summary" ? null : loadAndSub("context.md", {}),
  (input) => input.runMode === "summary" || input.runMode === "reflection" || !input.home ? null : userMemoryFragment(input.home),
  (input) =>
    input.runMode === "summary" || !input.home || !input.workspaceSlug
      ? null
      : workspaceMemoryFragment(input.home, input.workspaceSlug),
  (input) =>
    input.runMode !== "summary" && input.runMode !== "reflection" && input.goal ? loadAndSub(`goal/${input.goal}.md`, {}) : null,
  (input) => input.runMode === "summary" || input.runMode === "reflection" ? null : loadAndSub("desk-skills.md", {}),
  // Hub-only section. Explains the hub's extra abilities (cross-workspace
  // FS read, cross-workspace API call, pinning, route_to_workspace
  // handoff). Only rendered when the request originates from the hub
  // workspace; never injected into project-workspace runs.
  (input) =>
    input.runMode === "summary" || input.runMode === "reflection" || input.workspaceKind !== "hub"
      ? null
      : loadAndSub("hub.md", { userName: input.userName }),
];

/**
 * Renders the full body of an agent file by running every fragment in
 * order, dropping nulls, and joining with a blank line. The fragments
 * are responsible for their own internal headings and trailing newlines.
 */
export function renderPromptBody(input: RenderPromptInput): string {
  return SYSTEM_PROMPT_ORDER
    .map((frag) => frag(input))
    .filter((s): s is string => s !== null)
    .map((s) => s.trim())
    .join("\n\n");
}
