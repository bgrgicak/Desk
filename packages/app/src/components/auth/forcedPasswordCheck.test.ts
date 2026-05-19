import { describe, expect, it } from 'vitest'
import {
  evaluatePasswordChange,
  PASSWORD_MIN_LENGTH,
  PUBLIC_SEED_PASSWORD,
} from './forcedPasswordCheck'

describe('evaluatePasswordChange', () => {
  it('blocks submit on an empty form', () => {
    const r = evaluatePasswordChange({ newPassword: '', confirmPassword: '' })
    expect(r.canSubmit).toBe(false)
    expect(r.tooShort).toBe(false)
    expect(r.isSeed).toBe(false)
    expect(r.passwordMismatch).toBe(false)
  })

  it('marks tooShort when newPassword is non-empty but under the min length', () => {
    const r = evaluatePasswordChange({
      newPassword: 'a'.repeat(PASSWORD_MIN_LENGTH - 1),
      confirmPassword: 'a'.repeat(PASSWORD_MIN_LENGTH - 1),
    })
    expect(r.tooShort).toBe(true)
    expect(r.canSubmit).toBe(false)
  })

  it('does not mark tooShort when the field is empty (no error until the user types)', () => {
    const r = evaluatePasswordChange({ newPassword: '', confirmPassword: 'something' })
    expect(r.tooShort).toBe(false)
  })

  it('rejects the documented public seed verbatim — even when both fields agree', () => {
    const r = evaluatePasswordChange({
      newPassword: PUBLIC_SEED_PASSWORD,
      confirmPassword: PUBLIC_SEED_PASSWORD,
    })
    expect(r.isSeed).toBe(true)
    expect(r.canSubmit).toBe(false)
  })

  it('catches mismatched confirm even when the primary field is policy-compliant', () => {
    const r = evaluatePasswordChange({
      newPassword: 'a-strong-password-1',
      confirmPassword: 'different-but-also-long',
    })
    expect(r.passwordMismatch).toBe(true)
    expect(r.canSubmit).toBe(false)
  })

  it('does not flag passwordMismatch when one of the fields is empty (lets the user finish typing)', () => {
    const r = evaluatePasswordChange({
      newPassword: 'a-strong-password-1',
      confirmPassword: '',
    })
    expect(r.passwordMismatch).toBe(false)
    expect(r.canSubmit).toBe(false) // still blocked because confirm is empty
  })

  it('allows submit when length >= min, not seed, and confirm matches', () => {
    const password = 'fresh-strong-password-1'
    const r = evaluatePasswordChange({
      newPassword: password,
      confirmPassword: password,
    })
    expect(r.canSubmit).toBe(true)
    expect(r.tooShort).toBe(false)
    expect(r.isSeed).toBe(false)
    expect(r.passwordMismatch).toBe(false)
  })

  it('canSubmit and the three negative flags are mutually consistent', () => {
    // Exhaustive small grid: every combination of length / seed-match
    // / confirm-match. canSubmit must equal the AND of the three
    // policy bits.  This catches future regressions where one
    // predicate is widened without updating canSubmit.
    const password = 'pass-pass-pass-1'
    const cases: Array<[string, string]> = [
      [password, password],
      [password, password + 'x'],
      [PUBLIC_SEED_PASSWORD, PUBLIC_SEED_PASSWORD],
      ['short', 'short'],
      ['', ''],
      [password, ''],
    ]
    for (const [newPassword, confirmPassword] of cases) {
      const r = evaluatePasswordChange({ newPassword, confirmPassword })
      const expectedSubmit =
        newPassword.length >= PASSWORD_MIN_LENGTH &&
        newPassword !== PUBLIC_SEED_PASSWORD &&
        confirmPassword === newPassword &&
        confirmPassword.length > 0
      expect(r.canSubmit, JSON.stringify({ newPassword, confirmPassword })).toBe(expectedSubmit)
    }
  })
})
