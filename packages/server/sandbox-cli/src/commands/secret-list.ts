import { getJson } from "../client.js";
import { output } from "../index.js";

export const usage = "desk-agent secret list";

export const help = `\
desk-agent secret list — list the user's secrets vault entries.

Returns metadata only (titles, usernames, urls). To read a secret's
plaintext password use \`desk-agent secret get <title>\`.

If the vault is locked, the command exits with code VAULT_LOCKED. Ask
the user to unlock the vault before trying again.

Output:
  JSON object {"secrets": [{ title, username?, url?, hasNotes, fieldNames }]}.

Exit codes:
  0 on success.
  Non-zero on failure (NO_TOKEN, NO_ENDPOINT, VAULT_LOCKED, ...).`;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }
  const result = await getJson("/sandbox/secrets");
  output(result);
}
