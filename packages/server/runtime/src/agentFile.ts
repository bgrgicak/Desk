/**
 * Generates and writes OpenCode agent definition files.
 *
 * Under the workspace-as-home model the sandbox's `$HOME` is a bind-mount
 * of the workspace root, so the agent file lives at
 * `{workspaceRoot}/.opencode/agents/{agentId}.md` on the host and appears
 * inside the container at `~/.opencode/agents/{agentId}.md`.
 *
 * Writing host-side means no `docker exec` dance — the file is simply
 * present when the container runs `opencode`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspaceRootPath } from "@agent-desk/storage";
import { type GoalKey, type WorkspaceKind } from "@agent-desk/shared";
import { renderPromptBody } from "./prompt.js";

export interface AgentFileInput {
  agentId: string;
  agentName: string;
  model: string;
  userName: string;
  /**
   * IANA zone (e.g. `America/Los_Angeles`) reported by the user's app
   * client. Rendered into the system prompt so the agent interprets
   * unqualified user-supplied times in the right zone. Omit when unknown
   * — the agent is told to ask in that case.
   */
  userTimezone?: string;
  /**
   * Chat the agent is responding in. When set, the artifacts fragment
   * names the per-chat paths so the agent reads real paths instead of guessing.
   */
  chatId?: string;
  /**
   * Persistent goal for the chat. When set, the matching `goal/<key>.md`
   * fragment is rendered into the system prompt on every turn so the
   * agent has the same goal context across the whole conversation.
   */
  goal?: GoalKey | null;
  /**
   * Summary and reflection runs are internal. They get narrow prompts instead
   * of the full chat/task/artifact instruction set.
   */
  runMode?: "chat" | "scheduled-task" | "summary" | "reflection";
  /**
   * DESK_HOME root, threaded through so the prompt renderer can read the
   * user `.memory/memory.md` index and the workspace `.memory/workspace.md`
   * index. Optional — when missing, memory injection is skipped.
   */
  home?: string;
  /** Workspace slug for resolving the workspace memory index. */
  workspaceSlug?: string;
  /**
   * Kind of the workspace this agent file is being rendered for. Drives
   * kind-specific prompt fragments (e.g. the hub-only `hub.md` section).
   * Defaults to `project` so existing callers stay unchanged.
   */
  workspaceKind?: WorkspaceKind;
  /**
   * When false, the goal-autodetect fragment is omitted from the prompt.
   * Defaults to true.
   */
  includeGoalAutodetect?: boolean;
  localFilesystemDirectories?: Array<{ path: string; access: "read_only" | "read_write"; description?: string }>;
}

/**
 * Renders the content of an OpenCode agent `.md` file.
 */
export function renderAgentFile(input: AgentFileInput): string {
  const frontmatter = [
    "---",
    `description: ${input.agentName}`,
    `model: ${input.model}`,
    "mode: primary",
    // Pre-authorize every tool. Desk runs opencode inside a per-workspace
    // sandbox that already isolates the agent — there's no UI surface
    // for a "do you allow this tool?" prompt mid-turn, so any tool that
    // defaults to `ask` (bash, external_directory, doom_loop, …)
    // silently stalls the chat. Trunk's `opencode run --format json`
    // path passed `--dangerously-skip-permissions`; under the HTTP API
    // this object-form agent-level field is the equivalent. The bare
    // string form (`permission: allow`) is also schema-valid but
    // opencode 1.14.50's parser treats it as a per-character array
    // and rejects every char as not-PermissionActionConfig; the
    // explicit per-tool object form is unambiguous and accepted.
    "permission:",
    "  read: allow",
    "  edit: allow",
    "  glob: allow",
    "  grep: allow",
    "  list: allow",
    "  bash: allow",
    "  task: allow",
    "  external_directory: allow",
    "  todowrite: allow",
    "  question: allow",
    "  webfetch: allow",
    "  websearch: allow",
    "  repo_clone: allow",
    "  repo_overview: allow",
    "  lsp: allow",
    "  doom_loop: allow",
    "  skill: allow",
    "---",
  ].join("\n");

  const body = renderPromptBody({
    agentName: input.agentName,
    userName: input.userName,
    userTimezone: input.userTimezone,
    chatId: input.chatId,
    goal: input.goal ?? null,
    runMode: input.runMode ?? "chat",
    home: input.home,
    workspaceSlug: input.workspaceSlug,
    workspaceKind: input.workspaceKind ?? "project",
    includeGoalAutodetect: input.includeGoalAutodetect,
    localFilesystemDirectories: input.localFilesystemDirectories,
  });

  return `${frontmatter}\n\n${body}\n`;
}

/**
 * Writes the agent definition file to the host workspace so it's visible
 * inside the sandbox via the `~/` bind-mount. Idempotent — overwrites
 * existing file contents.
 *
 * The `home` argument is the DESK_HOME root (contains
 * `workspaces/desk/`). We no longer need the container id because
 * the file lands on the host filesystem.
 */
export async function writeAgentFile(
  home: string,
  workspaceSlug: string,
  input: AgentFileInput,
): Promise<void> {
  const content = renderAgentFile({ ...input, home, workspaceSlug });
  const agentDir = path.join(workspaceRootPath(home, workspaceSlug), ".opencode", "agents");
  const filePath = path.join(agentDir, `${input.agentId}.md`);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Returns a sha256 of every agent file's `model:` line under
 * `<workspace>/.opencode/agents/`. Feeding this hash into the
 * opencode-serve daemon's env makes our env-digest cache in
 * `ensureOpencodeServer` notice when an agent file's model changes
 * since the last spawn, even when no provider env has changed —
 * triggering a daemon restart so the daemon re-reads the agent files
 * (it caches `model:` in memory at startup and ignores per-message
 * `providerID`/`modelID` overrides for agent-bound sessions).
 *
 * Hashing only the `model:` lines keeps the digest stable across
 * the per-turn prompt-body rewrites that don't actually need a
 * daemon restart (memory index updates, timestamp tweaks, etc.).
 * Empty agents dir or read errors return an empty string — the
 * digest still feeds into env equality, so an empty-vs-non-empty
 * transition still flips the digest correctly.
 */
export async function readAgentsModelDigest(
  home: string,
  workspaceSlug: string,
): Promise<string> {
  const agentDir = path.join(workspaceRootPath(home, workspaceSlug), ".opencode", "agents");
  let entries: string[];
  try {
    entries = await fs.readdir(agentDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
  const files = entries.filter((n) => n.endsWith(".md")).sort();
  if (files.length === 0) return "";

  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for (const name of files) {
    let body = "";
    try {
      body = await fs.readFile(path.join(agentDir, name), "utf-8");
    } catch {
      continue;
    }
    // Pull only the `model:` line out of the frontmatter — that's the
    // sole field whose change forces a daemon restart. Everything
    // else (prompt body, permissions) takes effect on the next
    // sendMessage without a restart.
    const match = body.match(/^model:\s*(.+)$/m);
    const model = match ? match[1].trim() : "";
    hash.update(`${name}=${model}\n`);
  }
  return hash.digest("hex");
}

/**
 * Goals where the agent will likely need to drive a browser. Only chats
 * tagged with one of these get playwright-mcp wired up; everything else
 * starts the sandbox without firefox/playwright in memory, which is the
 * single largest baseline-resource saving on the sandbox.
 *
 * Conservative on purpose: there is no per-run override yet, so a chat
 * whose goal isn't `site`/`app` simply won't have firefox available.
 * If we accumulate edge cases that need the browser under other goals,
 * the right fix is either (a) re-tag the chat's goal or (b) add a
 * per-workspace `enable_playwright` setting — not a list of every
 * goal that *might* occasionally want it.
 */
const BROWSER_GOALS: ReadonlySet<GoalKey> = new Set(["site", "app"]);

export function chatNeedsBrowser(goal: GoalKey | null | undefined): boolean {
  if (!goal) return false;
  return BROWSER_GOALS.has(goal);
}

/**
 * Writes the per-workspace OpenCode config that enables playwright-mcp
 * only when the active chat goal warrants it. This is the "lazy MCP"
 * mechanism: the global `/etc/opencode/opencode.json` ships with no MCP
 * servers, and a workspace gets browser tooling only via this file.
 *
 * Always overwrites the workspace config rather than merging so the
 * heuristic stays the source of truth — if a previous run enabled
 * playwright for a `site` chat and the workspace's primary goal has
 * since become `document`, the next write turns it off again so the
 * next opencode start has no firefox child.
 */
export async function writeWorkspaceMcpConfig(
  home: string,
  workspaceSlug: string,
  opts: { enablePlaywright: boolean },
): Promise<{ changed: boolean }> {
  // Always emit the playwright key. If we wrote `mcp: {}` and opencode merges
  // with the global `/etc/opencode/opencode.json`, an older image still
  // shipping playwright would survive the merge and start firefox anyway.
  // Setting `enabled: false` explicitly disables it even when the global
  // config wins the merge.
  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      playwright: {
        type: "local" as const,
        command: ["playwright-mcp", "--browser", "firefox"],
        enabled: opts.enablePlaywright,
      },
    },
  };
  const dir = path.join(workspaceRootPath(home, workspaceSlug), ".opencode");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, "opencode.json");
  const next = JSON.stringify(config, null, 2) + "\n";
  let prev: string | null = null;
  try {
    prev = await fs.readFile(target, "utf-8");
  } catch {
    prev = null;
  }
  if (prev === next) return { changed: false };
  await fs.writeFile(target, next, "utf-8");
  return { changed: true };
}
