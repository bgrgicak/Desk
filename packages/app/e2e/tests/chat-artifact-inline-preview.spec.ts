import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { test, expect } from '../fixtures'

interface Workspace {
  id: string
  path: string
}

interface Agent {
  id: string
}

interface Chat {
  id: string
}

interface Message {
  id: string
  role: 'user' | 'agent' | 'system'
  state?: string
  parentId?: string
}

test('chat artifact refs render bounded HTML previews and fallback when unsupported', async ({
  loggedInPage: page,
  serverUrl,
  serverHome,
  token,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const workspaces = (await (await fetch(`${serverUrl}/workspaces`, { headers })).json()) as Workspace[]
  const ws = workspaces[0]
  const agents = (await (await fetch(`${serverUrl}/agents`, { headers })).json()) as Agent[]
  const agent = agents[0]

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId: ws.id,
        agentId: agent.id,
        title: `Inline artifact preview ${Date.now()}`,
      }),
    })
  ).json()) as Chat

  const artifactDir = path.join(serverHome, ws.path, '.chats', chat.id, 'artifacts')
  await fs.mkdir(artifactDir, { recursive: true })

  const htmlName = `inline-preview-${Date.now()}.html`
  const htmlRelPath = `.chats/${chat.id}/artifacts/${htmlName}`
  await fs.writeFile(
    path.join(artifactDir, htmlName),
    `<!doctype html>
<html>
  <body>
    <button id="counter">Count 0</button>
    <script>
      let count = 0;
      document.getElementById('counter').addEventListener('click', () => {
        count += 1;
        document.getElementById('counter').textContent = 'Count ' + count;
      });
    </script>
  </body>
</html>`,
    'utf-8',
  )

  const appDirName = `growing-preview-${Date.now()}.app`
  const appRelPath = `.chats/${chat.id}/artifacts/${appDirName}`
  await fs.mkdir(path.join(artifactDir, appDirName, 'dist'), { recursive: true })
  await fs.writeFile(
    path.join(artifactDir, appDirName, 'desk.app.json'),
    JSON.stringify({ name: appDirName.replace(/\.app$/, ''), capabilities: [] }),
    'utf-8',
  )
  await fs.writeFile(
    path.join(artifactDir, appDirName, 'dist', 'index.html'),
    `<!doctype html>
<html>
  <head><title>Growing preview</title></head>
  <body style="margin:0;font-family:sans-serif;">
    <button id="grow">Grow</button>
    <div id="content" style="padding:12px 0;">Short app</div>
    <script>
      document.getElementById('grow').addEventListener('click', () => {
        const content = document.getElementById('content');
        content.innerHTML = Array.from({ length: 20 }, (_, i) => '<div style="height:48px;border-top:1px solid #ddd;display:flex;align-items:center;">Row ' + (i + 1) + '</div>').join('');
      });
    </script>
  </body>
</html>`,
    'utf-8',
  )

  const zipName = `unsupported-artifact-with-a-very-long-name-that-must-stay-inside-the-mobile-chat-view-${Date.now()}.zip`
  const zipRelPath = `.chats/${chat.id}/artifacts/${zipName}`
  await fs.writeFile(path.join(artifactDir, zipName), 'not really a zip', 'utf-8')

  const patchedMessages = new Set<string>()
  const attachArtifactMessage = async (content: { path: string; name: string; mime: string }) => {
    const seed = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: `artifact placeholder ${content.name}` }),
    })
    expect(seed.status).toBe(201)
    const userMessage = (await seed.json()) as Message

    const deadline = Date.now() + 5_000
    let target: Message | undefined
    while (Date.now() < deadline) {
      const messages = (await (
        await fetch(`${serverUrl}/chats/${chat.id}/messages`, { headers })
      ).json()) as { items: Message[] }
      target = messages.items.find(message =>
        message.role !== 'user'
        && message.parentId === userMessage.id
        && !patchedMessages.has(message.id)
        && (message.state === undefined || message.state === 'succeeded' || message.state === 'failed')
      )
      if (target) break
      await page.waitForTimeout(100)
    }
    if (!target) throw new Error('No agent/system message was available to patch')
    patchedMessages.add(target.id)

    const patch = await fetch(`${serverUrl}/chats/${chat.id}/messages/${target.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ content: { type: 'artifactRef', ...content } }),
    })
    expect(patch.status).toBe(200)
  }

  await attachArtifactMessage({ path: htmlRelPath, name: 'Inline App', mime: 'text/html' })
  await attachArtifactMessage({ path: appRelPath, name: appDirName, mime: 'inode/directory' })
  await attachArtifactMessage({ path: zipRelPath, name: zipName, mime: 'application/zip' })

  // Navigate directly to the chat — on mobile (390x844) the sidebar is
  // collapsed by default, so the chat row isn't reachable via the sidebar.
  await page.goto(`/w/${ws.id}/pinned?chat=${chat.id}`)
  await expect(page.getByTestId('account-avatar')).toBeVisible({ timeout: 10_000 })

  const inlinePreview = page.getByTestId('artifact-inline-preview').first()
  await expect(inlinePreview).toBeVisible({ timeout: 10_000 })
  const previewBox = await inlinePreview.boundingBox()
  // Inline previews are capped at 0.85 * viewport height plus the inline
  // shell chrome (~40px). Allow some slop for the shell + sub-pixel layout.
  const PREVIEW_HEIGHT_CEILING = Math.floor(844 * 0.85) + 80
  expect(previewBox?.height ?? Infinity).toBeLessThanOrEqual(PREVIEW_HEIGHT_CEILING)
  expect(previewBox?.x ?? -Infinity).toBeGreaterThanOrEqual(0)
  expect((previewBox?.x ?? 0) + (previewBox?.width ?? Infinity)).toBeLessThanOrEqual(390)

  const counter = page.frameLocator(`iframe[title="Inline App"]`).getByRole('button', { name: 'Count 0' })
  await expect(counter).toBeVisible()
  await counter.click()
  await expect(page.frameLocator(`iframe[title="Inline App"]`).getByRole('button', { name: 'Count 1' })).toBeVisible()

  const growingPreview = page.getByTestId('artifact-inline-preview').filter({ hasText: appDirName })
  await expect(growingPreview).toBeVisible({ timeout: 10_000 })
  const growingBoxBefore = await growingPreview.boundingBox()
  expect(growingBoxBefore?.height ?? Infinity).toBeLessThan(320)

  const growButton = page.frameLocator(`iframe[title="${appDirName.replace(/\.app$/, '')}"]`).getByRole('button', { name: 'Grow' })
  await growButton.click()
  await expect(page.frameLocator(`iframe[title="${appDirName.replace(/\.app$/, '')}"]`).getByText('Row 20')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(250)
  const growingBoxAfter = await growingPreview.boundingBox()
  expect(growingBoxAfter?.height ?? 0).toBeGreaterThan((growingBoxBefore?.height ?? 0) + 200)
  expect(growingBoxAfter?.height ?? Infinity).toBeLessThanOrEqual(PREVIEW_HEIGHT_CEILING)

  const fallback = page.getByTestId('artifact-inline-fallback').filter({ hasText: zipName })
  await expect(fallback).toBeVisible()
  const fallbackBox = await fallback.boundingBox()
  expect(fallbackBox?.x ?? -Infinity).toBeGreaterThanOrEqual(0)
  expect((fallbackBox?.x ?? 0) + (fallbackBox?.width ?? Infinity)).toBeLessThanOrEqual(390)
})

test('clicking a directory artifact ref opens that directory in the Library', async ({
  loggedInPage: page,
  serverUrl,
  serverHome,
  token,
}) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  const workspaces = (await (await fetch(`${serverUrl}/workspaces`, { headers })).json()) as Workspace[]
  const ws = workspaces[0]
  const agents = (await (await fetch(`${serverUrl}/agents`, { headers })).json()) as Agent[]
  const agent = agents[0]

  const dirName = `directory-artifact-${Date.now()}`
  await fs.mkdir(path.join(serverHome, ws.path, dirName), { recursive: true })
  await fs.writeFile(path.join(serverHome, ws.path, dirName, 'inside.md'), '# Inside directory', 'utf-8')

  const chat = (await (
    await fetch(`${serverUrl}/chats`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId: ws.id,
        agentId: agent.id,
        title: `Directory artifact open ${Date.now()}`,
      }),
    })
  ).json()) as Chat

  const seed = await fetch(`${serverUrl}/chats/${chat.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: `show ${dirName}` }),
  })
  expect(seed.status).toBe(201)
  const userMessage = (await seed.json()) as Message

  const deadline = Date.now() + 5_000
  let target: Message | undefined
  while (Date.now() < deadline) {
    const messages = (await (
      await fetch(`${serverUrl}/chats/${chat.id}/messages`, { headers })
    ).json()) as { items: Message[] }
    target = messages.items.find(message =>
      message.role !== 'user'
      && message.parentId === userMessage.id
      && (message.state === undefined || message.state === 'succeeded' || message.state === 'failed')
    )
    if (target) break
    await page.waitForTimeout(100)
  }
  if (!target) throw new Error('No agent/system message was available to patch')

  const patch = await fetch(`${serverUrl}/chats/${chat.id}/messages/${target.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      content: { type: 'artifactRef', path: dirName, name: dirName, mime: 'inode/directory' },
    }),
  })
  expect(patch.status).toBe(200)

  await page.reload()
  await expect(page.getByTestId('account-avatar')).toBeVisible({ timeout: 10_000 })
  const chatButton = page.getByRole('link', { name: /Directory artifact open/ }).first()
  await expect(chatButton).toBeVisible({ timeout: 10_000 })
  await chatButton.click()

  await page.getByTestId('artifact-inline-fallback').filter({ hasText: dirName }).click()

  await expect(page).toHaveURL(new RegExp(`/context\\?folder=${encodeURIComponent(dirName)}(?:$|&)`), {
    timeout: 5_000,
  })
  await expect(page.getByText('inside.md').first()).toBeVisible({ timeout: 10_000 })
})
