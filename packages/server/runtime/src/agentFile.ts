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
  runMode?: "chat" | "summary" | "reflection";
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
): Promise<void> {
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
  await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify(config, null, 2) + "\n", "utf-8");
}
