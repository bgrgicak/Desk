import { getJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "desk-agent find artifacts [--query <text>] [--kind app|fragment|note|doc|any] [--workspace <slug>|*] [--limit N]";

export const help = `\
desk-agent find artifacts — discover apps, fragments, notes, and docs
in the user's library. Memory-system spec, Section 6.

Use this BEFORE building something new — if a fragment already does
the task, embed it inline instead of writing a one-shot HTML page.

Optional:
  --query <text>           Free-text query against name + description +
                           body. Whitespace-tokenized; every token must
                           match. When omitted, returns the
                           most-recently-modified artifacts in scope.
  --kind app|fragment|note|doc|any
                           Filter by artifact type. Default: any.
  --workspace <slug>|*     Workspace scope. Defaults to the current
                           workspace; pass "*" for cross-workspace.
  --limit N                Default: 25. Capped at 100.

Examples:
  desk-agent find artifacts --query "note editor" --kind fragment
  desk-agent find artifacts --query "todos"
  desk-agent find artifacts --kind app

Output:
  JSON object \`{hits: [...]}\` where each hit has kind, path, name,
  description, workspaceSlug, lastModified, score.

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
  const kind = flags["kind"];
  const workspace = flags["workspace"];
  const limit = flags["limit"];

  if (kind !== undefined && typeof kind === "string") {
    const allowed = new Set(["app", "fragment", "note", "doc", "any"]);
    if (!allowed.has(kind)) {
      throw new CliError("INVALID_ARGS", `--kind must be one of app|fragment|note|doc|any (got "${kind}")`);
    }
  }

  const params = new URLSearchParams();
  if (typeof query === "string" && query.trim()) params.set("q", query);
  if (typeof kind === "string" && kind) params.set("kind", kind);
  if (typeof workspace === "string" && workspace) params.set("workspace", workspace);
  if (typeof limit === "string" && limit) params.set("limit", limit);

  const qs = params.toString();
  const result = await getJson(`/sandbox/find/artifacts${qs ? `?${qs}` : ""}`);
  output(result);
}
