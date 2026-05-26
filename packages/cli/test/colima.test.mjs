import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// These system paths are searched by findColima. If any exist on this machine,
// the "returns null" test cannot run without mocking, so skip it.
const SYSTEM_COLIMA_PATHS = [
  "/usr/local/bin/colima",
  "/opt/homebrew/bin/colima",
  "/home/linuxbrew/.linuxbrew/bin/colima",
  "/usr/bin/colima",
];
const colimaInstalledSystemWide = SYSTEM_COLIMA_PATHS.some((p) => fs.existsSync(p));

import {
  findColima,
  isColimaRunning,
  isColimaRunningWithContainerd,
  nerdctlWrapperPath,
  createNerdctlWrapper,
  roomyBinDir,
} from "../src/colima.mjs";

let tmpHome;

beforeAll(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), "roomy-colima-test-"));
});

afterAll(async () => {
  if (tmpHome) await fsp.rm(tmpHome, { recursive: true, force: true });
});

describe("findColima", () => {
  it("returns the path when colima exists in roomyHome/bin", async () => {
    const binDir = path.join(tmpHome, "bin");
    await fsp.mkdir(binDir, { recursive: true });
    const colima = path.join(binDir, "colima");
    await fsp.writeFile(colima, "#!/bin/sh\n", { mode: 0o755 });
    expect(findColima(tmpHome)).toBe(colima);
  });

  it.skipIf(colimaInstalledSystemWide)(
    "returns null when no colima binary exists anywhere",
    () => {
      const emptyHome = path.join(tmpHome, "empty");
      expect(findColima(emptyHome)).toBeNull();
    },
  );
});

describe("isColimaRunning", () => {
  it("returns true when colima status --json reports Running", async () => {
    const fakeColima = path.join(tmpHome, "bin", "colima-running");
    await fsp.writeFile(
      fakeColima,
      '#!/bin/sh\necho \'{"status":"Running","runtime":"containerd"}\'\n',
      { mode: 0o755 },
    );
    expect(isColimaRunning(fakeColima)).toBe(true);
  });

  it("returns false when colima status --json reports Stopped", async () => {
    const fakeColima = path.join(tmpHome, "bin", "colima-stopped");
    await fsp.writeFile(
      fakeColima,
      '#!/bin/sh\necho \'{"status":"Stopped","runtime":"containerd"}\'\n',
      { mode: 0o755 },
    );
    expect(isColimaRunning(fakeColima)).toBe(false);
  });

  it("returns false when colima exits non-zero", async () => {
    const fakeColima = path.join(tmpHome, "bin", "colima-error");
    await fsp.writeFile(
      fakeColima,
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
    expect(isColimaRunning(fakeColima)).toBe(false);
  });
});

describe("isColimaRunningWithContainerd", () => {
  it("returns true when status is Running and runtime is containerd", async () => {
    const fakeColima = path.join(tmpHome, "bin", "colima-containerd");
    await fsp.writeFile(
      fakeColima,
      '#!/bin/sh\necho \'{"status":"Running","runtime":"containerd"}\'\n',
      { mode: 0o755 },
    );
    expect(isColimaRunningWithContainerd(fakeColima)).toBe(true);
  });

  it("returns false when runtime is docker", async () => {
    const fakeColima = path.join(tmpHome, "bin", "colima-docker-rt");
    await fsp.writeFile(
      fakeColima,
      '#!/bin/sh\necho \'{"status":"Running","runtime":"docker"}\'\n',
      { mode: 0o755 },
    );
    expect(isColimaRunningWithContainerd(fakeColima)).toBe(false);
  });

  it("returns false when not running", async () => {
    const fakeColima = path.join(tmpHome, "bin", "colima-not-running");
    await fsp.writeFile(
      fakeColima,
      '#!/bin/sh\necho \'{"status":"Stopped","runtime":"containerd"}\'\n',
      { mode: 0o755 },
    );
    expect(isColimaRunningWithContainerd(fakeColima)).toBe(false);
  });
});

describe("createNerdctlWrapper", () => {
  it("creates an executable shell script that delegates to colima nerdctl --profile roomy", async () => {
    const home = path.join(tmpHome, "wrapper-test");
    await createNerdctlWrapper(home);

    const wrapper = nerdctlWrapperPath(home);
    expect(fs.existsSync(wrapper)).toBe(true);

    const content = await fsp.readFile(wrapper, "utf-8");
    expect(content).toContain("colima nerdctl");
    expect(content).toContain("--profile roomy");
    expect(content).toContain("--");
    expect(content).toContain('"$@"');

    const stat = await fsp.stat(wrapper);
    // Check executable bit for owner
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it("is idempotent — writing twice does not throw", async () => {
    const home = path.join(tmpHome, "wrapper-idempotent");
    await createNerdctlWrapper(home);
    await expect(createNerdctlWrapper(home)).resolves.not.toThrow();
  });
});

describe("roomyBinDir", () => {
  it("returns roomyHome/bin", () => {
    expect(roomyBinDir("/home/user/Roomy")).toBe("/home/user/Roomy/bin");
  });
});
