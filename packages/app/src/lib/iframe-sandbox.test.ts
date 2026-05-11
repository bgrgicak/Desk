import { describe, expect, it } from 'vitest'
import { GENERATED_APP_IFRAME_SANDBOX } from './iframe-sandbox'

describe('GENERATED_APP_IFRAME_SANDBOX', () => {
  it('does not grant generated apps same-origin privileges', () => {
    const sandboxFlags = GENERATED_APP_IFRAME_SANDBOX.split(/\s+/)

    expect(sandboxFlags).toContain('allow-scripts')
    expect(sandboxFlags).not.toContain('allow-same-origin')
  })
})
