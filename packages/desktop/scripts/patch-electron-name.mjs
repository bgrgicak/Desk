/**
 * Patches the local Electron.app Info.plist so the dev build shows "Roomy"
 * in the macOS Dock instead of "Electron". Runs silently on non-macOS.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.platform !== "darwin") process.exit(0);

const plist = path.resolve(
  __dirname,
  "..",
  "node_modules/electron/dist/Electron.app/Contents/Info.plist",
);

if (!existsSync(plist)) {
  console.log("patch-electron-name: Electron.app not found, skipping");
  process.exit(0);
}

const pb = "/usr/libexec/PlistBuddy";
try {
  execFileSync(pb, ["-c", "Set :CFBundleDisplayName Roomy", plist]);
  execFileSync(pb, ["-c", "Set :CFBundleName Roomy", plist]);
  console.log("patch-electron-name: patched CFBundleDisplayName + CFBundleName → Roomy");
} catch (err) {
  console.warn("patch-electron-name: failed to patch Info.plist:", err.message);
}
