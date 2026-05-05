import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppPreview } from './AppPreview'

describe('AppPreview', () => {
  it('fills the containing panel instead of forcing viewport height', () => {
    const markup = renderToStaticMarkup(<AppPreview chatId="chat-1" appName="demo-app" />)

    expect(markup).toContain('h-full')
    expect(markup).toContain('min-h-0')
    expect(markup).not.toContain('height:100vh')
  })
})
