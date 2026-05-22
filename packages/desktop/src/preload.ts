import { contextBridge, ipcRenderer } from "electron/renderer";

contextBridge.exposeInMainWorld("roomyDesktop", {
  onDockerMissing: (cb: () => void) => {
    ipcRenderer.on("docker-missing", () => cb());
  },
  openPreferences: () => {
    ipcRenderer.send("open-preferences");
  },
  savePrefs: (prefs: { serverUrl: string }) => {
    ipcRenderer.send("save-prefs", prefs);
  },
});
