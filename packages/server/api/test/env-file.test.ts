import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveVaultPasswordEnv } from "../src/envFile.js";

describe("resolveVaultPasswordEnv", () => {
  it("returns null when neither process env nor .env has ROOMY_VAULT_PASSWORD", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-env-"));
    const envFile = path.join(dir, ".env");
    const env: NodeJS.ProcessEnv = {};

    const password = await resolveVaultPasswordEnv({ roomyHome: dir, env, envFile });

    expect(password).toBeNull();
    expect(env.ROOMY_VAULT_PASSWORD).toBeUndefined();
    // Must NOT have created or modified the env file — auto-generating
    // a master would defeat the encrypted vault by storing the secret
    // in plaintext.
    await expect(fs.access(envFile)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loads an existing ROOMY_VAULT_PASSWORD without rewriting the file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-env-"));
    const envFile = path.join(dir, ".env");
    const original = "OTHER=value\nROOMY_VAULT_PASSWORD='existing-secret'\n";
    await fs.writeFile(envFile, original, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};

    await expect(resolveVaultPasswordEnv({ roomyHome: dir, env, envFile })).resolves.toBe("existing-secret");
    expect(env.ROOMY_VAULT_PASSWORD).toBe("existing-secret");
    await expect(fs.readFile(envFile, "utf-8")).resolves.toBe(original);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("prefers process.env over the .env file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roomy-env-"));
    const envFile = path.join(dir, ".env");
    await fs.writeFile(envFile, "ROOMY_VAULT_PASSWORD=file-value\n", { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { ROOMY_VAULT_PASSWORD: "env-value" };

    await expect(resolveVaultPasswordEnv({ roomyHome: dir, env, envFile })).resolves.toBe("env-value");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
