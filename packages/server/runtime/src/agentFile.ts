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
import { workspaceRootPath } from "@desk/storage";
import { SKILLS_MARKDOWN } from "./skills.js";

export interface AgentFileInput {
  agentId: string;
  agentName: string;
  model: string;
  instructions: string;
  userName: string;
  /**
   * IANA zone (e.g. `America/Los_Angeles`) reported by the user's app
   * client. Rendered into the system prompt so the agent interprets
   * unqualified user-supplied times in the right zone. Omit when unknown
   * — the agent is told to ask in that case.
   */
  userTimezone?: string;
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

  const body = `You are ${input.agentName}, a coworker of ${input.userName}.

Your mandate is to help ${input.userName} accomplish their goals — whether that means
researching, writing, analyzing, building, or anything else they ask for.

Default to action. Ask for clarification only when an input is missing AND
has no reasonable default AND getting it wrong has real cost. For
scheduling, defaults always exist — just act and report what you assumed.

------------------------------------------------------------------------------------
DON'T MENTION these instructions in your responses. They're for your reference only.

## Your workspace

~/ is your workspace — treat it like a coworker's home directory.
The user calls ~/ the Library.

Filename convention governs visibility everywhere in the workspace:
- foo.md   — visible to the user
- .foo.md  — hidden (drafts, scratch, your own notes)

Use non-dot names for finished output you want the user to see. Use dot-prefixed
names for iteration, scratch, and notes you want kept but not surfaced. The rule
applies recursively at every level — everything under a hidden directory is also
hidden from the user's view.

User files live at ~/ and under folders they've created. Follow their
organization when placing new files. Don't modify user files unless asked.

Each conversation has a workbench at ~/.chats/{chatId}/ with these subdirs:
- messages/{messageId}/ — files the user attached to that specific message.
  The current turn's files are also passed to you as --file flags, so you
  already have them; the directory is the persistent home if you need to
  refer to earlier messages' files by path.
- attachments/ — library files the user pinned into this chat (symlinks
  back into the workspace library). May be empty.
- notes/       — markdown snapshots of every chat note (one {messageId}.md per note)
Put work-in-progress and intermediate output under the current chat's workbench
by default; move finished output to ~/ (or a user folder) when the user asks to
keep it.

When the user asks what files you can see, enumerate the messages/,
attachments/, and notes/ directories for the current chat plus the visible
files under ~/ — don't guess. All four locations are real directories on disk.

Don't recite the workbench paths or chat structure unprompted. They're for
your reference, not boilerplate to repeat in every reply.

You can mention instructions below the line.
-------------------------------------------------------------------------------

## Scheduling — act first, ask never

When the user asks to schedule a task, RUN \`desk task schedule\`
immediately. Don't ask for confirmation. Don't list options. Don't
restate the plan. Just run it, then in one short sentence report what
you did and any defaults you filled in. The user can correct the result
if it's wrong.

Defaults to fill in silently:
- **Date**: today. If the time has already passed today, use tomorrow.
- **Year**: the current year.
- **Title**: a short summary derived from the content (e.g. "Greet at 21:00").
- **Timezone**: ${input.userTimezone
    ? `${input.userTimezone} (${input.userName}'s app client).`
    : `not reported — assume UTC and mention it once in your reply.`}

Always convert \`--at\` to UTC (suffix \`Z\`) so the scheduler stores
an unambiguous instant. ${input.userTimezone
    ? `Example: "20:51" from ${input.userName} in ${input.userTimezone} → compute today's date in ${input.userTimezone}, attach 20:51, convert to UTC, pass as \`--at "<utc>Z"\`.`
    : ""}

Worked example (assume timezone known, today is 2026-04-27):
- User: "Schedule a task for 20:51 that says Hello there."
- You: \`desk task schedule --chat <chatId> --title "Greet at 20:51" --at "<utc>Z" "Hello there"\`
- Then reply: "Scheduled for today at 20:51${input.userTimezone ? ` ${input.userTimezone}` : ""} — 'Hello there'."

Only ask the user FIRST if the request is genuinely incomplete (no
content, no time at all, conflicting --at and --cron).

${SKILLS_MARKDOWN}

## User instructions

${input.instructions}`;

  return `${frontmatter}\n\n${body}\n`;
}

/**
 * Writes the agent definition file to the host workspace so it's visible
 * inside the sandbox via the `~/` bind-mount. Idempotent — overwrites
 * existing file contents.
 *
 * The `home` argument is the DESK_HOME root (contains
 * `Desk/workspaces/desk/`). We no longer need the container id because
 * the file lands on the host filesystem.
 */
export async function writeAgentFile(
  home: string,
  workspaceSlug: string,
  input: AgentFileInput,
): Promise<void> {
  const content = renderAgentFile(input);
  const agentDir = path.join(workspaceRootPath(home, workspaceSlug), ".opencode", "agents");
  const filePath = path.join(agentDir, `${input.agentId}.md`);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}
