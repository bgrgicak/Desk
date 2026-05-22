import { describe, expect, it } from 'vitest'
import { GENERATED_APP_IFRAME_SANDBOX } from './iframe-sandbox'

describe('GENERATED_APP_IFRAME_SANDBOX', () => {
  it('does not grant generated apps same-origin privileges', () => {
    const sandboxFlags = GENERATED_APP_IFRAME_SANDBOX.split(/\s+/)

    expect(sandboxFlags).toContain('allow-scripts')
    expect(sandboxFlags).not.toContain('allow-same-origin')
  })

  it('allows popups so card/button links can open in a new tab', () => {
    // Without `allow-popups`, the browser blocks regular-click navigation
    // through `target="_blank"` and `window.open` — only middle-click works
    // because that path goes through the user agent, not the iframe's JS.
    // Escaping the sandbox on the opened tab is required so the destination
    // site loads as a normal page rather than another sandboxed frame.
    const sandboxFlags = GENERATED_APP_IFRAME_SANDBOX.split(/\s+/)

    expect(sandboxFlags).toContain('allow-popups')
    expect(sandboxFlags).toContain('allow-popups-to-escape-sandbox')
  })
})
