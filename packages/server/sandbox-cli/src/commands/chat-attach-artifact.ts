import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "roomy-agent chat attach-artifact [--chat <id>] [--name <text>] [--param key=value]... <workspace-relative-path>";

export const help = `\
roomy-agent chat attach-artifact — surface a generated artifact in a chat by
creating an artifactRef message.

By default the artifact is attached to the sandbox run's own chat. Pass
--chat <id> to surface it in a different chat — any chat the agent owns
in the same workspace is acceptable (e.g. a task thread, the source chat
the task was spawned from, or a sibling chat). The file path can point
at any chat's artifacts dir in the same workspace, or a library path.

Optional:
  --chat <id>                  Target chat to surface the artifact in.
                               Defaults to the run's own chat.
  --name <text>                Display name. Defaults to the file basename.
  --param key=value            Concrete param for a fragment embed. Repeatable.

Required:
  <workspace-relative-path>    Path to an existing file. Allowed shapes:
                               - .chats/<anyChatId>/artifacts/<rest>
                                 (in the same workspace as the target chat)
                               - <library/path>

Examples:
  # Attach to the run's own chat
  roomy-agent chat attach-artifact \\
      .chats/cht_abc/artifacts/report.md

  # Cross-chat: agent in chat A surfaces in chat B
  roomy-agent chat attach-artifact --chat cht_B \\
      .chats/cht_A/artifacts/report.md

  roomy-agent chat attach-artifact --chat cht_abc \\
      --name "Weekly report" \\
      library/reports/weekly.md

  roomy-agent chat attach-artifact --chat cht_abc \\
      --param note_id=abc-123 \\
      notes.app/dist/fragments/note-editor

Exit codes:
  0 on success — JSON message row on stdout.
  Non-zero on failure — JSON {code, message} on stderr.`;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }

  const { flags, positionals } = parseFlags(argv, ["param"]);
  const chatId = flags["chat"];
  const name = flags["name"];
  const rawParams = flags["param"];
  const artifactPath = positionals.join(" ");

  if (!artifactPath) {
    throw new CliError("INVALID_ARGS", "Missing artifact path. Usage:\n" + usage);
  }

  let params: Record<string, string> | undefined;
  if (rawParams) {
    params = {};
    for (const entry of Array.isArray(rawParams) ? rawParams : [rawParams]) {
      const eq = entry.indexOf("=");
      if (eq <= 0) throw new CliError("INVALID_ARGS", `Invalid --param "${entry}"; expected key=value`);
      params[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }

  const body: Record<string, unknown> = { path: artifactPath };
  if (typeof chatId === "string" && chatId.length > 0) body.chatId = chatId;
  if (typeof name === "string") body.name = name;
  if (params) body.params = params;

  const result = await postJson("/sandbox/artifacts", body);
  output(result);
}
