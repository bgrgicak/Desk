import { describe, it, expect } from 'vitest'
import { extractApiError } from './api-error'

describe('extractApiError', () => {
  it('returns the server-provided message from RTK Query error shape', () => {
    expect(extractApiError({ status: 400, data: { code: 'BAD', message: 'invalid name' } })).toBe('invalid name')
  })

  it('falls back to Error.message when no server data is present', () => {
    expect(extractApiError(new Error('network down'))).toBe('network down')
  })

  it('returns undefined for unknown error shapes', () => {
    expect(extractApiError(undefined)).toBeUndefined()
    expect(extractApiError(null)).toBeUndefined()
    expect(extractApiError({ status: 500 })).toBeUndefined()
    expect(extractApiError({ status: 500, data: 'plain string' })).toBeUndefined()
    expect(extractApiError({ status: 500, data: { code: 'X' } })).toBeUndefined()
  })

  it('ignores non-string message fields', () => {
    expect(extractApiError({ status: 400, data: { message: 42 } })).toBeUndefined()
    expect(extractApiError({ status: 400, data: { message: { nested: 'no' } } })).toBeUndefined()
  })

  it('prefers server data.message over a thrown Error.message when both are present', () => {
    const err = Object.assign(new Error('client side'), { data: { message: 'server side' } })
    expect(extractApiError(err)).toBe('server side')
  })
})
