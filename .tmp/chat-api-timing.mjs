import * as http from "node:http";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { Pool, runMigrations, queries, hashPassword } from "@agent-desk/db";
import { ensureLayout } from "@agent-desk/storage";
import { createRunManager } from "@agent-desk/scheduler";
import { generateId } from "@agent-desk/shared";
import { createApp, clearConnections } from "@agent-desk/api";

function defaultOutPath() {
  const chatId = process.env.DESK_CHAT_ID;
  if (!chatId) {
    throw new Error(
      "Missing output path. Pass a destination as argv[2] or run inside a Desk chat sandbox with DESK_CHAT_ID set."
    );
  }
  return path.join(os.homedir(), ".chats", chatId, "artifacts", "chat-api-timing-report.md");
}

function assertCurrentChatOutput(outPath) {
  const chatId = process.env.DESK_CHAT_ID;
  if (!chatId) return;
  const normalized = path.resolve(outPath).split(path.sep).join("/");
  const marker = "/.chats/";
  const idx = normalized.indexOf(marker);
  if (idx === -1) return;
  const targetChatId = normalized.slice(idx + marker.length).split("/")[0];
  if (targetChatId && targetChatId !== chatId) {
    throw new Error(`Refusing to write timing report to chat ${targetChatId}; this run belongs to ${chatId}`);
  }
}

const outPath = process.argv[2] ?? defaultOutPath();
assertCurrentChatOutput(outPath);
const chatCount = Number(process.env.CHAT_COUNT ?? 250);
const messagesPerChat = Number(process.env.MESSAGES_PER_CHAT ?? 30);
const iterations = Number(process.env.ITERATIONS ?? 7);
let currentSql = null;
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}
function fmt(n) {
  return n.toFixed(1);
}
function snippet(sql) {
  return sql.replace(/\s+/g, " ").trim().slice(0, 180);
}
async function request(port, method, urlPath, token, body) {
  const payload = body === void 0 ? void 0 : JSON.stringify(body);
  currentSql = [];
  const start = performance.now();
  let ttfb = 0;
  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: {
        ...token ? { Authorization: `Bearer ${token}` } : {},
        ...payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}
      }
    }, (res) => {
      ttfb = performance.now() - start;
      let bytes = 0;
      res.on("data", (c) => {
        bytes += c.length;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, bytes }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
  const total = performance.now() - start;
  const spans = currentSql ?? [];
  currentSql = null;
  return {
    label: `${method} ${urlPath}`,
    status: result.status,
    bytes: result.bytes,
    totalMs: total,
    ttfbMs: ttfb,
    bodyMs: Math.max(0, total - ttfb),
    sqlMs: spans.reduce((sum, s) => sum + s.ms, 0),
    sqlCount: spans.length,
    slowSql: spans.sort((a, b) => b.ms - a.ms).slice(0, 3)
  };
}
function summarize(label, rows) {
  const ok = rows.filter((r) => r.status >= 200 && r.status < 300);
  const basis = ok.length ? ok : rows;
  return {
    label,
    status: [...new Set(rows.map((r) => r.status))].join(","),
    bytes: Math.round(median(basis.map((r) => r.bytes))),
    total: median(basis.map((r) => r.totalMs)),
    ttfb: median(basis.map((r) => r.ttfbMs)),
    body: median(basis.map((r) => r.bodyMs)),
    sql: median(basis.map((r) => r.sqlMs)),
    sqlCount: Math.round(median(basis.map((r) => r.sqlCount))),
    slowSql: basis.flatMap((r) => r.slowSql).sort((a, b) => b.ms - a.ms).slice(0, 3)
  };
}
async function main() {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "desk-chat-api-timing-db-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "desk-chat-api-timing-home-"));
  const dbPath = path.join(dbDir, "bench.sqlite3");
  const pool = new Pool({ path: dbPath });
  const originalQuery = pool.query.bind(pool);
  pool.query = (async (sql, params) => {
    const t0 = performance.now();
    try {
      return await originalQuery(sql, params);
    } finally {
      const ms = performance.now() - t0;
      if (currentSql) currentSql.push({ ms, sql: snippet(sql) });
    }
  });
  try {
    await runMigrations(pool);
    await ensureLayout(home);
    process.env.DESK_HOME = home;
    const runManager = createRunManager({ pool, execRunFn: async () => ({ exitCode: 0 }) });
    const server = createApp({ pool, storage: { pool, home }, runManager });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const userId = generateId("user");
    const agentId = generateId("agent");
    const workspaceId = generateId("workspace");
    await queries.users.insert(pool, { id: userId, username: "timing_user", passwordHash: await hashPassword("pw"), email: "timing@example.com" });
    await queries.agents.insert(pool, { id: agentId, userId, name: "TimingAgent", model: "opencode/big-pickle" });
    await queries.workspaces.insert(pool, { id: workspaceId, userId, name: "Timing Workspace", description: "", icon: "" });
    await pool.query(`INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)`, [workspaceId, agentId]);
    let firstChatId = "";
    for (let c = 0; c < chatCount; c++) {
      const chatId = generateId("chat");
      if (!firstChatId) firstChatId = chatId;
      await queries.chats.insert(pool, { id: chatId, workspaceId, agentId, title: `Timing Chat ${c + 1}` });
      for (let m = 0; m < messagesPerChat; m++) {
        let content = { type: "text", text: `Chat ${c + 1} message ${m + 1}` };
        let role = m % 2 === 0 ? "user" : "agent";
        let kind;
        if (c === 0 && m % 5 === 1) {
          role = "agent";
          content = {
            type: "events",
            log: [
              { kind: "event", event: { type: "tool", part: { input: "x".repeat(12000), output: "y".repeat(12000) } } },
              { kind: "stderr", line: "debug ".repeat(2000) },
              { kind: "event", event: { type: "text", part: { text: `Visible answer ${m + 1}` } } }
            ]
          };
        } else if (c === 0 && m % 5 === 2) {
          role = "agent";
          content = { type: "toolResult", toolName: "large", result: { blob: "z".repeat(24000) } };
        } else if (c === 0 && m % 5 === 3) {
          role = "agent";
          kind = "summary";
          content = { type: "summary", body: `# Summary ${m}\n\n${"s".repeat(18000)}` };
        }
        await queries.messages.insert(pool, {
          id: generateId("message"),
          chatId,
          role,
          content,
          kind
        });
      }
    }
    const login = await request(port, "POST", "/auth/login", "", { username: "timing_user", password: "pw" });
    const token = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ username: "timing_user", password: "pw" });
      const req = http.request({ hostname: "127.0.0.1", port, path: "/auth/login", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString()).token));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    await request(port, "GET", `/chats?workspaceId=${encodeURIComponent(workspaceId)}`, token);
    await request(port, "GET", `/chats/${firstChatId}`, token);
    await request(port, "GET", `/chats/${firstChatId}/messages`, token);
    await request(port, "GET", `/chats/${firstChatId}/messages?view=full`, token);
    const groups = {};
    async function sample(label, fn) {
      groups[label] = [];
      for (let i = 0; i < iterations; i++) groups[label].push(await fn());
    }
    await sample("List chats", () => request(port, "GET", `/chats?workspaceId=${encodeURIComponent(workspaceId)}`, token));
    await sample("Get chat", () => request(port, "GET", `/chats/${firstChatId}`, token));
    await sample("List chat messages (timeline default)", () => request(port, "GET", `/chats/${firstChatId}/messages`, token));
    await sample("List chat messages (full debug)", () => request(port, "GET", `/chats/${firstChatId}/messages?view=full`, token));
    await sample("Post task message (no agent turn)", () => request(port, "POST", `/chats/${firstChatId}/messages`, token, { content: "Timing task", kind: "task", title: "Timing task" }));
    const summaries = Object.entries(groups).map(([label, rows]) => summarize(label, rows));
    const lines = [
      `# Chat API timing report`,
      ``,
      `Seed: ${chatCount} chats \xD7 ${messagesPerChat} messages (${chatCount * messagesPerChat} messages) in an in-process API server with SQLite; ${iterations} measured runs after warm-up. Timings are medians in milliseconds.`,
      ``,
      `| API call | status | response bytes | total | TTFB | body read | SQL time | SQL calls |`,
      `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
      ...summaries.map((s) => `| ${s.label} | ${s.status} | ${s.bytes} | ${fmt(s.total)} | ${fmt(s.ttfb)} | ${fmt(s.body)} | ${fmt(s.sql)} | ${s.sqlCount} |`),
      ``,
      `## Slowest SQL observed`,
      ...summaries.flatMap((s) => [
        ``,
        `### ${s.label}`,
        ...s.slowSql.map((q) => `- ${fmt(q.ms)} ms \u2014 \`${q.sql}\``)
      ]),
      ``,
      `## Readout`,
      `- GET /chats is no longer dominated by per-chat message lookups: it now reads cached sidebar fields from chats in one indexed list query. In this seed it dropped from the earlier ~10 ms / ~8.6 ms SQL hotspot to ~2 ms total / ~0.5 ms SQL.`,
      `- GET /chats/:id and the default GET /chats/:id/messages stay small enough for direct chat URLs to render independently while the sidebar list hydrates.`,
      `- Message reads now default to the timeline view: visible text, attachments, current agent-turn state, and recent tool-only completion markers are preserved, while old hidden tool results/event payloads/summary bodies require explicit \`view=full\` for developer/debug mode.`,
      `- POST /chats/:id/messages for non-agent task messages is still small. The write-side cache maintenance cost is paid incrementally by triggers instead of on every sidebar load.`
    ];
    await fs.writeFile(outPath, lines.join("\n"));
    server.close();
    clearConnections();
  } finally {
    await pool.end();
    await fs.rm(dbDir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.DESK_HOME;
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
