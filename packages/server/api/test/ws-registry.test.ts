import { describe, it, expect, afterEach } from "vitest";
import {
  addConnection,
  removeConnection,
  broadcast,
  clearConnections,
  connectionCount,
} from "../src/ws/registry.js";
import type { WsEvent } from "@agent-desk/shared";

// Fake WebSocket
function createFakeWs() {
  const messages: string[] = [];
  return {
    readyState: 1, // OPEN
    send(data: string) {
      messages.push(data);
    },
    messages,
  };
}

afterEach(() => {
  clearConnections();
});

describe("WS registry", () => {
  it("broadcasts to all connections for a user", () => {
    const ws1 = createFakeWs();
    const ws2 = createFakeWs();

    addConnection("usr_1", ws1);
    addConnection("usr_1", ws2);

    const event: WsEvent = {
      type: "chat.updated",
      payload: {
        id: "cht_test",
        workspaceId: "wks_test",
        agentId: "agt_test",
        title: "Test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        unread: false,
      },
    };

    broadcast("usr_1", event);

    expect(ws1.messages.length).toBe(1);
    expect(ws2.messages.length).toBe(1);
    expect(JSON.parse(ws1.messages[0]).type).toBe("chat.updated");
  });

  it("does not broadcast to other users", () => {
    const ws1 = createFakeWs();
    const ws2 = createFakeWs();

    addConnection("usr_1", ws1);
    addConnection("usr_2", ws2);

    const event: WsEvent = {
      type: "chat.updated",
      payload: {
        id: "cht_test",
        workspaceId: "wks_test",
        agentId: "agt_test",
        title: "Test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        unread: false,
      },
    };

    broadcast("usr_1", event);

    expect(ws1.messages.length).toBe(1);
    expect(ws2.messages.length).toBe(0);
  });

  it("prunes dead connections", () => {
    const ws1 = createFakeWs();
    ws1.readyState = 3; // CLOSED

    addConnection("usr_1", ws1);
    expect(connectionCount()).toBe(1);

    broadcast("usr_1", {
      type: "chat.updated",
      payload: {
        id: "cht_test",
        workspaceId: "wks_test",
        agentId: "agt_test",
        title: "Test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        unread: false,
      },
    });

    expect(ws1.messages.length).toBe(0);
    expect(connectionCount()).toBe(0);
  });

  it("removeConnection removes specific socket", () => {
    const ws1 = createFakeWs();
    const ws2 = createFakeWs();

    addConnection("usr_1", ws1);
    addConnection("usr_1", ws2);
    expect(connectionCount()).toBe(2);

    removeConnection("usr_1", ws1);
    expect(connectionCount()).toBe(1);
  });
});
