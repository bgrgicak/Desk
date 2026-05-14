import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CliError, parseFlags } from "../errors.js";
import { output } from "../index.js";

export const usage =
  "desk-agent app create --chat <id> [--template <path>] <name>";

export const help = `\
desk-agent app create — clone the Desk app scaffold into a new chat-artifact
app directory. The result is a self-contained Vite project with
node_modules/ pre-installed, ready to \`npm run verify\`.

Required:
  --chat <id>          The chat whose artifacts directory should host the app.
  <name>               App name (kebab-case: lowercase letters, digits, dash).

Optional:
  --template <path>    Override the default scaffold source. Defaults to
                       \`/opt/desk-template/app\`. Use only for tests.

The new app is created at:
  ~/.chats/<chatId>/artifacts/<name>.app/

Refuses to clobber an existing directory at that path; pick a different name
or remove the existing one first.

Output (stdout, JSON): { name, path, chatId }
Errors (stderr, JSON): { code, message }`;

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }

  const { flags, positionals } = parseFlags(argv);
  const chatId = flags["chat"];
  const templateOverride = flags["template"];
  const name = positionals.join(" ").trim();

  if (typeof chatId !== "string" || !chatId) {
    throw new CliError("INVALID_ARGS", "Missing --chat <id>. Usage:\n" + usage);
  }
  const currentChatId = process.env.DESK_CHAT_ID;
  if (currentChatId && chatId !== currentChatId) {
    throw new CliError(
      "WRONG_CHAT",
      `Refusing to create app artifacts in ${chatId}; this sandbox run belongs to ${currentChatId}`,
    );
  }
  if (!name) {
    throw new CliError("INVALID_ARGS", "Missing <name>. Usage:\n" + usage);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new CliError(
      "INVALID_ARGS",
      `Invalid app name "${name}". Use lowercase letters, digits, and dashes; ` +
        "must start with a letter and be at most 63 characters.",
    );
  }

  const home = process.env.HOME;
  if (!home) {
    throw new CliError("NO_HOME", "$HOME is not set");
  }

  const templatePath =
    typeof templateOverride === "string" && templateOverride
      ? templateOverride
      : process.env.DESK_APP_TEMPLATE ?? "/opt/desk-template/app";

  await assertDirectory(templatePath, "TEMPLATE_NOT_FOUND");

  // The host creates `~/.chats/<chatId>/artifacts/` when the chat is
  // initialized — its absence means the chat itself doesn't exist (typo
  // in --chat, or the chat was deleted). Asserting the directory rather
  // than `mkdir -p`-ing it surfaces those mistakes loudly.
  const artifactsDir = path.join(home, ".chats", chatId, "artifacts");
  await assertDirectory(artifactsDir, "CHAT_NOT_FOUND");

  const target = path.join(artifactsDir, `${name}.app`);
  if (await pathExists(target)) {
    throw new CliError(
      "ALREADY_EXISTS",
      `Refusing to clobber existing directory: ${target}`,
    );
  }

  try {
    await fs.cp(templatePath, target, { recursive: true });
    await substituteName(target, name);
    await assertNoUnsubstitutedMarkers(target);
  } catch (err) {
    await fs.rm(target, { recursive: true, force: true });
    throw err;
  }

  output({ name, path: target, chatId });
}

async function assertDirectory(p: string, code: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(code, `No scaffold at ${p}`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new CliError(code, `${p} is not a directory`);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function substituteName(appDir: string, name: string): Promise<void> {
  // Files that contain `__APP_NAME__` placeholders. Keep this list narrow —
  // a blanket recursive replace would risk touching node_modules content.
  const targets = ["desk.app.json", "package.json", "README.md"];
  for (const rel of targets) {
    const file = path.join(appDir, rel);
    let contents: string;
    try {
      contents = await fs.readFile(file, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (!contents.includes("__APP_NAME__")) continue;
    await fs.writeFile(file, contents.replaceAll("__APP_NAME__", name), "utf-8");
  }
}

/**
 * Safety net: walk every shipped (non-node_modules, non-.storage) file
 * under the freshly-created app and fail loudly if any `__APP_NAME__`
 * marker survived. Catches a future scaffold file that gets a marker
 * but isn't added to the explicit substitution list above.
 */
async function assertNoUnsubstitutedMarkers(appDir: string): Promise<void> {
  const skipDirs = new Set(["node_modules", ".storage", "dist"]);
  // verify.mjs uses __APP_NAME__ as a literal comparison value to detect
  // whether it is running inside the uncloned scaffold template, not as a
  // substitution placeholder.
  const skipFiles = new Set([path.join(appDir, "scripts", "verify.mjs")]);
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      if (skipFiles.has(filePath)) continue;
      let contents: string;
      try {
        contents = await fs.readFile(filePath, "utf-8");
      } catch {
        continue; // binary or unreadable — assume no markers
      }
      if (contents.includes("__APP_NAME__")) {
        throw new CliError(
          "SCAFFOLD_BUG",
          `Unsubstituted __APP_NAME__ marker in ${path.relative(appDir, filePath)}; ` +
            "add the file to substituteName() in sandbox-cli/src/commands/app-create.ts.",
        );
      }
    }
  }
  await walk(appDir);
}
