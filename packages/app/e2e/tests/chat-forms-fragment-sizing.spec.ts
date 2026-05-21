/**
 * Real-browser sizing tests for built-in `chat-forms` fragments.
 *
 * These exist because earlier height/width "fixes" were verified only by
 * string-matching the injected bridge source — which proved the script
 * *contained* the right characters but said nothing about whether the
 * iframe ended up the right height in a browser. This test attaches a
 * real fragment, lets the bridge + AppPreview run end-to-end against a
 * real desk-server, and measures the rendered iframe against its content.
 *
 * Required precondition: `packages/desk-apps/chat-forms.app/dist/` must
 * exist. The disposable e2e server mirrors that directory into its
 * `${DESK_HOME}/.apps/` on startup; if the dist isn't built, the global
 * fragment URL 404s and these tests fail with "iframe never visible"
 * instead of a height assertion. Run `npm --workspace
 * @agent-desk/chat-forms-app run build` once before running this spec.
 */
import * as fs from 'node:fs/promises'
import { test, expect, type FrameLocator, type Locator, type Page } from '../fixtures'

const STEP_COUNTER = (current: number, total: number) =>
  // Wizard.tsx renders `Step N of M`; the uppercase in the screenshot is
  // CSS `text-transform: uppercase`, not the DOM text.
  new RegExp(`^\\s*Step\\s+${current}\\s+of\\s+${total}\\s*$`, 'i')

interface Workspace { id: string; path: string }
interface Agent { id: string }
interface Chat { id: string }
interface Message {
  id: string
  role: 'user' | 'agent' | 'system'
  state?: string
  parentId?: string
}

const MULTI_STEP_FRAGMENT_PATH =
  '/opt/desk-apps/chat-forms.app/dist/fragments/multi-step'

const YES_NO_FRAGMENT_PATH =
  '/opt/desk-apps/chat-forms.app/dist/fragments/yes-no'

const THREE_STEP_PAYLOAD = JSON.stringify([
  { id: 'q1', type: 'short-text', question: 'Test name?' },
  {
    id: 'q2',
    type: 'single-choice',
    question: 'Pick variant',
    options: ['alpha', 'beta', 'gamma'],
  },
  { id: 'q3', type: 'yes-no', question: 'Ready to ship?' },
])

async function chatFormsDistExists(): Promise<boolean> {
  const here = new URL(import.meta.url).pathname
  const distHtml = here.replace(
    /packages\/app\/e2e\/tests\/.*$/,
    'packages/desk-apps/chat-forms.app/dist/fragments/multi-step/index.html',
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
  params?: Record<string, string>
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
          name: 'chat-forms',
          mime: 'inode/directory',
          ...(opts.params ? { params: opts.params } : {}),
        },
      }),
    },
  )
  expect(patch.status).toBe(200)
  return chat
}

interface FrameMetrics {
  iframeOffsetHeight: number
  iframeOffsetWidth: number
  contentScrollHeight: number
  contentClientWidth: number
  cardOffsetWidth: number | null
}

/**
 * Measure the iframe's outer box vs. the document's actual layout size.
 * The iframe is sandboxed without `allow-same-origin`, so the parent
 * cannot reach `iframe.contentDocument` from regular JS. Playwright can,
 * via its frame model — we use `frameLocator.locator('html').evaluate(...)`
 * to run the measurement inside the iframe's own document.
 */
async function measureFragment(
  iframe: Locator,
  frame: FrameLocator,
): Promise<FrameMetrics> {
  const outer = await iframe.evaluate((node) => {
    const el = node as HTMLIFrameElement
    return { offsetHeight: el.offsetHeight, offsetWidth: el.offsetWidth }
  })
  const inner = await frame.locator('html').evaluate((html) => {
    const card = html.ownerDocument?.querySelector(
      '[class*="rounded-lg"][class*="bg-card"]',
    ) as HTMLElement | null
    return {
      scrollHeight: html.scrollHeight,
      clientWidth: html.clientWidth,
      cardOffsetWidth: card?.offsetWidth ?? null,
    }
  })
  return {
    iframeOffsetHeight: outer.offsetHeight,
    iframeOffsetWidth: outer.offsetWidth,
    contentScrollHeight: inner.scrollHeight,
    contentClientWidth: inner.clientWidth,
    cardOffsetWidth: inner.cardOffsetWidth,
  }
}

async function openChatViaUrl(page: Page, workspaceId: string, chatId: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/w/${workspaceId}/pinned?chat=${chatId}`)
  await expect(page.getByTestId('account-avatar')).toBeVisible({ timeout: 10_000 })
}

test.describe('chat-forms fragments — real iframe sizing', () => {
  test.beforeAll(async () => {
    const ok = await chatFormsDistExists()
    test.skip(
      !ok,
      'chat-forms.app/dist not built — run `npm --workspace @agent-desk/chat-forms-app run build` first',
    )
  })

  test('multi-step wizard iframe matches its content height at every step', async ({
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
      fragmentPath: MULTI_STEP_FRAGMENT_PATH,
      params: { steps: THREE_STEP_PAYLOAD },
      chatTitle: `chat-forms multi-step sizing ${Date.now()}`,
    })

    await openChatViaUrl(page, ws.id, chat.id)

    const iframe: Locator = page.locator('iframe[title="chat-forms"]')
    await expect(iframe).toBeVisible({ timeout: 15_000 })

    const frame: FrameLocator = page.frameLocator('iframe[title="chat-forms"]')
    await expect(frame.getByText(STEP_COUNTER(1, 3))).toBeVisible({ timeout: 15_000 })
    await expect(frame.getByText('Test name?')).toBeVisible()

    // Give ResizeObserver + fonts.ready a chance to settle.
    await page.waitForTimeout(300)

    const step1 = await measureFragment(iframe, frame)
    expect(
      step1.iframeOffsetHeight,
      `iframe is shorter than content on step 1 (iframe=${step1.iframeOffsetHeight}, content=${step1.contentScrollHeight})`,
    ).toBeGreaterThanOrEqual(step1.contentScrollHeight)

    // Width: with the chat column capped at max-w-2xl (672px) on a 1280px
    // viewport, a "full-width" wizard means the iframe and its card use
    // the full column width. We tolerate 8px of subpixel/border slop.
    expect(
      step1.iframeOffsetWidth,
      `iframe is narrower than the chat column (iframe=${step1.iframeOffsetWidth})`,
    ).toBeGreaterThanOrEqual(640)
    expect(step1.cardOffsetWidth, 'wizard card was not found in DOM').not.toBeNull()
    expect(
      step1.cardOffsetWidth!,
      `wizard card is narrower than its iframe (card=${step1.cardOffsetWidth}, iframe=${step1.iframeOffsetWidth})`,
    ).toBeGreaterThanOrEqual(step1.iframeOffsetWidth - 64)

    // Advance to step 2 (single-choice — content shape differs from step 1)
    await frame.getByRole('textbox').fill('hello')
    await frame.getByRole('button', { name: 'Next' }).click()
    await expect(frame.getByText(STEP_COUNTER(2, 3))).toBeVisible()
    await expect(frame.getByText('Pick variant')).toBeVisible()
    await page.waitForTimeout(300)

    const step2 = await measureFragment(iframe, frame)
    expect(
      step2.iframeOffsetHeight,
      `iframe is shorter than content on step 2 (iframe=${step2.iframeOffsetHeight}, content=${step2.contentScrollHeight})`,
    ).toBeGreaterThanOrEqual(step2.contentScrollHeight)

    // Advance to step 3 (yes-no). single-choice renders radio inputs inside
    // labels — click the label text rather than expecting a button role.
    await frame.getByText('beta', { exact: true }).click()
    await frame.getByRole('button', { name: 'Next' }).click()
    await expect(frame.getByText(STEP_COUNTER(3, 3))).toBeVisible()
    await expect(frame.getByText('Ready to ship?')).toBeVisible()
    await page.waitForTimeout(300)

    const step3 = await measureFragment(iframe, frame)
    expect(
      step3.iframeOffsetHeight,
      `iframe is shorter than content on step 3 (iframe=${step3.iframeOffsetHeight}, content=${step3.contentScrollHeight})`,
    ).toBeGreaterThanOrEqual(step3.contentScrollHeight)
  })

  test('pressing Enter in a text input advances the wizard to the next step', async ({
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
      fragmentPath: MULTI_STEP_FRAGMENT_PATH,
      params: { steps: THREE_STEP_PAYLOAD },
      chatTitle: `chat-forms enter-to-advance ${Date.now()}`,
    })

    await openChatViaUrl(page, ws.id, chat.id)

    const iframe = page.locator('iframe[title="chat-forms"]')
    await expect(iframe).toBeVisible({ timeout: 15_000 })

    const frame = page.frameLocator('iframe[title="chat-forms"]')
    await expect(frame.getByText(STEP_COUNTER(1, 3))).toBeVisible({ timeout: 15_000 })

    // Type into the short-text input and press Enter — this should fire
    // the form's implicit submission and advance to step 2 without ever
    // clicking the Next button.
    const input = frame.getByRole('textbox')
    await input.fill('hello via enter')
    await input.press('Enter')

    await expect(frame.getByText(STEP_COUNTER(2, 3))).toBeVisible()
    await expect(frame.getByText('Pick variant')).toBeVisible()
  })

  test('yes-no single-question fragment uses the full chat column width', async ({
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
      fragmentPath: YES_NO_FRAGMENT_PATH,
      params: { question: 'Ready to ship?' },
      chatTitle: `chat-forms yes-no sizing ${Date.now()}`,
    })

    await openChatViaUrl(page, ws.id, chat.id)

    const iframe = page.locator('iframe[title="chat-forms"]')
    await expect(iframe).toBeVisible({ timeout: 15_000 })

    const frame = page.frameLocator('iframe[title="chat-forms"]')
    await expect(frame.getByText('Ready to ship?')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(300)

    const m = await measureFragment(iframe, frame)
    expect(
      m.iframeOffsetHeight,
      `iframe is shorter than yes-no content (iframe=${m.iframeOffsetHeight}, content=${m.contentScrollHeight})`,
    ).toBeGreaterThanOrEqual(m.contentScrollHeight)
    expect(
      m.iframeOffsetWidth,
      `yes-no iframe is narrower than the chat column (iframe=${m.iframeOffsetWidth})`,
    ).toBeGreaterThanOrEqual(640)
  })
})
