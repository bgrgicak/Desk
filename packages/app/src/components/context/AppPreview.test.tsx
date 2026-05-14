import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppPreview } from './AppPreview'

describe('AppPreview', () => {
  it('sizes to measured content instead of forcing viewport height', () => {
    const markup = renderToStaticMarkup(<AppPreview scope="chat" chatId="chat-1" appName="demo-app" />)

    expect(markup).toContain('flex flex-col bg-white')
    expect(markup).not.toContain('h-full')
    expect(markup).not.toContain('height:100vh')
  })
})
