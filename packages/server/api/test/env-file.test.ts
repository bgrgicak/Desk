import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureVaultPasswordEnv } from "../src/envFile.js";

describe("ensureVaultPasswordEnv", () => {
  it("writes DESK_VAULT_PASSWORD into the env file when missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-env-"));
    const envFile = path.join(dir, ".env");
    const env: NodeJS.ProcessEnv = {};

    const password = await ensureVaultPasswordEnv({ deskHome: dir, env, envFile });

    expect(password).toBeTruthy();
    expect(env.DESK_VAULT_PASSWORD).toBe(password);
    const body = await fs.readFile(envFile, "utf-8");
    expect(body).toContain(`DESK_VAULT_PASSWORD=${password}\n`);

    const stat = await fs.stat(envFile);
    expect(stat.mode & 0o777).toBe(0o600);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loads an existing DESK_VAULT_PASSWORD without rewriting the file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-env-"));
    const envFile = path.join(dir, ".env");
    const original = "OTHER=value\nDESK_VAULT_PASSWORD='existing-secret'\n";
    await fs.writeFile(envFile, original, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};

    await expect(ensureVaultPasswordEnv({ deskHome: dir, env, envFile })).resolves.toBe("existing-secret");
    expect(env.DESK_VAULT_PASSWORD).toBe("existing-secret");
    await expect(fs.readFile(envFile, "utf-8")).resolves.toBe(original);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
