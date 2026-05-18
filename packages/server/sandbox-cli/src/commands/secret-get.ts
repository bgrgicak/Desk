import { getJson } from "../client.js";
import { CliError } from "../errors.js";
import { output } from "../index.js";

export const usage = "desk-agent secret get <title>";

export const help = `\
desk-agent secret get — read the full plaintext entry for a stored secret
by title.

Returns the entry's password and any other fields the user filled in
(username, url, notes, custom fields). Use this at the moment of need
— do not echo or log the result.

If the vault is locked, the command exits with code VAULT_LOCKED. Ask
the user to unlock the vault before trying again.

Output:
  JSON object {"title", "password", "username"?, "url"?, "notes"?, "fields"?}.

Exit codes:
  0 on success.
  Non-zero on failure:
    NOT_FOUND      — no secret with that title.
    VAULT_LOCKED   — user must unlock the vault first.
    UNAUTHORIZED   — sandbox token is missing or revoked.`;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }
  const title = argv[0];
  if (!title) {
    throw new CliError("INVALID_ARGS", "Missing <title>. Usage:\n" + usage);
  }
  const result = await getJson(`/sandbox/secrets/${encodeURIComponent(title)}`);
  output(result);
}
