/**
 * Static assertions that the Lima config and vm.sh wire up the
 * host-mounted ~/Desk directory at /home/desk/Desk inside the VM, so
 * workspace files (and later the SQLite DB) live on the host filesystem
 * and survive `vm:reset`.
 *
 * These run in CI; the matching live VM round-trip is in
 * test/e2e/host-mount.test.ts (gated behind RUN_VM_TESTS=1).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("lima.yaml host-Desk mount", () => {
  const yamlPath = resolve(import.meta.dirname, "../../../../lima.yaml");
  const yaml = readFileSync(yamlPath, "utf-8");

  it("declares a writable host mount at /home/desk/Desk", () => {
    expect(yaml).toMatch(/mountPoint:\s*"\/home\/desk\/Desk"/);
    const mountSection = yaml.split("/home/desk/Desk")[1] ?? "";
    expect(mountSection).toMatch(/writable:\s*true/);
  });

  it("substitutes the host path via PLACEHOLDER_DESK_HOME", () => {
    // vm.sh fills this in at `limactl create` time. If the placeholder
    // ever drifts, the substitution will silently no-op and tests fail.
    expect(yaml).toContain("PLACEHOLDER_DESK_HOME");
  });

  it("does not hardcode mountType — vm.sh injects it per host", () => {
    // Lima drivers don't overlap cleanly: macOS+VZ rejects 9p, and on
    // Linux+QEMU virtiofs has chown bugs. vm.sh picks per host, so
    // lima.yaml must not pin a value that would conflict on the other.
    expect(yaml).not.toMatch(/^\s*mountType:\s*"?[a-z0-9]+"?\s*$/m);
  });
});

describe("vm.sh PLACEHOLDER_DESK_HOME substitution", () => {
  const shPath = resolve(import.meta.dirname, "../scripts/vm.sh");
  const sh = readFileSync(shPath, "utf-8");

  it("derives a per-instance host Desk path", () => {
    expect(sh).toMatch(/DESK_HOME_HOST=/);
  });

  it("uses ~/Desk for the dev instance and ~/Desk-<instance> otherwise", () => {
    // Default instance keeps the friendly stable path; throwaway test
    // instances get suffixed dirs so they don't collide with real data.
    expect(sh).toContain('"$HOME/Desk"');
    expect(sh).toMatch(/\$HOME\/Desk-/);
  });

  it("substitutes mounts[1].location in the SET_EXPR passed to limactl", () => {
    expect(sh).toMatch(/mounts\[1\]\.location/);
  });

  it("creates the host Desk dir before starting the VM", () => {
    expect(sh).toMatch(/mkdir -p[^\n]*DESK_HOME_HOST/);
  });

  it("injects mountType per host: virtiofs on Darwin, 9p elsewhere", () => {
    // macOS + Lima VZ driver rejects 9p; Linux + QEMU + virtiofsd refuses
    // guest-side chown. Both branches must be present so a drift in either
    // direction (e.g. someone deleting the case-switch) trips this test.
    expect(sh).toMatch(/Darwin\)\s*MOUNT_TYPE="virtiofs"/);
    expect(sh).toMatch(/MOUNT_TYPE="9p"/);
    expect(sh).toMatch(/\.mountType\s*=\s*\\?"\$MOUNT_TYPE\\?"/);
  });
});

describe("install.sh host-mount tolerance", () => {
  const scriptPath = resolve(import.meta.dirname, "../install.sh");
  const script = readFileSync(scriptPath, "utf-8");

  it("does not chown -R the mount root /home/desk/Desk", () => {
    // virtiofs maps host UIDs through; chown -R from inside the VM would
    // fight that mapping (and may EPERM). Ownership of files *created*
    // by the desk user is fine; the mount root itself must be left alone.
    expect(script).not.toMatch(/chown\s+-R[^\n]*\/home\/desk\/Desk(\s|$|")/);
  });
});
