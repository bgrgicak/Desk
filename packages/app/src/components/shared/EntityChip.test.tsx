import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type React from 'react'
import { EntityChip } from './EntityChip'

function renderChip(element: React.ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>)
}

describe('EntityChip', () => {
  it('renders workspace chips as real links', () => {
    const markup = renderChip(<EntityChip kind="workspace" id="wks_123" title="Roomy" />)

    expect(markup).toContain('<a')
    expect(markup).toContain('href="/w/wks_123/pinned"')
    expect(markup).not.toContain('<button')
  })

  it('renders chat chips as real links when the workspace is known', () => {
    const markup = renderChip(<EntityChip kind="chat" id="cht_123" title="Plan" workspaceId="wks_123" />)

    expect(markup).toContain('<a')
    expect(markup).toContain('href="/w/wks_123/pinned?chat=cht_123"')
    expect(markup).not.toContain('<button')
  })
})
