/**
 * Real-browser layout coverage for the built-in `chat-cards` grid fragment.
 *
 * The bug this covers is visible only after the fragment is embedded in a
 * chat iframe: a one-item grid used to keep the `sm:grid-cols-2` empty track,
 * leaving the only card at half width in the chat column.
 *
 * Required precondition: the built server runtime mirror must include the
 * current `chat-cards.app/dist/`. Run `npm run build:server` after changing
 * built-in apps so the disposable e2e server has the same bundle the desktop
 * app ships.
 */
import * as fs from 'node:fs/promises'
import { test, expect, type FrameLocator, type Locator, type Page } from '../fixtures'

interface Workspace { id: string }
interface Agent { id: string }
interface Chat { id: string }
interface Message {
  id: string
  role: 'user' | 'agent' | 'system'
  state?: string
  parentId?: string
}

const GRID_FRAGMENT_PATH =
  '/opt/roomy-apps/chat-cards.app/dist/fragments/grid'

const SINGLE_CARD_ITEMS = JSON.stringify([
  {
    title: 'Mount Teide volcano',
    description:
      "Tenerife's volcano and Spain's highest peak, inside Teide National Park.",
    image:
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    link: 'https://example.com/mount-teide',
  },
])

async function chatCardsDistExists(): Promise<boolean> {
  const here = new URL(import.meta.url).pathname
  const distHtml = here.replace(
    /packages\/app\/e2e\/tests\/.*$/,
    'packages/server/runtime/dist/roomy-apps/chat-cards.app/dist/fragments/grid/index.html',
  )
  try {
    await fs.access(distHtml)
    return true
  } catch {
    return false
  }
}

async function attachGlobalFragmentArtifact(opts: {
  serverUrl: string
  token: string
  page: Page
  workspaceId: string
  agentId: string
  fragmentPath: string
  params: Record<string, string>
  chatTitle: string
}): Promise<Chat> {
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    'Content-Type': 'application/json',
  }
  const chat = (await (
    await fetch(`${opts.serverUrl}/chats`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId: opts.workspaceId,
        agentId: opts.agentId,
        title: opts.chatTitle,
      }),
    })
  ).json()) as Chat

  const seed = await fetch(`${opts.serverUrl}/chats/${chat.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: `attach ${opts.fragmentPath}` }),
  })
  expect(seed.status).toBe(201)
  const userMessage = (await seed.json()) as Message

  const deadline = Date.now() + 5_000
  let target: Message | undefined
  while (Date.now() < deadline) {
    const messages = (await (
      await fetch(`${opts.serverUrl}/chats/${chat.id}/messages`, { headers })
    ).json()) as { items: Message[] }
    target = messages.items.find(
      (m) =>
        m.role !== 'user'
        && m.parentId === userMessage.id
        && (m.state === undefined || m.state === 'succeeded' || m.state === 'failed'),
    )
    if (target) break
    await opts.page.waitForTimeout(100)
  }
  if (!target) throw new Error('no agent message to patch')

  const patch = await fetch(
    `${opts.serverUrl}/chats/${chat.id}/messages/${target.id}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        content: {
          type: 'artifactRef',
          path: opts.fragmentPath,
          name: 'chat-cards',
          mime: 'inode/directory',
          params: opts.params,
        },
      }),
    },
  )
  expect(patch.status).toBe(200)
  return chat
}

async function openChatViaUrl(page: Page, workspaceId: string, chatId: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/w/${workspaceId}/pinned?chat=${chatId}`)
  await expect(page.getByTestId('account-avatar')).toBeVisible({ timeout: 10_000 })
}

interface GridMetrics {
  iframeOffsetWidth: number
  contentClientWidth: number
  gridOffsetWidth: number | null
  cardOffsetWidth: number | null
}

async function measureGrid(
  iframe: Locator,
  frame: FrameLocator,
): Promise<GridMetrics> {
  const outer = await iframe.evaluate((node) => {
    const el = node as HTMLIFrameElement
    return { offsetWidth: el.offsetWidth }
  })
  const inner = await frame.locator('html').evaluate((html) => {
    const doc = html.ownerDocument
    const card = doc?.querySelector(
      '[class*="rounded-lg"][class*="bg-card"]',
    ) as HTMLElement | null
    const grid = card?.parentElement as HTMLElement | null
    return {
      clientWidth: html.clientWidth,
      gridOffsetWidth: grid?.offsetWidth ?? null,
      cardOffsetWidth: card?.offsetWidth ?? null,
    }
  })
  return {
    iframeOffsetWidth: outer.offsetWidth,
    contentClientWidth: inner.clientWidth,
    gridOffsetWidth: inner.gridOffsetWidth,
    cardOffsetWidth: inner.cardOffsetWidth,
  }
}

test.describe('chat-cards grid fragment - real iframe layout', () => {
  test.beforeAll(async () => {
    const ok = await chatCardsDistExists()
    test.skip(
      !ok,
      'chat-cards.app runtime mirror not built - run `npm run build:server` first',
    )
  })

  test('single grid card fills the chat column', async ({
    loggedInPage: page,
    serverUrl,
    token,
  }) => {
    const headers = { Authorization: `Bearer ${token}` }
    const workspaces = (await (await fetch(`${serverUrl}/workspaces`, { headers })).json()) as Workspace[]
    const agents = (await (await fetch(`${serverUrl}/agents`, { headers })).json()) as Agent[]
    const ws = workspaces[0]
    const agent = agents[0]

    const chat = await attachGlobalFragmentArtifact({
      serverUrl,
      token,
      page,
      workspaceId: ws.id,
      agentId: agent.id,
      fragmentPath: GRID_FRAGMENT_PATH,
      params: {
        title: 'Mount Teide, Tenerife',
        items: SINGLE_CARD_ITEMS,
      },
      chatTitle: `chat-cards single-card grid ${Date.now()}`,
    })

    await openChatViaUrl(page, ws.id, chat.id)

    const iframe = page.locator('iframe[title="chat-cards"]')
    await expect(iframe).toBeVisible({ timeout: 15_000 })

    const frame = page.frameLocator('iframe[title="chat-cards"]')
    await expect(frame.getByText('Mount Teide volcano')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(300)

    const m = await measureGrid(iframe, frame)
    expect(
      m.iframeOffsetWidth,
      `chat-cards iframe is narrower than the chat column (iframe=${m.iframeOffsetWidth})`,
    ).toBeGreaterThanOrEqual(640)
    expect(m.gridOffsetWidth, 'chat-cards grid was not found in DOM').not.toBeNull()
    expect(m.cardOffsetWidth, 'chat-cards card was not found in DOM').not.toBeNull()
    expect(
      m.cardOffsetWidth!,
      `single grid card does not fill the grid (card=${m.cardOffsetWidth}, grid=${m.gridOffsetWidth}, iframe=${m.iframeOffsetWidth}, html=${m.contentClientWidth})`,
    ).toBeGreaterThanOrEqual(m.gridOffsetWidth! - 4)
  })
})
