import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// Stub the RTK Query mutation hook to keep the test free of a store
// Provider — the screen reads the [trigger, { isLoading }] tuple
// shape on every render, so a minimal stub is enough.
vi.mock('@/store/api', () => ({
  useChangePasswordMutation: () => [
    () => ({ unwrap: () => Promise.resolve() }),
    { isLoading: false },
  ],
}))

// The shared Toaster portals to document.body via render effects we
// can't run inside renderToStaticMarkup; stub it out to a no-op.
vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: { success: () => undefined, error: () => undefined },
}))

import { ForcedPasswordChangeScreen } from './ForcedPasswordChangeScreen'

describe('ForcedPasswordChangeScreen — static render', () => {
  it('renders both password fields, the submit button, and the explanatory copy', () => {
    const markup = renderToStaticMarkup(<ForcedPasswordChangeScreen />)

    // The two password inputs the form needs.
    expect(markup).toContain('id="new-password"')
    expect(markup).toContain('id="confirm-password"')
    // type="password" is the only non-cosmetic attribute the test
    // actually cares about — autofill + native masking ride on it.
    expect(markup.match(/type="password"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    // Submit button.
    expect(markup).toContain('type="submit"')
    expect(markup).toContain('Update password and continue')
    // The explanatory copy that justifies the gate to the user.
    expect(markup).toContain('Choose a new password')
    expect(markup).toMatch(/seed password|locked until/i)
  })

  it('initial render disables the submit button (no password typed yet)', () => {
    const markup = renderToStaticMarkup(<ForcedPasswordChangeScreen />)
    // React serializes the `disabled` prop as a boolean attribute.
    expect(markup).toMatch(/<button[^>]+\btype="submit"[^>]+\bdisabled\b/)
  })

  it('mirrors the 12-char minimum on the native input element', () => {
    const markup = renderToStaticMarkup(<ForcedPasswordChangeScreen />)
    // The minLength attribute matches PASSWORD_MIN_LENGTH (12) so
    // browsers also enforce client-side what the server demands.
    expect(markup).toMatch(/minlength="12"/i)
  })
})
