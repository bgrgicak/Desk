/**
 * Integration tests for the sandbox lifecycle.
 *
 * Requires a working container engine (docker or nerdctl) and the
 * `desk/sandbox:v1` image present locally — auto-detected and skipped
 * otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureLayout,
  ensureWorkspaceLayout,
  workspaceRootPath,
} from "@agent-desk/storage";
import {
  createOrReuse,
  stopSandbox,
  ensureImage,
  sandboxImage,
  sandboxUser,
  reapStaleSandboxTrees,
} from "../../src/docker.js";
import { execInSandbox } from "../../src/sandboxExec.js";
import { projectMounts, teardownMounts, SANDBOX_HOME } from "../../src/mounts.js";
import { detectEngine, type Engine } from "../../src/engine.js";
import { rmTempTree } from "./helpers.js";

let engineForSetup: Engine | null = null;
let SKIP = false;
try {
  engineForSetup = await detectEngine();
  const haveImage = (await engineForSetup.imageId(sandboxImage())) !== null;
  if (!haveImage) SKIP = true;
} catch {
  SKIP = true;
}
const describeIf = SKIP ? describe.skip : describe;

let home: string;
const testWorkspaceId = "wks_int_sandbox_test";
const testWorkspaceSlug = "int-sandbox-test";
const containerName = `desk-sandbox-${testWorkspaceId}`;

beforeAll(async () => {
  if (SKIP) return;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-sandbox-int-"));
  await ensureLayout(home);
  await ensureWorkspaceLayout(home, testWorkspaceSlug);
  process.env.DESK_HOME = home;
});

afterAll(async () => {
  if (SKIP) return;
  if (engineForSetup) {
    await engineForSetup.remove(containerName, true).catch(() => {});
  }
  await rmTempTree(home);
});

describeIf("sandbox integration", () => {
  it("ensureImage does not throw", async () => {
    await ensureImage();
  });

  it("createOrReuse creates a container and returns a handle", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    expect(handle.workspaceId).toBe(testWorkspaceId);
    expect(handle.containerId).toBeTruthy();

    const engine = await detectEngine();
    const info = await engine.inspect(handle.containerId);
    // The resource-profile label is a stable runtime-feature tag, not a
    // size descriptor. Size is set at first create only — see the comment
    // on SANDBOX_RUNTIME_TAG in docker.ts for why size is deliberately
    // excluded from the drift check.
    expect(info?.labels["agent-desk.sandbox-resource-profile"]).toBe(
      "runtime=tini-v1,user=root+sudo",
    );
  });

  it("createOrReuse is idempotent — second call returns same container", async () => {
    const h1 = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const h2 = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    expect(h1.containerId).toBe(h2.containerId);
  });

  it("replays .deskrc on container restart", async () => {
    const workspace = workspaceRootPath(home, testWorkspaceSlug);
    const sentinel = `/tmp/deskrc-restart-${Date.now()}`;
    await fs.writeFile(path.join(workspace, ".deskrc"), `touch ${sentinel}\n`, "utf8");

    const first = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const engine = await detectEngine();
    await engine.stop(first.containerId, 10);

    const second = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    expect(second.containerId).toBe(first.containerId);

    const result = await execInSandbox(testWorkspaceId, testWorkspaceSlug, {
      argv: ["test", "-f", sentinel],
    });
    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("continues startup when .deskrc exits non-zero", async () => {
    const workspace = workspaceRootPath(home, testWorkspaceSlug);
    await fs.writeFile(path.join(workspace, ".deskrc"), "echo deskrc before failure\nexit 42\n", "utf8");

    const engine = await detectEngine();
    await engine.remove(containerName, true).catch(() => {});

    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const result = await execInSandbox(testWorkspaceId, testWorkspaceSlug, {
      argv: ["sh", "-lc", "printf ready"],
    });

    expect(handle.containerId).toBeTruthy();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("ready");
  });

  it("createOrReuse rebuilds a container whose binds drifted from the current plan", async () => {
    const first = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);

    // Force drift by passing an extra bind the existing container doesn't
    // have. Without the drift check, createOrReuse would hand back the old
    // container and the new bind would silently go missing.
    const extra = await fs.mkdtemp(path.join(os.tmpdir(), "desk-drift-"));
    try {
      const plan = [
        {
          sourcePath: workspaceRootPath(home, testWorkspaceSlug),
          targetPath: SANDBOX_HOME,
          mode: "rw" as const,
          category: "workspace" as const,
        },
        {
          sourcePath: extra,
          targetPath: "/mnt/extra",
          mode: "ro" as const,
          category: "external" as const,
        },
      ];
      const second = await createOrReuse(
        testWorkspaceId, testWorkspaceSlug, home, undefined, plan,
      );
      expect(second.containerId).not.toBe(first.containerId);

      const engine = await detectEngine();
      const info = await engine.inspect(second.containerId);
      expect(info?.binds ?? []).toContain(`${extra}:/mnt/extra:ro`);
    } finally {
      await fs.rm(extra, { recursive: true, force: true });
    }
  });

  it("projectMounts resolves the workspace root that gets bind-mounted at $HOME", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const mounts = await projectMounts(handle, {
      home,
      workspaceId: "wks_int_test",
      workspaceSlug: testWorkspaceSlug,
      runId: "run_int_1",
    });

    expect(mounts.workspace).toBe(workspaceRootPath(home, testWorkspaceSlug));

    const stat = await fs.stat(mounts.workspace);
    expect(stat.isDirectory()).toBe(true);

    expect(SANDBOX_HOME).toBe("/home/agent");

    await teardownMounts(handle, "run_int_1");
  });

  it("runs a no-op command inside the sandbox", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const engine = await detectEngine();
    const h = await engine.exec({
      containerId: handle.containerId,
      cmd: ["echo", "hello from sandbox"],
      user: await sandboxUser(engine),
    });
    const chunks: Buffer[] = [];
    h.stdout.on("data", (c: Buffer) => chunks.push(c));
    await h.wait();
    expect(Buffer.concat(chunks).toString("utf8")).toContain("hello from sandbox");
  });

  it("ships baseline CLI tools", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const engine = await detectEngine();
    const h = await engine.exec({
      containerId: handle.containerId,
      cmd: [
        "sh",
        "-lc",
        [
          "pandoc --version >/dev/null",
          "pdftotext -v >/dev/null",
          "jq --version >/dev/null",
          "git --version >/dev/null",
          "python3 --version >/dev/null",
          "python3 -m pip --version >/dev/null",
          "convert --version >/dev/null",
          "desk-agent file to-markdown --help >/dev/null",
        ].join(" && "),
      ],
      user: await sandboxUser(engine),
    });
    const stderr: Buffer[] = [];
    h.stderr.on("data", (c: Buffer) => stderr.push(c));
    const exitCode = await h.wait();
    expect(exitCode, Buffer.concat(stderr).toString("utf8")).toBe(0);
  });

  it("lets the agent install Debian packages", async () => {
    const result = await execInSandbox(testWorkspaceId, testWorkspaceSlug, {
      argv: [
        "sh",
        "-lc",
        [
          "set -eu",
          "if [ \"$(id -u)\" -eq 0 ]; then SUDO=; else sudo -n true; SUDO=sudo; fi",
          "$SUDO apt-get update",
          "$SUDO apt-get install -y --no-install-recommends fortune-mod fortunes-min",
          "/usr/games/fortune >/dev/null",
        ].join("\n"),
      ],
      timeoutMs: 120_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("grants sudo to an existing image user when the agent uid already exists", async () => {
    const prev = process.env.DESK_SANDBOX_USER;
    process.env.DESK_SANDBOX_USER = "1000:1000";

    const engine = await detectEngine();
    await engine.remove(containerName, true).catch(() => {});

    try {
      const result = await execInSandbox(testWorkspaceId, testWorkspaceSlug, {
        argv: ["sh", "-lc", "test \"$(id -u)\" = 1000 && sudo -n true"],
      });

      expect(result.exitCode, result.stderr).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DESK_SANDBOX_USER;
      else process.env.DESK_SANDBOX_USER = prev;
      await engine.remove(containerName, true).catch(() => {});
    }
  });

  it("converts real documents inside the sandbox", async () => {
    await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const workspace = workspaceRootPath(home, testWorkspaceSlug);
    await fs.writeFile(
      path.join(workspace, "sample.html"),
      "<!doctype html><h1>Quarterly Report</h1><p>Revenue increased.</p>",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, "sample.pdf"),
      [
        "%PDF-1.1",
        "1 0 obj",
        "<< /Type /Catalog /Pages 2 0 R >>",
        "endobj",
        "2 0 obj",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "endobj",
        "3 0 obj",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        "endobj",
        "4 0 obj",
        "<< /Length 44 >>",
        "stream",
        "BT /F1 24 Tf 100 700 Td (Hello PDF text) Tj ET",
        "endstream",
        "endobj",
        "5 0 obj",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "endobj",
        "trailer",
        "<< /Root 1 0 R >>",
        "%%EOF",
        "",
      ].join("\n"),
      "utf8",
    );

    const html = await execInSandbox(testWorkspaceId, testWorkspaceSlug, {
      argv: ["desk-agent", "file", "to-markdown", "sample.html"],
    });
    expect(html.exitCode, html.stderr).toBe(0);
    expect(html.stdout).toContain("# Quarterly Report");
    expect(html.stdout).toContain("Revenue increased.");

    const pdf = await execInSandbox(testWorkspaceId, testWorkspaceSlug, {
      argv: ["desk-agent", "file", "to-markdown", "sample.pdf"],
    });
    expect(pdf.exitCode, pdf.stderr).toBe(0);
    expect(pdf.stdout).toContain("Hello PDF text");
  });

  it("forwards provider API keys from host env to the sandbox", async () => {
    // Pick a sentinel from the forwarded set that opencode recognises
    // (see PROVIDER_KEY_VARS in @agent-desk/shared).
    const envKey = "OPENAI_API_KEY";
    const secret = "sk-desk-env-forwarding-test-123";
    const prev = process.env[envKey];
    process.env[envKey] = secret;

    // Force recreation of this test's container so it picks up the new env.
    const engine = await detectEngine();
    await engine.remove(containerName, true).catch(() => {});

    try {
      const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
      const h = await engine.exec({
        containerId: handle.containerId,
        cmd: ["sh", "-c", `echo "$${envKey}"`],
      });
      const chunks: Buffer[] = [];
      h.stdout.on("data", (c: Buffer) => chunks.push(c));
      await h.wait();
      expect(Buffer.concat(chunks).toString("utf8")).toContain(secret);
    } finally {
      if (prev === undefined) delete process.env[envKey];
      else process.env[envKey] = prev;
    }
  });

  it("execInSandbox refreshes provider keys on a reused container", async () => {
    // Regression: a sandbox first created without keys (or with stale keys)
    // used to keep that env until tear-down, so opencode would hit the
    // provider with an empty/old token even after the user saved a new
    // one. The fix injects providerKeys at each exec; this test pins that
    // behaviour.
    const envKey = "OPENAI_API_KEY";
    const stale = "sk-stale-original";
    const fresh = "sk-fresh-rotated";

    const engine = await detectEngine();
    await engine.remove(containerName, true).catch(() => {});

    await createOrReuse(testWorkspaceId, testWorkspaceSlug, home, { [envKey]: stale });

    const result = await execInSandbox(testWorkspaceId, testWorkspaceSlug, {
      argv: ["sh", "-c", `echo "$${envKey}"`],
      providerKeys: { [envKey]: fresh },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(fresh);
    expect(result.stdout).not.toContain(stale);
  });

  it("ships browser automation tooling and a working display", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const engine = await detectEngine();

    const htmlPath = "/tmp/desk-playwright-smoke.html";
    const screenshotPath = "/tmp/desk-playwright-smoke.png";
    const h = await engine.exec({
      containerId: handle.containerId,
      cmd: [
        "sh",
        "-lc",
        [
          "set -eu",
          "test \"$DISPLAY\" = ':99'",
          "playwright --version",
          "playwright-mcp --version >/dev/null",
          "node -e \"const mcp=require('/usr/local/lib/node_modules/@playwright/mcp/package.json'); const pw=require('/usr/local/lib/node_modules/playwright/package.json'); if (mcp.dependencies.playwright !== pw.version) throw new Error(`playwright mismatch ${mcp.dependencies.playwright} !== ${pw.version}`);\"",
          "test -S /tmp/.X11-unix/X99",
          `printf '%s' '<!doctype html><title>Desk Browser Smoke</title><main>Firefox works</main>' > ${htmlPath}`,
          `node - <<'NODE'
const { firefox } = require('/usr/local/lib/node_modules/playwright');
const fs = require('node:fs');

(async () => {
  const browser = await firefox.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto('file://${htmlPath}');
  const title = await page.title();
  await page.screenshot({ path: '${screenshotPath}' });
  await browser.close();

  if (title !== 'Desk Browser Smoke') throw new Error(` + "`unexpected title ${title}`" + `);
  if (fs.statSync('${screenshotPath}').size <= 0) throw new Error('empty screenshot');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE`,
        ].join("\n"),
      ],
      user: await sandboxUser(engine),
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    h.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    h.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    const exitCode = await h.wait();

    expect({
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    }).toMatchObject({ exitCode: 0 });
  });

  it("pre-registers Playwright MCP in OpenCode's resolved config", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const engine = await detectEngine();
    const h = await engine.exec({
      containerId: handle.containerId,
      cmd: [
        "sh",
        "-lc",
        "opencode debug config | node -e \"let raw=''; process.stdin.on('data', c => raw += c); process.stdin.on('end', () => { const start = raw.indexOf('{'); const cfg = JSON.parse(raw.slice(start)); const mcp = cfg.mcp && cfg.mcp.playwright; if (!mcp) process.exit(1); if (mcp.type !== 'local') process.exit(2); if (mcp.enabled !== true) process.exit(3); if (JSON.stringify(mcp.command) !== JSON.stringify(['playwright-mcp','--browser','firefox'])) process.exit(4); });\"",
      ],
      user: await sandboxUser(engine),
    });
    const exitCode = await h.wait();

    expect(exitCode).toBe(0);
  });

  it("stopSandbox stops the container", async () => {
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    await stopSandbox(handle);
    const engine = await detectEngine();
    const info = await engine.inspect(handle.containerId);
    expect(info?.running).toBe(false);
  });

  it("reapStaleSandboxTrees kills stale opencode-shaped wrappers in the sandbox", async () => {
    // Reproduces the leak shape we hit in prod: a setsid wrapper whose
    // /tmp/desk-runs/<msg>.pid was orphaned because a re-fire of the same
    // runId overwrote the pidfile, or the runtime's finally{} cleanup
    // silently failed. The sweep must identify wrappers not in the
    // expected-pidfile set and SIGKILL them — without crashing if /proc
    // or ps surface unexpected output.
    const handle = await createOrReuse(testWorkspaceId, testWorkspaceSlug, home);
    const engine = await detectEngine();

    // Seed two wrappers that look exactly like a real opencode wrapper:
    // setsid forks (parent waits, child runs sh which writes the pidfile
    // and execs the long-running command). This shape matters because the
    // sweep matches by `cmdline begins with "setsid "` — and setsid only
    // STAYS as argv[0] in /proc when it forks, which only happens when
    // its caller is a process-group leader.
    //
    // We achieve that here by running `exec setsid …` from a non-`&`
    // backgrounded sh-c. The outer sh-c is itself the pgrp leader of the
    // docker exec session, so `exec setsid` lets setsid inherit the
    // leader role and fork on its `--wait` path. `&` would background the
    // setsid as a child of a non-leader subshell, defeating the fork.
    const stalePidFile = "/tmp/desk-runs/msg_stale_TEST.pid";
    const liveActiveFile = "/tmp/desk-runs/msg_active_TEST.pid";
    const seedWrapper = async (pidFile: string): Promise<void> => {
      // Spawn each wrapper as a fully detached daemon inside the sandbox.
      // The outer `setsid` (no --wait) forks once and exits immediately,
      // breaking the parent-shell relationship so closing the docker exec
      // session can't SIGHUP the daemon. The INNER `setsid --wait` is the
      // shape we want to test — it forks because the daemonized middle sh
      // is a process-group leader, so we end up with a parent setsid that
      // matches the sweep's cmdline pattern plus a forked child running
      // sleep 300 in its own pgid.
      //
      // </dev/null and 2>/dev/null severs stdin/stderr so the daemon
      // doesn't keep the docker exec's IO open after we return.
      const seed = await engine.exec({
        containerId: handle.containerId,
        cmd: [
          "sh",
          "-c",
          `mkdir -p /tmp/desk-runs && ` +
            `setsid sh -c 'exec setsid --wait sh -c "echo \\$\\$ > \\"\\$1\\"; shift; exec \\"\\$@\\"" sh ${pidFile} sleep 300' </dev/null >/dev/null 2>/dev/null &`,
        ],
      });
      expect(await seed.wait()).toBe(0);
    };
    await seedWrapper(stalePidFile);
    await seedWrapper(liveActiveFile);
    // Give the daemonizing fork + child setsid + inner sh + exec sleep
    // time to settle. 1s is generous on a fast box, comfortable on CI.
    await new Promise((r) => setTimeout(r, 1000));

    // Verify both wrappers are alive and have written their pidfiles.
    const before = await engine.exec({
      containerId: handle.containerId,
      cmd: ["sh", "-c", "cat /tmp/desk-runs/msg_stale_TEST.pid /tmp/desk-runs/msg_active_TEST.pid"],
    });
    const beforeOut: Buffer[] = [];
    before.stdout.on("data", (c: Buffer) => beforeOut.push(c));
    expect(await before.wait()).toBe(0);
    const [stalePid, activePid] = Buffer.concat(beforeOut)
      .toString("utf8")
      .trim()
      .split(/\s+/)
      .map((n) => parseInt(n, 10));
    expect(stalePid).toBeGreaterThan(0);
    expect(activePid).toBeGreaterThan(0);

    // Diagnostic: confirm both setsid wrappers are detectable via /proc
    // cmdline (which is what the sweep itself uses). Filtering by `comm`
    // would miss wrappers whose setsid didn't fork — see the comment on
    // the sweep script for why /proc/<pid>/cmdline is authoritative.
    const diag = await engine.exec({
      containerId: handle.containerId,
      cmd: [
        "sh",
        "-c",
        // Count /proc entries whose cmdline starts with "setsid " AND
        // contains "/tmp/desk-runs/".
        "n=0; for d in /proc/[0-9]*; do " +
          "c=$(tr '\\0' ' ' < \"$d/cmdline\" 2>/dev/null); " +
          "case \"$c\" in 'setsid '*'/tmp/desk-runs/'*) n=$((n+1));; esac; " +
          "done; echo $n",
      ],
    });
    const diagOut: Buffer[] = [];
    diag.stdout.on("data", (c: Buffer) => diagOut.push(c));
    await diag.wait();
    const wrapperCount = parseInt(Buffer.concat(diagOut).toString("utf8").trim(), 10);
    expect(wrapperCount).toBeGreaterThanOrEqual(2);

    // Snapshot the parent setsids so we can verify they got killed too.
    // The pidfile contains the FORKED child's pid; the wrapper's parent
    // setsid is a separate PID that the sweep also targets.
    const preSnapshot = await engine.exec({
      containerId: handle.containerId,
      cmd: [
        "sh",
        "-c",
        // For each /proc cmdline that starts with "setsid " and refs
        // /tmp/desk-runs/msg_(stale|active), print "<pid> <pidfile_path>".
        "for d in /proc/[0-9]*; do " +
          "c=$(tr '\\0' ' ' < \"$d/cmdline\" 2>/dev/null); " +
          "case \"$c\" in 'setsid '*'/tmp/desk-runs/msg_'*'_TEST.pid'*) " +
          "pid=${d#/proc/}; " +
          "pf=$(echo \"$c\" | tr ' ' '\\n' | grep '/tmp/desk-runs/msg_.*_TEST.pid' | head -1); " +
          "echo \"$pid $pf\";; " +
          "esac; " +
          "done",
      ],
    });
    const preSnapOut: Buffer[] = [];
    preSnapshot.stdout.on("data", (c: Buffer) => preSnapOut.push(c));
    await preSnapshot.wait();
    const parentByPidFile = new Map<string, number>();
    for (const line of Buffer.concat(preSnapOut).toString("utf8").trim().split("\n").filter(Boolean)) {
      const [pidStr, pf] = line.trim().split(/\s+/);
      parentByPidFile.set(pf, parseInt(pidStr, 10));
    }
    expect(parentByPidFile.get(stalePidFile)).toBeGreaterThan(0);
    expect(parentByPidFile.get(liveActiveFile)).toBeGreaterThan(0);

    // Run the sweep with only the *active* pidfile in the expected set.
    const result = await reapStaleSandboxTrees(engine, handle.containerId, [liveActiveFile]);
    expect(result.reaped).toBe(1);

    // Give the kernel a beat to reap killed processes.
    await new Promise((r) => setTimeout(r, 300));

    // Both the child (pidfile content) and the parent setsid for the stale
    // tree must be gone; the active tree's child + parent must still be
    // alive. Checking both ends catches partial-kill bugs that would
    // otherwise look like a successful sweep (e.g. parent dies but the
    // child pgid wasn't actually signalled).
    const staleParent = parentByPidFile.get(stalePidFile)!;
    const activeParent = parentByPidFile.get(liveActiveFile)!;
    const after = await engine.exec({
      containerId: handle.containerId,
      cmd: [
        "sh",
        "-c",
        [
          `kill -0 ${stalePid} 2>/dev/null && echo stale_child_alive || echo stale_child_dead`,
          `kill -0 ${staleParent} 2>/dev/null && echo stale_parent_alive || echo stale_parent_dead`,
          `kill -0 ${activePid} 2>/dev/null && echo active_child_alive || echo active_child_dead`,
          `kill -0 ${activeParent} 2>/dev/null && echo active_parent_alive || echo active_parent_dead`,
        ].join("; "),
      ],
    });
    const afterOut: Buffer[] = [];
    after.stdout.on("data", (c: Buffer) => afterOut.push(c));
    await after.wait();
    const lines = Buffer.concat(afterOut).toString("utf8").trim();
    expect(lines).toContain("stale_child_dead");
    expect(lines).toContain("stale_parent_dead");
    expect(lines).toContain("active_child_alive");
    expect(lines).toContain("active_parent_alive");

    // Cleanup the live wrapper so we don't leave processes around.
    await engine.exec({
      containerId: handle.containerId,
      cmd: [
        "sh",
        "-c",
        `kill -KILL -- "-${activePid}" 2>/dev/null; kill -KILL ${activeParent} 2>/dev/null; rm -f ${liveActiveFile}`,
      ],
    }).then((h) => h.wait());
  });
});
