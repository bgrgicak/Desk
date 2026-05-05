import { describe, expect, it } from 'vitest'
import { toArtifactFromFile } from './artifacts'
import type { ServerFile } from '../types'

function file(overrides: Partial<ServerFile>): ServerFile {
  return {
    path: 'files/example.svg',
    name: 'example.svg',
    mime: 'text/plain',
    size: 42,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('toArtifactFromFile', () => {
  it.each(['text/plain', 'text/html'])('classifies SVG files as image artifacts when stored with %s', (mime) => {
    const artifact = toArtifactFromFile(file({ name: 'diagram.svg', mime }))

    expect(artifact.type).toBe('image')
  })
})
