import { getJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "roomy-agent chat search-messages --query <text> [--chat <id>] [--workspace <current-slug>] [--kind any|message|summary] [--limit N]";

export const help = `\
roomy-agent chat search-messages — full-text search over the user's chat
history (messages + chat summaries). Memory-system spec, Section 3.

Required:
  --query <text>           Free-text query. Whitespace-tokenized; every
                           token must appear in the indexed body.

Optional:
  --chat <id>              Restrict to a single chat (in-chat recall).
  --workspace <current-slug>
                           Optional assertion for the current workspace.
                           Recall is scoped to the sandbox session workspace;
                           cross-workspace recall is not available.
  --kind any|message|summary
                           Default: any. "summary" hits compress-then
                           -recall context; "message" hits return raw
                           transcript lines.
  --limit N                Default: 25. Capped at 100.

Examples:
  roomy-agent chat search-messages --query "kanban board"
  roomy-agent chat search-messages --query "deploy notes" --kind summary
  roomy-agent chat search-messages --query "passwords"

Output:
  JSON object {hits: [...]} where each hit has chatId, messageId,
  workspaceSlug, kind, snippet (with <mark>…</mark> highlights),
  createdAt, score.

Exit codes:
  0 on success.
  Non-zero on failure — JSON {code, message} on stderr.`;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }

  const { flags } = parseFlags(argv);
  const query = flags["query"];
  if (typeof query !== "string" || !query.trim()) {
    throw new CliError("INVALID_ARGS", "Missing --query <text>. Usage:\n" + usage);
  }

  const params = new URLSearchParams({ q: query });
  if (typeof flags["chat"] === "string") params.set("chat", flags["chat"]);
  if (typeof flags["workspace"] === "string") params.set("workspace", flags["workspace"]);
  if (typeof flags["kind"] === "string") params.set("kind", flags["kind"]);
  if (typeof flags["limit"] === "string") params.set("limit", flags["limit"]);

  const result = await getJson(`/sandbox/search/messages?${params.toString()}`);
  output(result);
}
