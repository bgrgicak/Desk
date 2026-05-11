import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "desk-agent chat attach-artifact --chat <id> [--name <text>] [--param key=value]... <workspace-relative-path>";

export const help = `\
desk-agent chat attach-artifact — surface a generated artifact in the chat by
creating an artifactRef message.

Required:
  --chat <id>                  The chat where the artifact should appear.
  <workspace-relative-path>    Path to an existing file, usually under
                               .chats/<chatId>/artifacts/.

Optional:
  --name <text>                Display name. Defaults to the file basename.
  --param key=value            Concrete param for a fragment embed. Repeatable.

Examples:
  desk-agent chat attach-artifact --chat cht_abc \\
      .chats/cht_abc/artifacts/report.md

  desk-agent chat attach-artifact --chat cht_abc \\
      --name "Weekly report" \\
      .chats/cht_abc/artifacts/report.md

  desk-agent chat attach-artifact --chat cht_abc \\
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

  if (typeof chatId !== "string" || !chatId) {
    throw new CliError("INVALID_ARGS", "Missing --chat <id>. Usage:\n" + usage);
  }
  const currentChatId = process.env.DESK_CHAT_ID;
  if (currentChatId && chatId !== currentChatId) {
    throw new CliError(
      "WRONG_CHAT",
      `Refusing to attach artifact to ${chatId}; this sandbox run belongs to ${currentChatId}`,
    );
  }
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

  const body: Record<string, unknown> = { chatId, path: artifactPath };
  if (typeof name === "string") body.name = name;
  if (params) body.params = params;

  const result = await postJson("/sandbox/artifacts", body);
  output(result);
}
