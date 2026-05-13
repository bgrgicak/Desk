import { describe, expect, it } from 'vitest'
import { attachmentAlignmentClass } from './MessageBubble'

describe('attachmentAlignmentClass', () => {
  it('right-aligns user-uploaded message attachments', () => {
    expect(attachmentAlignmentClass('right')).toBe('self-end ml-auto')
  })

  it('keeps agent-written file attachments left-aligned', () => {
    expect(attachmentAlignmentClass('left')).toBe('self-start mr-auto')
  })
})
