import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
} from "electron/main";
import { shell } from "electron/common";
import { createRequire } from "module";
import * as path from "path";
import * as fs from "fs";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { autoUpdater } = require("electron-updater") as { autoUpdater: import("electron-updater").AppUpdater };
import { ServerManager } from "./server-manager.js";
import { loadPrefs, savePrefs } from "./prefs.js";

app.setName("Roomy");

let mainWindow: BrowserWindow | null = null;
let serverManager: ServerManager | null = null;
let preferencesWindow: BrowserWindow | null = null;
let isQuiting = false;

function resolveIconPath(name: string): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "assets", "icons")
    : path.join(import.meta.dirname, "..", "assets", "icons");
  return path.join(base, name);
}

function createAppMenu(serverUrl: string): void {
  const template = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [
        { role: "about" as const },
        { type: "separator" as const },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => openPreferences(),
        },
        { type: "separator" as const },
        { role: "services" as const },
        { type: "separator" as const },
        { role: "hide" as const },
        { role: "hideOthers" as const },
        { role: "unhide" as const },
        { type: "separator" as const },
        { role: "quit" as const },
      ],
    }] : [{
      label: "File",
      submenu: [
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => openPreferences(),
        },
        { type: "separator" as const },
        { role: "quit" as const },
      ],
    }]),
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Open in Browser", click: () => shell.openExternal(serverUrl) },
        { type: "separator" as const },
        { role: "reload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(process.platform === "darwin" ? [
          { type: "separator" as const },
          { role: "front" as const },
        ] : [
          { role: "close" as const },
        ]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(serverUrl: string): void {
  const { windowBounds } = loadPrefs();

  mainWindow = new BrowserWindow({
    width: windowBounds.width,
    height: windowBounds.height,
    x: windowBounds.x,
    y: windowBounds.y,
    minWidth: 800,
    minHeight: 600,
    title: "Roomy",
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(serverUrl);

  const saveBounds = () => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    savePrefs({ windowBounds: { width: b.width, height: b.height, x: b.x, y: b.y } });
  };

  mainWindow.on("resize", saveBounds);
  mainWindow.on("move", saveBounds);

  mainWindow.on("close", (e) => {
    if (!isQuiting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildPrefsHtml(currentUrl: string): string {
  const escaped = currentUrl.replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Roomy Preferences</title>
  <style>
    :root{
      --bg:oklch(1 0 0);
      --fg:oklch(0.141 0.005 285.823);
      --label:oklch(0.552 0.016 285.938);
      --input-bg:oklch(1 0 0);
      --input-border:oklch(0.92 0.004 286.32);
      --ring:oklch(0.705 0.015 286.067);
      --btn-bg:oklch(0.21 0.006 285.885);
      --btn-fg:oklch(0.985 0 0);
      --btn2-border:oklch(0.92 0.004 286.32);
      --btn2-hover:oklch(0.967 0.001 286.375);
    }
    @media(prefers-color-scheme:dark){
      :root{
        --bg:oklch(0.141 0.005 285.823);
        --fg:oklch(0.985 0 0);
        --label:oklch(0.705 0.015 286.067);
        --input-bg:oklch(0.274 0.006 286.033);
        --input-border:oklch(0.274 0.006 286.033);
        --ring:oklch(0.552 0.016 285.938);
        --btn-bg:oklch(0.985 0 0);
        --btn-fg:oklch(0.141 0.005 285.823);
        --btn2-border:oklch(0.274 0.006 286.033);
        --btn2-hover:oklch(0.274 0.006 286.033 / 0.5);
      }
    }
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
      -webkit-font-smoothing:antialiased;
      padding:24px;
      background:var(--bg);
      color:var(--fg);
    }
    h2{font-size:15px;font-weight:600;margin-bottom:20px}
    label{display:block;margin-bottom:6px;font-size:13px;color:var(--label)}
    input{
      width:100%;padding:8px 12px;
      border-radius:0.625rem;
      border:1px solid var(--input-border);
      background:var(--input-bg);
      color:var(--fg);
      font-size:13px;
      font-family:inherit;
      outline:none;
    }
    input:focus{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in oklch,var(--ring) 30%,transparent)}
    p.hint{font-size:12px;color:var(--label);margin-top:6px}
    .row{margin-top:20px;display:flex;gap:8px}
    button{
      padding:0 16px;height:36px;
      border-radius:0.625rem;border:none;
      font-size:13px;font-weight:500;font-family:inherit;
      cursor:pointer;transition:opacity 0.15s;
    }
    button:hover{opacity:0.9}
    button.primary{background:var(--btn-bg);color:var(--btn-fg)}
    button.secondary{
      background:transparent;
      color:var(--fg);
      border:1px solid var(--btn2-border);
    }
    button.secondary:hover{background:var(--btn2-hover);opacity:1}
  </style>
</head>
<body>
  <h2>Preferences</h2>
  <label>Remote server URL</label>
  <input id="url" type="url" placeholder="Leave blank to use the built-in local server" value="${escaped}">
  <p class="hint">When set, Roomy connects to this server instead of starting one locally.</p>
  <div class="row">
    <button class="primary" onclick="save()">Save &amp; Restart</button>
    <button class="secondary" onclick="window.close()">Cancel</button>
  </div>
  <script>
    function save(){
      const url=document.getElementById('url').value.trim();
      window.roomyDesktop?.savePrefs({serverUrl:url});
    }
  </script>
</body>
</html>`;
}

function openPreferences(): void {
  if (preferencesWindow) {
    preferencesWindow.focus();
    return;
  }

  preferencesWindow = new BrowserWindow({
    width: 500,
    height: 280,
    resizable: false,
    title: "Roomy Preferences",
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const { serverUrl } = loadPrefs();
  preferencesWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(buildPrefsHtml(serverUrl))}`,
  );

  preferencesWindow.on("closed", () => {
    preferencesWindow = null;
  });
}

async function checkDocker(): Promise<boolean> {
  const { execFile } = await import("child_process");
  return new Promise((resolve) => {
    execFile("docker", ["info"], { timeout: 5000 }, (err) => resolve(!err));
  });
}

async function setupAutoUpdater(): Promise<void> {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", () => {
    mainWindow?.webContents.send("update-downloaded");
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch {
    // Non-fatal: no network, no published release yet, etc.
  }
}

ipcMain.on("open-preferences", () => openPreferences());

ipcMain.on("save-prefs", (_event, prefs: { serverUrl: string }) => {
  savePrefs({ serverUrl: prefs.serverUrl });
  app.relaunch();
  isQuiting = true;
  app.exit(0);
});

app.on("before-quit", () => {
  isQuiting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  mainWindow?.show();
});

app.on("will-quit", () => {
  serverManager?.stop();
});

async function main(): Promise<void> {
  await app.whenReady();

  // In dev mode on macOS, set the Dock icon (packaged builds get it from electron-builder)
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    const dockIconPath = resolveIconPath("icon.png");
    if (fs.existsSync(dockIconPath)) {
      app.dock.setIcon(dockIconPath);
    }
  }

  const { serverUrl: customUrl } = loadPrefs();
  let serverUrl: string;

  if (customUrl) {
    serverUrl = customUrl;
    // Local/dev servers often use self-signed certs — bypass verification only for the configured host.
    let customHost: string | null = null;
    try { customHost = new URL(customUrl).host; } catch { /* invalid URL, skip */ }
    if (customHost) {
      const trustedHost = customHost;
      app.on("certificate-error", (event, _webContents, url, _error, _certificate, callback) => {
        try {
          if (new URL(url).host === trustedHost) {
            event.preventDefault();
            callback(true);
            return;
          }
        } catch { /* ignore parse errors */ }
        callback(false);
      });
    }
  } else {
    serverManager = new ServerManager();
    serverUrl = serverManager.url;
    try {
      await serverManager.start();
    } catch (err) {
      const errWin = new BrowserWindow({ width: 640, height: 320 });
      errWin.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(
          `<html><body style="font-family:system-ui;padding:24px;background:#1a1a2e;color:#ff6b6b">` +
          `<h2>Failed to start Roomy server</h2>` +
          `<pre style="font-size:12px;color:#ccc;white-space:pre-wrap">${String(err)}</pre>` +
          `</body></html>`,
        )}`,
      );
      return;
    }
  }

  createAppMenu(serverUrl);
  createMainWindow(serverUrl);

  checkDocker().then((ok) => {
    if (!ok) mainWindow?.webContents.send("docker-missing");
  });

  if (app.isPackaged) {
    void setupAutoUpdater();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  app.exit(1);
});
