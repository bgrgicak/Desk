/**
 * Slice 20 — PATCH /chats/:id agentId.
 *
 * Wired in `ChatView.handleAgentChange` (changing the agent in the
 * compose strip after the chat has been created). Verifies the server
 * contract used by that flow.
 */
import { test, expect } from "../fixtures";

test("chat agent can be changed via PATCH /chats/:id and the change persists", async ({
  serverUrl,
  token,
}) => {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const ws = (await (
    await fetch(`${serverUrl}/workspaces`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string }>;
  const agents = (await (
    await fetch(`${serverUrl}/agents`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Array<{ id: string; name: string }>;

  // Need a second distinct agent that is also enrolled in the chat's
  // workspace (the server enforces "agent must be a workspace member"
  // on PATCH /chats/:id with agentId).
  let agentB: { id: string; name: string } | undefined = agents[1];
  if (!agentB) {
    const created = await fetch(`${serverUrl}/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `slice20-agent-${Date.now()}` }),
    });
    agentB = (await created.json()) as { id: string; name: string };
  }
  expect(agentB.id).not.toBe(agents[0].id);

  // Make sure agentB is a member of the workspace (the seed fixture
  // typically only enrolls the first agent). 2xx and 4xx-already-member
  // both leave the desired post-state.
  await fetch(`${serverUrl}/workspaces/${ws[0].id}/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agentId: agentB.id }),
  });

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: ws[0].id,
        agentId: agents[0].id,
        title: "Slice20 patch-agent",
      }),
    })
  ).json()) as { id: string; agentId: string };
  expect(chat.agentId).toBe(agents[0].id);

  const patched = await fetch(`${serverUrl}/chats/${chat.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ agentId: agentB.id }),
  });
  expect(patched.status).toBeGreaterThanOrEqual(200);
  expect(patched.status).toBeLessThan(300);
  expect((await patched.json()).agentId).toBe(agentB.id);

  // Re-read confirms the change survived a separate request.
  const fresh = (await (
    await fetch(`${serverUrl}/chats/${chat.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()) as { agentId: string };
  expect(fresh.agentId).toBe(agentB.id);
});
