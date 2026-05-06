import type { ButtonHTMLAttributes } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import ExampleFragment from '../fragments/example/Component'

vi.mock('@agent-desk/ui', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}))

describe('Desk app scaffold', () => {
  it('renders the full app shell', () => {
    const html = renderToString(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    )

    expect(html).toContain('Desk app')
    expect(html).toContain('Example')
  })

  it('renders the example fragment as a standalone component', () => {
    const html = renderToString(<ExampleFragment />)

    expect(html).toContain('Example fragment')
    expect(html).toMatch(/Clicked.*0.*times/s)
  })
})
