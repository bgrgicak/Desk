import { describe, expect, it } from 'vitest'
import { fileTypeLabel } from './file-kind'

describe('fileTypeLabel', () => {
  it('labels common media + document types', () => {
    expect(fileTypeLabel('photo.png')).toBe('Image')
    expect(fileTypeLabel('clip.mp4')).toBe('Video')
    expect(fileTypeLabel('song.mp3')).toBe('Audio')
    expect(fileTypeLabel('report.pdf')).toBe('PDF')
    expect(fileTypeLabel('letter.docx')).toBe('Document')
    expect(fileTypeLabel('page.html')).toBe('Web page')
    expect(fileTypeLabel('notes.md')).toBe('Text')
  })

  it('labels app bundles', () => {
    expect(fileTypeLabel('todo.app')).toBe('App')
    expect(fileTypeLabel('todo', undefined, true)).toBe('App')
  })

  it('falls back to "Unknown file type" for unrecognised binaries', () => {
    expect(fileTypeLabel('mystery.xyzbin')).toBe('Unknown file type')
  })
})
