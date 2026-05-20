import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "desk-agent task reschedule --chat <id> --message-id <msg> (--at <iso8601> | --cron <expr>) [--title <text>] [<content>]";

export const help = `\
desk-agent task reschedule — change an existing task's schedule in place.
Use this when the user asks to move, delay, bring forward, or otherwise
modify the time of an existing scheduled or recurring task. The task row
is updated in place (same id, same created_at, state reset to pending),
so no phantom card appears on the Tasks board.

Required:
  --chat <id>            Chat containing the task message.
  --message-id <msg>     ID of the task message to reschedule.
  --at <iso8601>         New one-shot fire time. Mutually exclusive with
                         --cron. Example: "2026-05-01T15:00:00Z".
  --cron <expr>          New recurring schedule. Mutually exclusive with
                         --at. Example: "0 9 * * 1-5".

Optional:
  --title <text>         New title for the task.
  <content>              New task body (positional). Replaces the current
                         body when supplied.

Use desk-agent task schedule for a *new* task card, and desk-agent task
cancel to stop a task entirely. Reschedule never creates a second row;
if you don't have a message id to target, you want one of those instead.

Examples:
  # Move a one-shot task to a new time.
  desk-agent task reschedule --chat ch_abc \\
      --message-id msg_123 \\
      --at "2026-05-02T15:00:00Z"

  # Convert a one-shot reminder into a daily recurring task.
  desk-agent task reschedule --chat ch_abc \\
      --message-id msg_123 \\
      --cron "0 9 * * *"

  # Reschedule and refresh the body in one call.
  desk-agent task reschedule --chat ch_abc \\
      --message-id msg_123 \\
      --at "2026-05-03T09:00:00Z" \\
      --title "Weekly review" \\
      "Pull this week's numbers and post them."

Exit codes:
  0 on success — JSON message row on stdout.
  Non-zero on failure — JSON {code, message} on stderr.`;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }

  const { flags, positionals } = parseFlags(argv);
  const chatId = flags["chat"];
  const messageId = flags["message-id"];
  const at = flags["at"];
  const cron = flags["cron"];
  const title = flags["title"];
  const content = positionals.join(" ");

  if (typeof chatId !== "string" || !chatId) {
    throw new CliError("INVALID_ARGS", "Missing --chat <id>. Usage:\n" + usage);
  }
  if (typeof messageId !== "string" || !messageId) {
    throw new CliError("INVALID_ARGS", "Missing --message-id <msg>. Usage:\n" + usage);
  }
  if (typeof at === "string" && typeof cron === "string") {
    throw new CliError("INVALID_ARGS", "--at and --cron are mutually exclusive");
  }
  if (typeof at !== "string" && typeof cron !== "string") {
    throw new CliError(
      "INVALID_ARGS",
      "Reschedule requires --at or --cron. Use 'task cancel' to stop a task entirely.",
    );
  }

  const body: Record<string, unknown> = { chatId, messageId };
  if (typeof at === "string") body.executeAt = at;
  if (typeof cron === "string") body.cron = cron;
  if (typeof title === "string") body.title = title;
  if (content) body.content = content;

  const result = await postJson("/sandbox/messages/reschedule", body);
  output(result);
}
