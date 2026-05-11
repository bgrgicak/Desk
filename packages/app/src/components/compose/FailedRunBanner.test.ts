import { describe, expect, it } from 'vitest'
import { failedRunBannerClassName } from './FailedRunBanner'

describe('FailedRunBanner styling', () => {
  it('uses a red error bubble for retryable failed runs', () => {
    expect(failedRunBannerClassName).toContain('border-red-200')
    expect(failedRunBannerClassName).toContain('bg-red-50')
    expect(failedRunBannerClassName).not.toContain('bg-blue')
    expect(failedRunBannerClassName).not.toContain('bg-orange')
  })
})
