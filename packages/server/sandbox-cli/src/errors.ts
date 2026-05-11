export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function formatError(err: unknown): { code: string; message: string } {
  if (err instanceof CliError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: "UNKNOWN", message: err.message };
  }
  return { code: "UNKNOWN", message: String(err) };
}

export function writeErrorAndExit(err: unknown): never {
  process.stderr.write(JSON.stringify(formatError(err)) + "\n");
  process.exit(1);
}

/**
 * Minimal flag parser. Supports `--key value`, `--key=value`, and positional args.
 * Repeatable flags (like `--header`) accumulate into arrays.
 */
export function parseFlags(
  argv: string[],
  repeatableKeys?: string[],
): { flags: Record<string, string | string[]>; positionals: string[] };
export function parseFlags(
  argv: string[],
  repeatableKeys: string[] | undefined,
  booleanKeys: string[],
): { flags: Record<string, string | string[] | boolean>; positionals: string[] };
export function parseFlags(
  argv: string[],
  repeatableKeys: string[] = [],
  booleanKeys: string[] = [],
): { flags: Record<string, string | string[] | boolean>; positionals: string[] } {
  const flags: Record<string, string | string[] | boolean> = {};
  const positionals: string[] = [];
  const repeatSet = new Set(repeatableKeys);
  const booleanSet = new Set(booleanKeys);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      let key: string;
      let value: string;
      if (eqIdx !== -1) {
        key = arg.slice(2, eqIdx);
        value = arg.slice(eqIdx + 1);
      } else {
        key = arg.slice(2);
        if (booleanSet.has(key)) {
          flags[key] = true;
          i++;
          continue;
        }
        i++;
        if (i >= argv.length) {
          throw new CliError("INVALID_ARGS", `Missing value for --${key}`);
        }
        value = argv[i];
      }
      if (repeatSet.has(key)) {
        const existing = flags[key];
        if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          flags[key] = [value];
        }
      } else {
        flags[key] = value;
      }
    } else {
      positionals.push(arg);
    }
    i++;
  }

  return { flags, positionals };
}
