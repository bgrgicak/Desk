import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type Pool } from "../../src/pool.js";
import { generateId } from "@agent-desk/shared";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import * as users from "../../src/queries/users.js";
import * as agents from "../../src/queries/agents.js";
import * as workspaces from "../../src/queries/workspaces.js";
import * as chats from "../../src/queries/chats.js";
import * as messages from "../../src/queries/messages.js";
import * as search from "../../src/queries/search.js";

let pool: Pool;
let chatA: string;
let chatB: string;
let workspaceAId: string;
let workspaceASlug: string;
let workspaceBSlug: string;

beforeAll(async () => {
  pool = await setupTestDb();

  const userId = generateId("user");
  await users.insert(pool, {
    id: userId,
    username: "searcher",
    passwordHash: "h",
    email: "search@example.com",
  });

  const agentId = generateId("agent");
  await agents.insert(pool, { id: agentId, userId, name: "Searcher" });

  workspaceAId = generateId("workspace");
  workspaceASlug = `wsa-${workspaceAId.slice(-6)}`;
  await workspaces.insert(pool, {
    id: workspaceAId,
    userId,
    name: "WS A",
    path: workspaceASlug,
  });

  const wsBId = generateId("workspace");
  workspaceBSlug = `wsb-${wsBId.slice(-6)}`;
  await workspaces.insert(pool, {
    id: wsBId,
    userId,
    name: "WS B",
    path: workspaceBSlug,
  });

  await pool.query(
    `INSERT INTO workspace_agents (workspace_id, agent_id)
     VALUES (?, ?), (?, ?) ON CONFLICT DO NOTHING`,
    [workspaceAId, agentId, wsBId, agentId],
  );

  chatA = generateId("chat");
  chatB = generateId("chat");
  await chats.insert(pool, {
    id: chatA,
    workspaceId: workspaceAId,
    agentId,
    title: "Chat A",
  });
  await chats.insert(pool, {
    id: chatB,
    workspaceId: wsBId,
    agentId,
    title: "Chat B",
  });

  await messages.insert(pool, {
    id: generateId("message"),
    chatId: chatA,
    role: "user",
    content: { type: "text", text: "Let's plan the kanban board layout" },
  });
  await messages.insert(pool, {
    id: generateId("message"),
    chatId: chatA,
    role: "agent",
    content: { type: "text", text: "Sure — I'll add columns for todo, doing, done." },
  });
  await messages.insert(pool, {
    id: generateId("message"),
    chatId: chatA,
    role: "system",
    content: {
      type: "summary",
      body: "# Chat Summary\n\n## Active threads\n### Kanban setup\nBuilding a kanban tracker.",
    },
  });
  await messages.insert(pool, {
    id: generateId("message"),
    chatId: chatB,
    role: "user",
    content: { type: "text", text: "Could you draft a poem about owls?" },
  });

  // Non-indexable types should NOT show up.
  await messages.insert(pool, {
    id: generateId("message"),
    chatId: chatA,
    role: "agent",
    content: { type: "events", log: [] },
  });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe("searchChatMessages", () => {
  it("returns hits across messages and summaries by default", async () => {
    const hits = await search.searchChatMessages(pool, { query: "kanban" });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(hits.map((h) => h.kind));
    expect(kinds.has("message")).toBe(true);
    expect(kinds.has("summary")).toBe(true);
    for (const hit of hits) {
      expect(hit.workspaceSlug).toBe(workspaceASlug);
    }
  });

  it("can include indexed chat title hits", async () => {
    const hits = await search.searchChatMessages(pool, {
      query: "Chat A",
      includeTitles: true,
    });
    expect(hits.some((h) => h.kind === "chat" && h.chatId === chatA && h.messageId === chatA)).toBe(true);
  });

  it("does not include chat titles unless requested", async () => {
    const hits = await search.searchChatMessages(pool, { query: "Chat A" });
    expect(hits.some((h) => h.kind === "chat")).toBe(false);
  });

  it("scopes to a single chat when chatId is provided", async () => {
    const hits = await search.searchChatMessages(pool, {
      query: "kanban",
      chatId: chatA,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.chatId).toBe(chatA);
    }
  });

  it("scopes to a single workspace by slug", async () => {
    const hits = await search.searchChatMessages(pool, {
      query: "kanban",
      workspaceSlug: workspaceASlug,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.workspaceSlug).toBe(workspaceASlug);
    }

    // Cross-workspace: wsB has no kanban hits.
    const hitsB = await search.searchChatMessages(pool, {
      query: "kanban",
      workspaceSlug: workspaceBSlug,
    });
    expect(hitsB).toEqual([]);
  });

  it("returns hits across all workspaces with workspaceSlug='*'", async () => {
    const hitsAll = await search.searchChatMessages(pool, {
      query: "owls",
      workspaceSlug: "*",
    });
    expect(hitsAll.length).toBeGreaterThan(0);
    expect(hitsAll[0].workspaceSlug).toBe(workspaceBSlug);
  });

  it("filters by kind=summary", async () => {
    const hits = await search.searchChatMessages(pool, {
      query: "kanban",
      kind: "summary",
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    for (const hit of hits) {
      expect(hit.kind).toBe("summary");
    }
  });

  it("filters by kind=message", async () => {
    const hits = await search.searchChatMessages(pool, {
      query: "kanban",
      kind: "message",
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    for (const hit of hits) {
      expect(hit.kind).toBe("message");
    }
  });

  it("emits a snippet with <mark> highlights", async () => {
    const hits = await search.searchChatMessages(pool, { query: "kanban" });
    expect(hits[0].snippet).toContain("<mark>");
    expect(hits[0].snippet).toContain("</mark>");
  });

  it("returns an empty array for an empty query", async () => {
    expect(await search.searchChatMessages(pool, { query: "" })).toEqual([]);
    expect(await search.searchChatMessages(pool, { query: "   " })).toEqual([]);
  });

  it("returns nothing when the query has no matches", async () => {
    const hits = await search.searchChatMessages(pool, { query: "xylophone" });
    expect(hits).toEqual([]);
  });

  it("reflects deletes via the FTS sync trigger", async () => {
    const messageId = generateId("message");
    await messages.insert(pool, {
      id: messageId,
      chatId: chatA,
      role: "user",
      content: { type: "text", text: "ephemeral xylophone marker" },
    });
    let hits = await search.searchChatMessages(pool, { query: "ephemeral" });
    expect(hits.length).toBe(1);
    expect(hits[0].messageId).toBe(messageId);

    await pool.query(`DELETE FROM messages WHERE id = ?`, [messageId]);
    hits = await search.searchChatMessages(pool, { query: "ephemeral" });
    expect(hits).toEqual([]);
  });

  it("keeps workspace slug scope in sync when a workspace path changes", async () => {
    const messageId = generateId("message");
    await messages.insert(pool, {
      id: messageId,
      chatId: chatA,
      role: "user",
      content: { type: "text", text: "rename-sync marker" },
    });

    const renamedSlug = `${workspaceASlug}-renamed`;
    await workspaces.updateMeta(pool, workspaceAId, { path: renamedSlug });
    try {
      const hits = await search.searchChatMessages(pool, {
        query: "rename-sync",
        workspaceSlug: renamedSlug,
      });
      expect(hits.map((h) => h.messageId)).toContain(messageId);
      expect(hits[0].workspaceSlug).toBe(renamedSlug);
    } finally {
      await workspaces.updateMeta(pool, workspaceAId, { path: workspaceASlug });
    }
  });

  it("ranks all filtered matches before applying the limit", async () => {
    const oldHighScoreId = generateId("message");
    await pool.query(
      `INSERT INTO messages (id, chat_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        oldHighScoreId,
        chatA,
        "user",
        JSON.stringify({
          type: "text",
          text: "rankingneedle rankingneedle rankingneedle rankingneedle rankingneedle",
        }),
        "2026-01-01T00:00:00.000Z",
      ],
    );

    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO messages (id, chat_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          generateId("message"),
          chatA,
          "user",
          JSON.stringify({ type: "text", text: "rankingneedle once" }),
          `2026-01-02T00:00:0${i}.000Z`,
        ],
      );
    }

    const hits = await search.searchChatMessages(pool, {
      query: "rankingneedle",
      limit: 1,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].messageId).toBe(oldHighScoreId);
    expect(hits[0].score).toBe(5);
  });
});
