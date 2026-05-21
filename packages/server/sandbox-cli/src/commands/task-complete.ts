import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage = "desk-agent task complete --chat <thread-chat-id> [--message <text>]";

export const help = `\
desk-agent task complete — mark a sub-task done and (optionally) deliver a
result message back to the parent thread.

This is the "I'm finished with this side job, here's how it went" verb. The
agent calls it from inside its own task thread; the server finds the task
anchor in the parent chat via the thread link, flips it to 'succeeded',
and (when --message is given) posts that message in the parent chat
attributed to this agent.

Required:
  --chat <id>            The agent's current chat (the sub-task thread).
                         The server resolves the anchor in the parent chat
                         from this — you don't have to pass anchor ids.

Optional:
  --message <text>       Short outcome to post back to the parent chat —
                         what you accomplished, key findings, links. Goes
                         in the parent transcript next to the task anchor
                         so the user / main-thread agent sees it without
                         opening this thread. Keep it succinct; don't
                         paste the whole transcript.

Recurring tasks (--cron) cannot be completed — they're meant to keep
firing. Use \`desk-agent task cancel\` to stop them entirely.

Already-terminal tasks (succeeded/cancelled/failed) cannot be completed
again — the call returns 400.

Examples:
  # Bare completion (no report-back)
  desk-agent task complete --chat ch_thread_xyz

  # Completion with a parent-thread report
  desk-agent task complete --chat ch_thread_xyz \\
      --message "Audited 12 PRs. 3 need follow-up: #145, #161, #163."

Exit codes:
  0 on success — JSON { task, report?, parentChatId } on stdout (the
    updated task anchor; the report message if --message was passed;
    the parent chat id where the report landed).
  Non-zero on failure — JSON {code, message} on stderr.`;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }

  const { flags, positionals } = parseFlags(argv, [], []);
  const chatId = flags["chat"];
  const message = flags["message"];

  if (typeof chatId !== "string" || !chatId) {
    throw new CliError("INVALID_ARGS", "Missing --chat <id>. Usage:\n" + usage);
  }
  if (positionals.length > 0) {
    throw new CliError(
      "INVALID_ARGS",
      "Unexpected positional arguments — pass the outcome via --message. Usage:\n" + usage,
    );
  }

  const body: Record<string, unknown> = { chatId };
  if (typeof message === "string" && message.trim().length > 0) {
    body.message = message;
  }

  const result = await postJson("/sandbox/messages/complete", body);
  output(result);
}
