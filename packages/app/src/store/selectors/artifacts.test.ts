import { describe, it, expect } from 'vitest'
import {
  isAppArtifactFile,
  isAppDirectoryName,
  toArtifactFromFile,
} from './artifacts'
import type { ServerFile } from '../types'

function file(overrides: Partial<ServerFile> = {}): ServerFile {
  return {
    path: 'p',
    name: 'p',
    mime: 'application/octet-stream',
    size: 0,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  }
}

describe('isAppDirectoryName', () => {
  it('matches kebab.app names', () => {
    expect(isAppDirectoryName('my-todos.app')).toBe(true)
    expect(isAppDirectoryName('a.app')).toBe(true)
  })
  it('rejects entries that are not the .app suffix', () => {
    expect(isAppDirectoryName('notes.md')).toBe(false)
    expect(isAppDirectoryName('something.appz')).toBe(false)
    expect(isAppDirectoryName('.app')).toBe(false)
  })
  it('matches names with multiple dots before .app', () => {
    // Extension-based discriminator: anything ending in .app counts,
    // regardless of how many dots come before. Locks the behavior so a
    // future regex tightening doesn't silently break already-named apps.
    expect(isAppDirectoryName('foo.bar.app')).toBe(true)
    expect(isAppDirectoryName('v1.0.0.app')).toBe(true)
  })
})

describe('isAppArtifactFile', () => {
  it('returns true for `<name>.app/` directory entries', () => {
    expect(isAppArtifactFile(file({ name: 'todo.app', isDir: true }))).toBe(true)
  })
  it('returns false for `<name>.app.json` files (PR-A scaffold output)', () => {
    expect(
      isAppArtifactFile(file({ name: 'todo.app.json', isDir: false })),
    ).toBe(false)
  })
  it('returns false for plain directories', () => {
    expect(isAppArtifactFile(file({ name: 'photos', isDir: true }))).toBe(false)
  })
})

describe('toArtifactFromFile — `<name>.app/` directory', () => {
  it('classifies `<name>.app/` directories as type "app"', () => {
    const a = toArtifactFromFile(
      file({
        path: '.chats/cht_x/artifacts/my-app.app',
        name: 'my-app.app',
        mime: 'inode/directory',
        isDir: true,
      }),
    )
    expect(a.type).toBe('app')
    expect(a.name).toBe('my-app.app')
  })

  it('still classifies `<name>.app.json` files as type "app"', () => {
    const a = toArtifactFromFile(
      file({
        path: '.chats/cht_x/artifacts/my-app.app.json',
        name: 'my-app.app.json',
        mime: 'application/json',
      }),
    )
    expect(a.type).toBe('app')
  })

  it('classifies plain HTML as type "site"', () => {
    const a = toArtifactFromFile(
      file({ name: 'page.html', mime: 'text/html' }),
    )
    expect(a.type).toBe('site')
  })
})
