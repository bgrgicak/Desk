import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  'roomy-agent task schedule (--chat <id> | --parent-task <message-id>) [--title <text>] [--at <iso8601> | --cron <expr>] [--kind <kind>] [--attach <path> ...] <content>';

export const help = `\
roomy-agent task schedule — create a task message. By default the task
starts running immediately in its own thread; pass --at or --cron only
when the user explicitly wants the work deferred to a future time.
The three shapes are: unscheduled (default, runs now), scheduled
(fires once at --at), and recurring (fires on --cron).

Tasks are *threads of the source chat*. The task message (containing the
full content you pass) is posted in --chat as the thread anchor. The
server auto-creates a dedicated thread chat anchored to it — every
task_run (and any user follow-up) lands in that thread chat, never back
in the source. The response includes the new thread chat under
\`threadChat\` alongside the anchor under \`message\`.

Auto-start: an unscheduled task is the default and starts running
immediately — the server inserts the first task_run row before this
command returns, so the response carries it under \`run\` and the
Tasks board renders the card as Active right away. The user does
not have to click "Run" first. Only pass --at or --cron when the
user has asked for a specific later/repeating time; the scheduler
picks scheduled and recurring tasks up when their fire time is due.

Required:
  --chat <id>            The source chat. The task message is posted
                         here as the thread anchor; a fresh thread chat
                         is created for the task's runs and replies.
                         Required — agents cannot create chatless tasks.
                         (Only the user, via the Tasks page composer,
                         can spawn a standalone task without anchoring
                         it to a parent conversation.)
  --parent-task <id>     Parent task anchor. The new task is created as a
                         child of that task and appears in the parent task
                         thread. May be used instead of --chat.
  <content>              Task body (positional). MUST include everything
                         the agent needs to act when the task fires —
                         the goal, required context, success criteria.
                         Becomes the first thread message the user sees.

Optional:
  --title <text>         Title shown on the Tasks board / column header.
                         Strongly recommended for non-trivial tasks.
  --attach <path>        Attach a relevant workspace-relative file or directory
                         reference to the task message. May be repeated.
  --at <iso8601>         One-shot schedule. Examples: "2026-05-01T09:00:00Z",
                         "2026-05-01T09:00:00-07:00". Mutually exclusive
                         with --cron.
  --cron <expr>          Recurring schedule, classic 5-field crontab
                         (minute hour dom month dow). Examples:
                           "0 9 * * 1-5"   weekdays at 09:00
                           "*/15 * * * *"  every 15 minutes
                           "0 0 1 * *"     midnight on the 1st of each month
                         Mutually exclusive with --at.
  --kind <kind>          Override the message kind. Defaults to "task".
                         Other valid kinds (task, summary, chat) exist for
                         specialized flows; you almost certainly want the
                         default.

Examples:
  # Recurring weekday standup reminder
  roomy-agent task schedule --chat ch_abc \\
      --title "Daily standup" \\
      --cron "0 9 * * 1-5" \\
      "Post the standup template to #team-engineering"

  # One-shot reminder
  roomy-agent task schedule --chat ch_abc \\
      --title "Review migration PR" \\
      --at "2026-05-01T15:00:00Z" \\
      "Review the schema migration PR before the merge freeze"

  # Unscheduled task — starts running immediately in its own thread.
  # No --at / --cron means "go do this now"; the server fires the task
  # as soon as the anchor and thread are in place.
  roomy-agent task schedule --chat ch_abc \\
      --title "Summarize Q1 metrics" \\
      "Pull the Q1 numbers from the deck and produce a 1-pager"

  # Task with relevant context attached from the source chat.
  roomy-agent task schedule --chat ch_abc \\
      --title "Investigate blank replies" \\
      --attach ".chats/ch_abc/artifacts/report.md" \\
      "Use the attached report and fix the blank-reply issue"

Exit codes:
  0 on success — JSON \`{ message, threadChat, parentChatId, run? }\` on
    stdout (the anchor message in the source chat, the dedicated thread
    chat the task's runs land in, and — for unscheduled tasks — the
    first task_run row in \`running\` state).
  Non-zero on failure — JSON {code, message} on stderr.`;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }

  const { flags, positionals } = parseFlags(argv, ["attach"], []);
  const chatId = flags["chat"];
  const content = positionals.join(" ");
  const at = flags["at"];
  const cron = flags["cron"];
  const title = flags["title"];
  const kind = flags["kind"];
  const parentTaskId = flags["parent-task"];
  const attachFlag = flags["attach"];

  if ((typeof chatId !== "string" || !chatId) && (typeof parentTaskId !== "string" || !parentTaskId)) {
    throw new CliError("INVALID_ARGS", "Missing --chat or --parent-task. Usage:\n" + usage);
  }
  if (!content) {
    throw new CliError("INVALID_ARGS", "Missing task content. Usage:\n" + usage);
  }
  if (typeof at === "string" && typeof cron === "string") {
    throw new CliError("INVALID_ARGS", "--at and --cron are mutually exclusive");
  }

  const body: Record<string, unknown> = { chatId, content };
  if (typeof parentTaskId === "string") body.parentTaskId = parentTaskId;
  if (typeof chatId !== "string" || !chatId) delete body.chatId;
  if (typeof title === "string") body.title = title;
  if (typeof at === "string") body.executeAt = at;
  if (typeof cron === "string") body.cron = cron;
  if (typeof kind === "string") body.kind = kind;
  if (Array.isArray(attachFlag)) {
    body.attachments = attachFlag.map((p) => ({ path: p, name: p.split("/").filter(Boolean).at(-1) ?? p }));
  } else if (typeof attachFlag === "string") {
    body.attachments = [{ path: attachFlag, name: attachFlag.split("/").filter(Boolean).at(-1) ?? attachFlag }];
  }

  const result = await postJson("/sandbox/messages", body);
  output(result);
}
