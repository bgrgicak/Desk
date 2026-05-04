import { postJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "desk-agent chat attach-artifact --chat <id> [--name <text>] <workspace-relative-path>";

export const help = `\
desk-agent chat attach-artifact — surface a generated artifact in the chat by
creating an artifactRef message.

Required:
  --chat <id>                  The chat where the artifact should appear.
  <workspace-relative-path>    Path to an existing file, usually under
                               .chats/<chatId>/artifacts/.

Optional:
  --name <text>                Display name. Defaults to the file basename.

Examples:
  desk-agent chat attach-artifact --chat cht_abc \\
      .chats/cht_abc/artifacts/report.md

  desk-agent chat attach-artifact --chat cht_abc \\
      --name "Weekly report" \\
      .chats/cht_abc/artifacts/report.md

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
  const name = flags["name"];
  const artifactPath = positionals.join(" ");

  if (typeof chatId !== "string" || !chatId) {
    throw new CliError("INVALID_ARGS", "Missing --chat <id>. Usage:\n" + usage);
  }
  if (!artifactPath) {
    throw new CliError("INVALID_ARGS", "Missing artifact path. Usage:\n" + usage);
  }

  const body: Record<string, unknown> = { chatId, path: artifactPath };
  if (typeof name === "string") body.name = name;

  const result = await postJson("/sandbox/artifacts", body);
  output(result);
}
