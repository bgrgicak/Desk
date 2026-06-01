import { test, expect } from "../fixtures";

interface Workspace {
  id: string;
}

interface Agent {
  id: string;
}

interface Chat {
  id: string;
}

interface Message {
  id: string;
  parentId?: string | null;
  role?: string;
  state?: string;
}

const SVG_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140" viewBox="0 0 240 140">
  <rect width="240" height="140" fill="#f8fafc"/>
  <rect x="18" y="18" width="204" height="104" rx="14" fill="#ef4444"/>
  <circle cx="72" cy="70" r="24" fill="#fef3c7"/>
  <path d="M122 92 L154 56 L188 92 Z" fill="#dcfce7"/>
</svg>`;

async function getFirstWorkspace(serverUrl: string, token: string): Promise<Workspace> {
  const res = await fetch(`${serverUrl}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const workspaces = (await res.json()) as Workspace[];
  return workspaces[0];
}

async function getFirstAgent(serverUrl: string, token: string): Promise<Agent> {
  const res = await fetch(`${serverUrl}/agents`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const agents = (await res.json()) as Agent[];
  return agents[0];
}

async function createChat(
  serverUrl: string,
  token: string,
  workspaceId: string,
  agentId: string,
  title: string,
): Promise<Chat> {
  const res = await fetch(`${serverUrl}/chats`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workspaceId, agentId, title }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Chat;
}

async function uploadLibraryImage(
  serverUrl: string,
  token: string,
  workspaceId: string,
  filename: string,
): Promise<string> {
  const body = new FormData();
  body.append("file", new Blob([SVG_IMAGE], { type: "image/svg+xml" }), filename);
  const res = await fetch(
    `${serverUrl}/library?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
    },
  );
  expect(res.status).toBe(201);
  const json = (await res.json()) as { path: string };
  return json.path;
}

async function postMessageWithAttachments(
  serverUrl: string,
  token: string,
  chatId: string,
  imageName: string,
  textName: string,
): Promise<Message> {
  const body = new FormData();
  body.append("content", "Example preview output from the API.");
  body.append("attachment", new Blob([SVG_IMAGE], { type: "image/svg+xml" }), imageName);
  body.append("attachment", new Blob(["plain text control\n"], { type: "text/plain" }), textName);
  const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Message;
}

async function waitForAgentReply(
  page: import("@playwright/test").Page,
  serverUrl: string,
  token: string,
  chatId: string,
  parentMessageId: string,
): Promise<Message> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${serverUrl}/chats/${chatId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const messages = (await res.json()) as { items: Message[] };
    const target = messages.items.find(message =>
      message.role !== "user" &&
      message.parentId === parentMessageId &&
      (message.state === undefined || message.state === "succeeded" || message.state === "failed")
    );
    if (target) return target;
    await page.waitForTimeout(100);
  }
  throw new Error("No agent message available to patch with an image artifactRef");
}

test("API-created image attachments and image artifact refs render inline", async ({
  loggedInPage: page,
  serverUrl,
  token,
}) => {
  const workspace = await getFirstWorkspace(serverUrl, token);
  const agent = await getFirstAgent(serverUrl, token);
  const stamp = Date.now();
  const chat = await createChat(
    serverUrl,
    token,
    workspace.id,
    agent.id,
    `Inline image preview examples ${stamp}`,
  );
  const attachmentImageName = `inline-attachment-${stamp}.svg`;
  const artifactImageName = `inline-artifact-${stamp}.svg`;
  const textName = `inline-control-${stamp}.txt`;

  const artifactPath = await uploadLibraryImage(
    serverUrl,
    token,
    workspace.id,
    artifactImageName,
  );
  const userMessage = await postMessageWithAttachments(
    serverUrl,
    token,
    chat.id,
    attachmentImageName,
    textName,
  );
  const agentReply = await waitForAgentReply(
    page,
    serverUrl,
    token,
    chat.id,
    userMessage.id,
  );

  const patch = await fetch(`${serverUrl}/chats/${chat.id}/messages/${agentReply.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: {
        type: "artifactRef",
        path: artifactPath,
        workspaceId: workspace.id,
        name: artifactImageName,
        mime: "image/svg+xml",
      },
    }),
  });
  expect(patch.status).toBe(200);

  await page.goto(`/w/${workspace.id}/pinned?chat=${chat.id}`);
  await expect(page.getByTestId("account-avatar")).toBeVisible({ timeout: 10_000 });

  await expect(page.getByRole("img", { name: attachmentImageName })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("img", { name: artifactImageName })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("image-inline-preview")).toHaveCount(2);

  await expect(page.getByText(textName)).toBeVisible();
  await expect(page.getByTestId("preview-panel")).toBeHidden();
});
