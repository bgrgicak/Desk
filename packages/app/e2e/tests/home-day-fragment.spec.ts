import { test, expect, type Page } from '../fixtures'

interface Workspace { id: string }
interface Agent { id: string }
interface Chat { id: string; title: string }
interface Message {
  id: string
  chatId: string
  role: 'user' | 'agent' | 'system'
  content: { type: string; text?: string }
  createdAt: string
}

const FRAGMENT_PATH = '/opt/roomy-apps/chat-forms.app/dist/fragments/yes-no'

async function waitForAgentMessage(opts: {
  page: Page
  serverUrl: string
  token: string
  chatId: string
  after: string
}): Promise<Message> {
  const headers = { Authorization: `Bearer ${opts.token}` }
  const afterTime = Date.parse(opts.after)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const res = await fetch(`${opts.serverUrl}/chats/${opts.chatId}/messages?view=full`, { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Message[] }
    const found = body.items
      .filter(m => m.role === 'agent' && Date.parse(m.createdAt) >= afterTime)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
    if (found) return found
    await opts.page.waitForTimeout(150)
  }
  throw new Error('timed out waiting for an agent message')
}

async function waitForUserTextMessage(opts: {
  page: Page
  serverUrl: string
  token: string
  chatId: string
  text: string
}): Promise<Message> {
  const headers = { Authorization: `Bearer ${opts.token}` }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const res = await fetch(`${opts.serverUrl}/chats/${opts.chatId}/messages?view=full`, { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Message[] }
    const found = body.items.find(
      m => m.role === 'user' && m.content.type === 'text' && m.content.text === opts.text,
    )
    if (found) return found
    await opts.page.waitForTimeout(150)
  }
  throw new Error(`timed out waiting for user message: ${opts.text}`)
}

test('Your Day chat card renders the latest actionable fragment', async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  const authHeaders = { Authorization: `Bearer ${token}` }
  const workspaces = (await (await fetch(`${serverUrl}/workspaces`, { headers: authHeaders })).json()) as Workspace[]
  const agents = (await (await fetch(`${serverUrl}/agents`, { headers: authHeaders })).json()) as Agent[]
  const workspace = workspaces[0]
  const agent = agents[0]

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId: workspace.id,
        agentId: agent.id,
        title: `Your Day fragment chat ${Date.now()}`,
      }),
    })
  ).json()) as Chat

  const promptRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: 'Ask for a yes/no decision as a fragment.' }),
  })
  expect(promptRes.status).toBe(201)
  const prompt = (await promptRes.json()) as Message
  const agentMessage = await waitForAgentMessage({
    page: loggedInPage,
    serverUrl,
    token,
    chatId: chat.id,
    after: prompt.createdAt,
  })

  const patchAgentRes = await fetch(`${serverUrl}/chats/${chat.id}/messages/${agentMessage.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      content: {
        type: 'artifactRef',
        path: FRAGMENT_PATH,
        name: 'chat-forms',
        mime: 'inode/directory',
        params: {
          question: 'Ship this from Your Day?',
        },
      },
    }),
  })
  expect(patchAgentRes.status).toBe(200)

  const unreadRes = await fetch(`${serverUrl}/chats/${chat.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ title: chat.title, unread: true }),
  })
  expect(unreadRes.status).toBe(200)

  const messagesLoaded = loggedInPage.waitForResponse(response =>
    response.url().includes(`/chats/${chat.id}/messages`) &&
    response.request().method() === 'GET' &&
    response.status() === 200,
  )
  await loggedInPage.goto('/?view=day')
  await messagesLoaded
  const card = loggedInPage.getByTestId(`home-day-item-${chat.id}`)
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card.getByText(chat.title)).toBeVisible()
  await expect(card.getByTestId('home-day-fragment-preview')).toBeVisible()
  await expect(card.getByTestId(`home-day-open-chat-${chat.id}`)).toBeVisible()

  const frame = loggedInPage.frameLocator('iframe[title="chat-forms"]')
  await expect(frame.getByText('Ship this from Your Day?')).toBeVisible({ timeout: 15_000 })
  await frame.getByRole('button', { name: 'Yes' }).click()
  await expect(frame.getByText('Submitted.')).toBeVisible()
  await waitForUserTextMessage({
    page: loggedInPage,
    serverUrl,
    token,
    chatId: chat.id,
    text: 'Yes',
  })
})

test('Your Day non-needs-input chat card keeps the normal message preview when the latest output is a fragment', async ({
  loggedInPage,
  serverUrl,
  token,
}) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  const authHeaders = { Authorization: `Bearer ${token}` }
  const workspaces = (await (await fetch(`${serverUrl}/workspaces`, { headers: authHeaders })).json()) as Workspace[]
  const agents = (await (await fetch(`${serverUrl}/agents`, { headers: authHeaders })).json()) as Agent[]
  const workspace = workspaces[0]
  const agent = agents[0]

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId: workspace.id,
        agentId: agent.id,
        title: `Your Day normal preview chat ${Date.now()}`,
      }),
    })
  ).json()) as Chat

  const promptRes = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: 'Keep this sentence as the day-card preview.' }),
  })
  expect(promptRes.status).toBe(201)
  const prompt = (await promptRes.json()) as Message
  const agentMessage = await waitForAgentMessage({
    page: loggedInPage,
    serverUrl,
    token,
    chatId: chat.id,
    after: prompt.createdAt,
  })

  const patchAgentRes = await fetch(`${serverUrl}/chats/${chat.id}/messages/${agentMessage.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      content: {
        type: 'artifactRef',
        path: FRAGMENT_PATH,
        name: 'chat-forms',
        mime: 'inode/directory',
        params: {
          question: 'This should not be embedded outside Needs input.',
        },
      },
    }),
  })
  expect(patchAgentRes.status).toBe(200)

  const readRes = await fetch(`${serverUrl}/chats/${chat.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ title: chat.title, unread: false }),
  })
  expect(readRes.status).toBe(200)

  const messagesLoaded = loggedInPage.waitForResponse(response =>
    response.url().includes(`/chats/${chat.id}/messages`) &&
    response.request().method() === 'GET' &&
    response.status() === 200,
  )
  await loggedInPage.goto('/?view=day')
  await messagesLoaded
  const card = loggedInPage.getByTestId(`home-day-item-${chat.id}`)
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card.getByText(chat.title)).toBeVisible()
  await expect(card.getByText('Keep this sentence as the day-card preview.')).toBeVisible()
  await expect(card.getByTestId('home-day-fragment-preview')).toHaveCount(0)
})
