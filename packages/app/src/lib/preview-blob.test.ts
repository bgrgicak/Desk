import { describe, expect, it } from 'vitest'
import { previewBlobFor, previewKindFrom } from './preview-blob'

describe('previewKindFrom', () => {
  it('detects SVG images from the file path when the display name has no extension', () => {
    expect(previewKindFrom('Unicorn Riding a Plane', '.chats/1/artifacts/unicorn-plane.svg', 'text/plain')).toBe('image')
  })

  it('classifies .app directory mime as app', () => {
    expect(previewKindFrom('my-todos.app', '.chats/cht_abc/artifacts/my-todos.app', 'inode/directory')).toBe('app')
  })

  it('does not classify arbitrary directories as app previews', () => {
    expect(previewKindFrom('assets', '.chats/cht_abc/artifacts/assets', 'inode/directory')).toBe('unknown')
  })

  it('classifies .app directory by name even without mime', () => {
    expect(previewKindFrom('my-todos.app', '.chats/cht_abc/artifacts/my-todos.app', undefined)).toBe('app')
  })

  it('classifies .app directory by path basename even without mime', () => {
    expect(previewKindFrom('My Todos App', '.chats/cht_abc/artifacts/my-todos.app', undefined)).toBe('app')
  })
})

describe('previewBlobFor', () => {
  it('serves SVG image previews with image/svg+xml even when the source blob is text/plain', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" /></svg>'
    const blob = new Blob([svg], { type: 'text/plain' })

    const previewBlob = await previewBlobFor('image', blob, 'Unicorn Riding a Plane', '.chats/1/artifacts/unicorn-plane.svg', blob.type)

    expect(previewBlob.type).toBe('image/svg+xml')
    expect(await previewBlob.text()).toBe(svg)
  })

  it('leaves non-SVG image blobs unchanged', async () => {
    const blob = new Blob(['png'], { type: 'image/png' })

    await expect(previewBlobFor('image', blob, 'image.png', 'image.png', blob.type)).resolves.toBe(blob)
  })
})
