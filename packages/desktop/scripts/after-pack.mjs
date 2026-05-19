import { execSync } from "node:child_process";
import * as path from "node:path";

/**
 * Ad-hoc sign the packaged .app so macOS shows "unidentified developer"
 * instead of "damaged and can't be opened" for unsigned downloads.
 * Runs after electron-builder packs the app but before DMG creation.
 */
export default async function afterPack({ appOutDir, packager }) {
  if (process.platform !== "darwin") return;
  const appPath = path.join(
    appOutDir,
    `${packager.appInfo.productFilename}.app`
  );
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: "inherit",
  });
}
