import { describe, expect, it } from 'vitest'
import { isComposerDropdownDismissKey } from './ComposerPickers'

describe('composer dropdown dismissal', () => {
  it('treats Escape as the keyboard equivalent of clicking away', () => {
    expect(isComposerDropdownDismissKey({ key: 'Escape' } as KeyboardEvent)).toBe(true)
  })

  it('ignores ordinary typing keys', () => {
    expect(isComposerDropdownDismissKey({ key: 'a' } as KeyboardEvent)).toBe(false)
  })
})
