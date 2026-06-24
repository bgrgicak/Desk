import { describe, expect, it } from 'vitest'
import { shouldRunGlobalSearch } from './searchTiming'

describe('global palette search timing', () => {
  it('waits for at least three non-space characters before server search', () => {
    expect(shouldRunGlobalSearch('')).toBe(false)
    expect(shouldRunGlobalSearch('  ab  ')).toBe(false)
    expect(shouldRunGlobalSearch('abc')).toBe(true)
  })
})
