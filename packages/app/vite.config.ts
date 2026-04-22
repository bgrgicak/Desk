import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// Compute the VM's forwarded port (same algorithm as vm.sh).
function vmPort(): number {
  try {
    const out = execSync(
      `python3 -c 'import zlib,sys; print(3000 + zlib.crc32(sys.argv[1].encode()) % 100)' "${process.env.DESK_INSTANCE ?? "dev"}"`,
      { encoding: "utf-8" },
    );
    return parseInt(out.trim(), 10);
  } catch {
    return 8080;
  }
}

const API_PORT = parseInt(process.env.DESK_API_PORT ?? String(vmPort()), 10);
const target = `http://127.0.0.1:${API_PORT}`;

const API_PATHS = [
  "/auth", "/me", "/workspaces", "/agents", "/chats",
  "/library", "/runs", "/scheduled-jobs", "/search", "/openapi.json",
];

const proxy: Record<string, object> = {};
for (const p of API_PATHS) {
  proxy[p] = { target, changeOrigin: true };
}
proxy["/ws"] = { target: target.replace("http", "ws"), ws: true };

export default defineConfig({
  plugins: [react()],
  server: { proxy },
});
