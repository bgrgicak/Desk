import { getJson } from "../client.js";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "desk-agent find artifacts [--query <text>] [--kind app|fragment|note|doc|any] [--workspace <slug>|*] [--limit N]";

export const help = `\
desk-agent find artifacts — discover reusable apps, fragments, notes, and docs.

Optional:
  --query <text>           Free-text query. When omitted, returns recent hits.
  --kind app|fragment|note|doc|any
                           Filter by artifact type. Default: any.
  --workspace <slug>|*     Defaults to the current workspace; pass "*" for
                           all workspaces owned by the user.
  --limit N                Default: 25. Capped at 100.

Output:
  JSON object {hits: [...]} where app/fragment hits may include params_schema.`;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }

  const { flags } = parseFlags(argv);
  const kind = flags["kind"];
  if (typeof kind === "string" && !["app", "fragment", "note", "doc", "any"].includes(kind)) {
    throw new CliError("INVALID_ARGS", `--kind must be one of app|fragment|note|doc|any (got "${kind}")`);
  }

  const params = new URLSearchParams();
  if (typeof flags["query"] === "string" && flags["query"].trim()) params.set("q", flags["query"]);
  if (typeof kind === "string" && kind) params.set("kind", kind);
  if (typeof flags["workspace"] === "string" && flags["workspace"]) params.set("workspace", flags["workspace"]);
  if (typeof flags["limit"] === "string" && flags["limit"]) params.set("limit", flags["limit"]);

  const qs = params.toString();
  output(await getJson(`/sandbox/find/artifacts${qs ? `?${qs}` : ""}`));
}
