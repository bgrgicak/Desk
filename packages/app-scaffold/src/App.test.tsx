import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from './App'
import ExampleFragment from '../fragments/example/Component'

describe('Roomy app scaffold', () => {
  it('renders the full app shell', () => {
    const html = renderToString(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    )

    expect(html).toContain('Roomy app')
    expect(html).toContain('Example')
    expect(html).not.toContain('h-screen')
  })

  it('renders the example fragment as a standalone component', () => {
    const html = renderToString(<ExampleFragment />)

    expect(html).toContain('Example fragment')
    expect(html).toMatch(/Clicked.*0.*times/s)
  })
})
