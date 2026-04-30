import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  'desk-agent task schedule --chat <id> [--title <text>] [--at <iso8601> | --cron <expr>] [--kind <kind>] <content>';

export const help = `\
desk-agent task schedule — create a task message in a chat. The task can be one
of: scheduled (fires once at --at), recurring (fires on --cron), or manual
(no schedule — sits as a TODO until the user runs it).

Required:
  --chat <id>            The chat the task belongs to.
  <content>              Task body (positional). Becomes the prompt the
                         agent sees when the task fires.

Optional:
  --title <text>         Title shown on the Tasks board / column header.
                         Strongly recommended for non-trivial tasks.
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
                         Other valid kinds (task, ai_note, chat) exist for
                         specialized flows; you almost certainly want the
                         default.

Examples:
  # Recurring weekday standup reminder
  desk-agent task schedule --chat ch_abc \\
      --title "Daily standup" \\
      --cron "0 9 * * 1-5" \\
      "Post the standup template to #team-engineering"

  # One-shot reminder
  desk-agent task schedule --chat ch_abc \\
      --title "Review migration PR" \\
      --at "2026-05-01T15:00:00Z" \\
      "Review the schema migration PR before the merge freeze"

  # Manual task (no schedule) — sits in the user's Tasks board until
  # they run it.
  desk-agent task schedule --chat ch_abc \\
      --title "Summarize Q1 metrics" \\
      "Pull the Q1 numbers from the deck and produce a 1-pager"

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
  const content = positionals.join(" ");
  const at = flags["at"];
  const cron = flags["cron"];
  const title = flags["title"];
  const kind = flags["kind"];

  if (typeof chatId !== "string" || !chatId) {
    throw new CliError("INVALID_ARGS", "Missing --chat <id>. Usage:\n" + usage);
  }
  if (!content) {
    throw new CliError("INVALID_ARGS", "Missing task content. Usage:\n" + usage);
  }
  if (typeof at === "string" && typeof cron === "string") {
    throw new CliError("INVALID_ARGS", "--at and --cron are mutually exclusive");
  }

  const body: Record<string, unknown> = { chatId, content };
  if (typeof title === "string") body.title = title;
  if (typeof at === "string") body.executeAt = at;
  if (typeof cron === "string") body.cron = cron;
  if (typeof kind === "string") body.kind = kind;

  const result = await postJson("/sandbox/messages", body);
  output(result);
}
