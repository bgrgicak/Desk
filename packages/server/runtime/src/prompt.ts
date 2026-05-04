import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type GoalKey } from "@agent-desk/shared";

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
  instructions: string;
  userTimezone?: string;
  chatId?: string;
  goal?: GoalKey | null;
  runMode?: "chat" | "summary";
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
    const chatPaths = input.chatId
      ? `\nChat artifacts:   ~/.chats/${input.chatId}/artifacts/\n` +
        `Chat attachments: ~/.chats/${input.chatId}/attachments/\n` +
        `Chat summaries:   ~/.chats/${input.chatId}/notes/\n`
      : "";
    const attachArtifactInstruction = input.chatId
      ? `**Surface in chat.** After writing a new artifact or making a significant update, run \`desk-agent chat attach-artifact --chat ${input.chatId} "<workspace-relative-path>"\` with the path set to the file's workspace-relative path (strip the leading \`~/\`, so \`~/.chats/…/foo.html\` becomes \`.chats/…/foo.html\`). Quote the path. Do the same when the user asks to see or open an artifact. Load \`desk-cli-chat-attach-artifact\` if you need syntax details or examples. Skip for minor edits that don't change what the user sees.`
      : "";
    return loadAndSub("artifacts.md", { chatPaths, attachArtifactInstruction });
  },
  (input) => input.runMode === "summary" ? null : loadAndSub("context.md", {}),
  (input) =>
    input.runMode === "summary"
      ? null
      : input.userTimezone
      ? loadAndSub("scheduling-tz-known.md", {
          userName: input.userName,
          userTimezone: input.userTimezone,
        })
      : loadAndSub("scheduling-tz-unknown.md", {}),
  (input) => input.runMode === "summary" ? null : loadAndSub("goal-autodetect.md", {}),
  (input) =>
    input.runMode !== "summary" && input.goal ? loadAndSub(`goal/${input.goal}.md`, {}) : null,
  (input) => input.runMode === "summary" ? null : loadAndSub("desk-skills.md", {}),
  (input) =>
    loadAndSub("user-instructions.md", {
      userName: input.userName,
      instructions: input.instructions || "(none)",
    }),
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
