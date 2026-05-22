/**
 * desk-mcp-bridge — pi extension that proxies arbitrary MCP servers'
 * tools into pi's tool registry.
 *
 * Pi's maintainer explicitly refuses MCP as a first-class feature
 * ("ask the agent to extend itself with custom tools instead"). For
 * Desk we need MCP because every browser-goal chat already depends on
 * Playwright-MCP, plus the open MCP ecosystem (filesystem, github,
 * slack, …) is the kind of optionality we don't want to give up.
 *
 * This extension is the bridge: on session_start it reads
 * `<workspace>/.agents/mcp.json`, spawns each configured MCP server
 * (stdio transport — the 90% of real-world MCP servers), runs the
 * JSON-RPC initialize + tools/list handshake, and registers a pi tool
 * for each MCP tool it discovers. Pi tool calls forward to the MCP
 * server's tools/call.
 *
 * Config shape (lifted from opencode/Claude Desktop, both
 * compatible):
 *
 *   {
 *     "mcpServers": {
 *       "playwright": {
 *         "command": "playwright-mcp",
 *         "args": ["--browser", "firefox"],
 *         "enabled": true,
 *         "env": { "DISPLAY": ":99" }
 *       },
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/agent"]
 *       }
 *     }
 *   }
 *
 * Servers with `"enabled": false` are skipped. Missing `enabled`
 * defaults to true.
 *
 * Failure mode: if a server crashes during start (binary missing, bad
 * args, init protocol mismatch) we log to stderr and skip that server.
 * Other servers and pi itself keep running. We do NOT fail the
 * session — a broken playwright config shouldn't take down chat.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";

// ──────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

interface McpBridgeConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

const CONFIG_PATH = ".agents/mcp.json";

async function loadConfig(cwd: string): Promise<McpBridgeConfig> {
  const p = path.join(cwd, CONFIG_PATH);
  if (!existsSync(p)) return {};
  try {
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw) as McpBridgeConfig;
  } catch (err) {
    process.stderr.write(`[desk-mcp-bridge] failed to read ${p}: ${(err as Error).message}\n`);
    return {};
  }
}

// ──────────────────────────────────────────────────────────────────────────
// MCP JSON-RPC stdio client (bare implementation — no SDK dep)
// ──────────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private serverName: string;

  constructor(serverName: string) {
    this.serverName = serverName;
  }

  async connect(cmd: string, args: string[], env: Record<string, string>): Promise<void> {
    const mergedEnv = { ...process.env, ...env } as NodeJS.ProcessEnv;
    this.child = spawn(cmd, args, { env: mergedEnv, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Don't spam — MCP servers can be chatty. Prefix so it's
      // identifiable in pi's stderr stream.
      process.stderr.write(`[desk-mcp-bridge:${this.serverName}] ${chunk.toString().trimEnd()}\n`);
    });
    const failPending = (err: Error) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    };
    // Without these handlers, a child that exits before initialize
    // completes (e.g. a bad command in user-supplied mcp.json) emits an
    // unhandled 'error' on stdin (EPIPE) or on the child itself
    // (ENOENT) and crashes pi — taking the entire chat turn down.
    // Forward both into the same pending-reject path as exit.
    this.child.on("error", failPending);
    this.child.stdin.on("error", failPending);
    this.child.on("exit", (code, signal) => {
      failPending(new Error(`MCP server '${this.serverName}' exited (code=${code} signal=${signal})`));
    });

    // MCP handshake
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "desk-mcp-bridge", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpTool[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  /**
   * Synchronously terminate the spawned MCP server. Used both on
   * session_end and on connect/listTools failure (the spawned child
   * stays alive after a failed initialize handshake, and would
   * otherwise keep pi's event loop blocked forever — pi can't exit
   * while a child process holds open pipes to stdio).
   *
   * Uses SIGKILL directly rather than SIGTERM-then-SIGKILL: by the
   * time we're closing we want the child gone *now*, not in two
   * seconds; pi's session_end callback doesn't await unref'd timeouts.
   */
  close(): void {
    if (!this.child) return;
    try { this.child.kill("SIGKILL"); } catch {/* noop */}
    try { this.child.stdin.destroy(); } catch {/* noop */}
    try { this.child.stdout.destroy(); } catch {/* noop */}
    try { this.child.stderr.destroy(); } catch {/* noop */}
    this.child = null;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) throw new Error(`MCP server '${this.serverName}' is not connected`);
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // 30s default timeout per request — long enough for slow MCP
      // initialize handshakes (Playwright spins up firefox), short
      // enough that a wedged server doesn't block a chat turn forever.
      const t = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`MCP request '${method}' timed out after 30s on server '${this.serverName}'`));
        }
      }, 30_000);
      t.unref();
      try {
        this.child!.stdin.write(JSON.stringify(req) + "\n");
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child) return;
    const n: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    try { this.child.stdin.write(JSON.stringify(n) + "\n"); } catch {/* noop */}
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: JsonRpcResponse | JsonRpcNotification | undefined;
      try {
        parsed = JSON.parse(line);
      } catch {
        process.stderr.write(`[desk-mcp-bridge:${this.serverName}] non-JSON line: ${line.slice(0, 200)}\n`);
        continue;
      }
      if (parsed && typeof parsed === "object" && "id" in parsed) {
        const resp = parsed as JsonRpcResponse;
        const pending = this.pending.get(Number(resp.id));
        if (!pending) continue;
        this.pending.delete(Number(resp.id));
        if (resp.error) {
          pending.reject(new Error(`MCP error ${resp.error.code}: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      }
      // Notifications from server (e.g. notifications/cancelled) — ignored for now.
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Tracks every spawned MCP-server child, including ones whose
  // initialize handshake failed. The `clients` map below only holds
  // *successfully registered* servers — but pi keeps its event loop
  // alive as long as any spawned child has pipes open, so we need to
  // kill even the failed ones on session_end to let pi exit cleanly.
  const allSpawned = new Set<McpClient>();
  const clients = new Map<string, McpClient>();

  pi.on("session_start", async (_event, ctx) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    const servers = config.mcpServers ?? {};

    for (const [name, server] of Object.entries(servers)) {
      if (server.enabled === false) continue;
      const client = new McpClient(name);
      allSpawned.add(client);
      try {
        await client.connect(server.command, server.args ?? [], server.env ?? {});
        clients.set(name, client);
      } catch (err) {
        process.stderr.write(`[desk-mcp-bridge] failed to start '${name}': ${(err as Error).message}\n`);
        // Kill the child even though connect() didn't finish — the
        // spawn happened before initialize, and the child's stdio pipes
        // would otherwise wedge pi's event loop on exit.
        client.close();
        allSpawned.delete(client);
        continue;
      }

      let tools: McpTool[];
      try {
        tools = await client.listTools();
      } catch (err) {
        process.stderr.write(`[desk-mcp-bridge] tools/list failed for '${name}': ${(err as Error).message}\n`);
        client.close();
        clients.delete(name);
        allSpawned.delete(client);
        continue;
      }

      for (const tool of tools) {
        const toolName = `${name}__${tool.name}`;
        // MCP inputSchemas are JSON Schema. Pi expects a Typebox/JSON
        // Schema-shaped Type.Object. Fall back to Type.Any() when the
        // server omits the schema or gives an unparseable one — pi will
        // pass arguments through anyway.
        const params = mcpSchemaToTypebox(tool.inputSchema);
        pi.registerTool({
          name: toolName,
          label: `${name}: ${tool.name}`,
          description: tool.description ?? `Tool '${tool.name}' from MCP server '${name}'`,
          parameters: params,
          async execute(_toolCallId, args, _signal, _onUpdate, _ctx) {
            const c = clients.get(name);
            if (!c) {
              return {
                content: [{ type: "text", text: `MCP server '${name}' is not connected.` }],
                details: { error: "disconnected" },
              };
            }
            try {
              const result = (await c.callTool(tool.name, args)) as {
                content?: Array<{ type: string; text?: string }>;
                isError?: boolean;
              };
              return {
                content: result.content ?? [{ type: "text", text: "" }],
                details: { mcp: { server: name, tool: tool.name, isError: !!result.isError } },
              };
            } catch (err) {
              const message = (err as Error).message ?? String(err);
              return {
                content: [{ type: "text", text: `MCP tool error: ${message}` }],
                details: { error: message },
              };
            }
          },
        });
      }
      ctx.ui.notify(`MCP server '${name}' loaded ${tools.length} tool(s)`, "info");
    }
  });

  pi.on("session_end", async () => {
    // Iterate the full spawn set, not just `clients`, so children whose
    // initialize handshake never completed get killed too.
    for (const client of allSpawned) client.close();
    allSpawned.clear();
    clients.clear();
  });
}

// ──────────────────────────────────────────────────────────────────────────
// JSON-Schema → Typebox shim
// ──────────────────────────────────────────────────────────────────────────

function mcpSchemaToTypebox(schema: Record<string, unknown> | undefined): unknown {
  // Pi just needs a TSchema-shaped object to validate args. The most
  // permissive thing is Type.Any() — MCP servers describe their args
  // in JSON Schema and we want pi to pass them through verbatim. For
  // a more useful auto-prompt we'd translate property by property,
  // but that's a substantial chunk of code (JSON Schema → Typebox is
  // not 1:1) and pi happily accepts loose schemas.
  if (!schema || typeof schema !== "object") return Type.Any();
  // If we see a top-level "type": "object" with properties, surface a
  // basic Type.Object so pi's tool docs render the arg names. Skip
  // strict validation by allowing additional properties.
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties as Record<string, unknown>)) {
      const desc = (v as { description?: string }).description;
      fields[k] = desc ? Type.Any({ description: desc }) : Type.Any();
    }
    return Type.Object(fields, { additionalProperties: true });
  }
  return Type.Any();
}
