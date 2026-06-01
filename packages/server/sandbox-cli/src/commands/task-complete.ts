import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "roomy-agent task complete [(--chat <thread-chat-id> | --message-id <anchor-id>)] [--message <text>]";

export const help = `\
roomy-agent task complete — mark a task done and (optionally) deliver a
result message back to the parent thread.

This is the "I'm finished, here's how it went" verb. The server flips the
task anchor to 'succeeded' and (when --message is given) posts that
message in the parent chat attributed to this agent.

Identify the task with exactly one of:
  no id                  From inside a task run, the server infers the current
                         task from the sandbox session.
  --chat <id>            The agent's current chat, when it IS the task's
                         dedicated thread. The server walks back to the
                         anchor in the parent chat via the thread link.
  --message-id <id>      The task anchor's message id. Use this when the
                         agent isn't inside the thread chat — e.g. it's
                         completing a task from the source chat or from
                         an unrelated interactive run that has the anchor
                         id in context.

Optional:
  --message <text>       Short outcome to post back to the parent chat —
                         what you accomplished, key findings, links. Goes
                         in the parent transcript next to the task anchor
                         so the user / main-thread agent sees it without
                         opening this thread. Keep it succinct; don't
                         paste the whole transcript.

Recurring tasks (--cron) cannot be completed — they're meant to keep
firing. Use \`roomy-agent task cancel\` to stop them entirely.

Already-terminal tasks (succeeded/cancelled/failed) cannot be completed
again — the call returns 400.

Examples:
  # From inside the task's thread chat
  roomy-agent task complete --chat ch_thread_xyz

  # From anywhere, when you have the anchor id
  roomy-agent task complete --message-id msg_anchor_abc \\
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
  const messageId = flags["message-id"];
  const message = flags["message"];

  const hasChat = typeof chatId === "string" && chatId.length > 0;
  const hasMessageId = typeof messageId === "string" && messageId.length > 0;
  if (hasChat && hasMessageId) {
    throw new CliError(
      "INVALID_ARGS",
      "Pass --chat or --message-id, not both. Usage:\n" + usage,
    );
  }
  if (positionals.length > 0) {
    throw new CliError(
      "INVALID_ARGS",
      "Unexpected positional arguments — pass the outcome via --message. Usage:\n" + usage,
    );
  }

  const body: Record<string, unknown> = hasMessageId
    ? { messageId }
    : { chatId };
  if (typeof message === "string" && message.trim().length > 0) {
    body.message = message;
  }

  const result = await postJson("/sandbox/messages/complete", body);
  output(result);
}
