import { app } from "electron/main";
import * as fs from "fs";
import * as path from "path";

export interface Prefs {
  serverUrl: string;
  windowBounds: { width: number; height: number; x?: number; y?: number };
}

const DEFAULTS: Prefs = {
  serverUrl: "",
  windowBounds: { width: 1280, height: 800 },
};

function prefsPath(): string {
  return path.join(app.getPath("userData"), "prefs.json");
}

export function loadPrefs(): Prefs {
  try {
    const raw = fs.readFileSync(prefsPath(), "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs: Partial<Prefs>): void {
  const current = loadPrefs();
  const updated = { ...current, ...prefs };
  fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
  fs.writeFileSync(prefsPath(), JSON.stringify(updated, null, 2));
}
