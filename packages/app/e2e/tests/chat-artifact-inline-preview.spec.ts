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

  const zipName = `unsupported-${Date.now()}.zip`
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
  await attachArtifactMessage({ path: zipRelPath, name: zipName, mime: 'application/zip' })

  await page.reload()
  await expect(page.getByTestId('account-avatar')).toBeVisible({ timeout: 10_000 })
  const chatButton = page.getByRole('button', { name: /Inline artifact preview/ }).first()
  await expect(chatButton).toBeVisible({ timeout: 10_000 })
  await chatButton.click()

  const inlinePreview = page.getByTestId('artifact-inline-preview').first()
  await expect(inlinePreview).toBeVisible({ timeout: 10_000 })
  const previewBox = await inlinePreview.boundingBox()
  expect(previewBox?.height ?? Infinity).toBeLessThanOrEqual(700)

  const counter = page.frameLocator(`iframe[title="Inline App"]`).getByRole('button', { name: 'Count 0' })
  await expect(counter).toBeVisible()
  await counter.click()
  await expect(page.frameLocator(`iframe[title="Inline App"]`).getByRole('button', { name: 'Count 1' })).toBeVisible()

  await expect(page.getByTestId('artifact-inline-fallback').filter({ hasText: zipName })).toBeVisible()
})
