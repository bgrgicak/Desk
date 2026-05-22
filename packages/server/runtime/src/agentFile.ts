/**
 * Renders and writes pi's project-level system-prompt file.
 *
 * Pi auto-loads `AGENTS.md` (or `CLAUDE.md`) from cwd up through parent
 * directories. The workspace root *is* the agent's home inside the
 * sandbox (it's the rw bind-mount target), so a single AGENTS.md at the
 * workspace root is visible to every pi invocation.
 *
 * Writing host-side means no `docker exec` dance — the file is simply
 * present when pi reads it.
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
  userTimezone?: string;
  chatId?: string;
  goal?: GoalKey | null;
  runMode?: "chat" | "scheduled-task" | "summary" | "reflection";
  home?: string;
  workspaceSlug?: string;
  workspaceKind?: WorkspaceKind;
  includeGoalAutodetect?: boolean;
  localFilesystemDirectories?: Array<{ path: string; access: "read_only" | "read_write"; description?: string }>;
}

/**
 * Renders the AGENTS.md body for pi. Pi reads no frontmatter from this
 * file — the body is treated as plain system-prompt context. Per-agent
 * model/permission selection is passed to pi on the CLI (`--model`,
 * `--no-builtin-tools`) by the driver instead.
 */
export function renderAgentFile(input: AgentFileInput): string {
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
  // Lead with a short header so the file is recognizable when a user
  // browses the workspace; the body is everything below.
  return `# ${input.agentName}\n\n${body.trim()}\n`;
}

/**
 * Writes the AGENTS.md file to the workspace root. Idempotent —
 * overwrites existing file contents.
 *
 * The `home` argument is the DESK_HOME root (contains `workspaces/desk/`).
 */
export async function writeAgentFile(
  home: string,
  workspaceSlug: string,
  input: AgentFileInput,
): Promise<void> {
  const content = renderAgentFile({ ...input, home, workspaceSlug });
  const filePath = path.join(workspaceRootPath(home, workspaceSlug), "AGENTS.md");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Goals where the agent will likely need to drive a browser. Only chats
 * tagged with one of these get playwright-mcp wired up via the
 * desk-mcp-bridge extension; everything else starts the sandbox without
 * firefox/Xvfb in memory, which is the single largest baseline-resource
 * saving on the sandbox.
 *
 * Conservative on purpose: there is no per-run override yet, so a chat
 * whose goal isn't `site`/`app` simply won't have firefox available. If
 * we accumulate edge cases that need the browser under other goals, the
 * right fix is either (a) re-tag the chat's goal or (b) add a per-
 * workspace `enable_playwright` setting — not a list of every goal that
 * *might* occasionally want it.
 */
const BROWSER_GOALS: ReadonlySet<GoalKey> = new Set(["site", "app", "search"]);

export function chatNeedsBrowser(goal: GoalKey | null | undefined): boolean {
  if (!goal) return false;
  return BROWSER_GOALS.has(goal);
}

/**
 * Writes the per-workspace `.agents/mcp.json` consumed by the
 * desk-mcp-bridge pi extension. Merges with any existing file so users
 * (or future Desk surfaces) can add their own MCP servers without
 * getting wiped on the next chat boot — Desk owns the `playwright`
 * entry, everything else is preserved as-is.
 *
 * The shape mirrors the standard MCP `mcpServers` map (Claude Desktop /
 * pi compatible) so user-added servers slot in without bespoke
 * config. `enabled: false` is emitted explicitly when playwright isn't
 * needed so the extension can DELETE its tools on the next session
 * boot, rather than relying on absence.
 *
 * Returns `{ changed: true }` when the file content actually changed
 * since the previous write — callers use this to skip the lazy-Xvfb
 * startup when nothing toggled.
 */
export async function writeWorkspaceMcpConfig(
  home: string,
  workspaceSlug: string,
  opts: { enablePlaywright: boolean },
): Promise<{ changed: boolean }> {
  const dir = path.join(workspaceRootPath(home, workspaceSlug), ".agents");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, "mcp.json");

  let prev: string | null = null;
  let existing: Record<string, unknown> = {};
  try {
    prev = await fs.readFile(target, "utf-8");
    const parsed: unknown = JSON.parse(prev);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Malformed JSON — the bridge would refuse to load it anyway, so
      // overwriting is the only recovery. The user's entries are lost,
      // but the alternative is a permanently-stuck chat boot.
      console.warn(`[mcp] ${target} is unreadable, resetting to managed config:`, err);
    }
  }

  const prevServers =
    existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {};

  // User override: if the user has hand-edited a playwright entry with
  // `enabled: true`, Desk steps out of the way — keep whatever they
  // wrote and skip the goal-gated managed write. The bridge respects
  // their argv/env. This is the "Lets you opt-in per workspace by
  // hand-editing" path. Side-effect: once playwright has ever been
  // enabled in a workspace (e.g. for a `site`-goal chat that wrote
  // enabled=true), it stays on until the user explicitly disables it.
  const existingPlaywright = prevServers.playwright;
  const userOwnsPlaywright =
    existingPlaywright !== undefined &&
    existingPlaywright !== null &&
    typeof existingPlaywright === "object" &&
    !Array.isArray(existingPlaywright) &&
    (existingPlaywright as { enabled?: unknown }).enabled === true;

  const managedPlaywright = {
    command: "playwright-mcp",
    args: ["--browser", "firefox"],
    enabled: opts.enablePlaywright,
    env: { DISPLAY: ":99" },
  };

  const config = {
    ...existing,
    mcpServers: {
      ...prevServers,
      playwright: userOwnsPlaywright ? existingPlaywright : managedPlaywright,
    },
  };

  const next = JSON.stringify(config, null, 2) + "\n";
  if (prev === next) return { changed: false };
  await fs.writeFile(target, next, "utf-8");
  return { changed: true };
}
