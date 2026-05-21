import { describe, it, expect } from 'vitest'
import {
  appAttachmentToPreview,
  parseChatAppDirPath,
  parseChatAppFragmentPath,
  parseChatAppManifestPath,
  parseGlobalAppPath,
  parseLibraryAppDirPath,
  parseLibraryAppFragmentPath,
  parseLibraryAppManifestPath,
} from './AppPreview'

describe('parseChatAppManifestPath', () => {
  it('extracts the chatId + appName from a chat-artifact manifest path', () => {
    expect(
      parseChatAppManifestPath('.chats/cht_abc/artifacts/my-app.app/desk.app.json'),
    ).toEqual({ chatId: 'cht_abc', appName: 'my-app' })
  })

  it('rejects paths that point at the directory or other files', () => {
    expect(parseChatAppManifestPath('.chats/cht_abc/artifacts/my-app.app')).toBeNull()
    expect(parseChatAppManifestPath('.chats/cht_abc/artifacts/notes.md')).toBeNull()
    expect(parseChatAppManifestPath('my-app.app/desk.app.json')).toBeNull()
  })
})

describe('parseLibraryAppManifestPath', () => {
  it('extracts the appName at the workspace root', () => {
    expect(parseLibraryAppManifestPath('todo.app/desk.app.json'))
      .toEqual({ appName: 'todo' })
  })
  it('extracts the appName under a subfolder', () => {
    expect(parseLibraryAppManifestPath('Projects/Q2/todo.app/desk.app.json'))
      .toEqual({ appName: 'todo' })
  })
  it('rejects chat-artifact paths', () => {
    expect(parseLibraryAppManifestPath('.chats/cht_x/artifacts/my-app.app/desk.app.json'))
      .toBeNull()
  })
})

describe('parseLibraryAppDirPath', () => {
  it('matches a `.app/` directory at the workspace root', () => {
    expect(parseLibraryAppDirPath('todo.app')).toEqual({ appName: 'todo' })
  })
  it('matches a `.app/` directory under a subfolder', () => {
    expect(parseLibraryAppDirPath('Projects/Q2/todo.app')).toEqual({ appName: 'todo' })
  })
  it('rejects chat-artifact paths', () => {
    expect(parseLibraryAppDirPath('.chats/cht_x/artifacts/my-app.app')).toBeNull()
  })
  it('rejects paths that aren\'t `.app/` directories', () => {
    expect(parseLibraryAppDirPath('todo.txt')).toBeNull()
    expect(parseLibraryAppDirPath('todo.app/desk.app.json')).toBeNull()
  })
})

describe('parseChatAppDirPath', () => {
  it('extracts the chatId + appName for a chat `.app/` directory', () => {
    expect(parseChatAppDirPath('.chats/cht_abc/artifacts/todo.app'))
      .toEqual({ chatId: 'cht_abc', appName: 'todo' })
  })
  it('rejects manifest-suffixed paths', () => {
    expect(parseChatAppDirPath('.chats/cht_abc/artifacts/todo.app/desk.app.json'))
      .toBeNull()
  })
})

describe('appAttachmentToPreview', () => {
  it('routes chat dir paths to the chat scope', () => {
    expect(appAttachmentToPreview('.chats/cht_a/artifacts/todo.app'))
      .toEqual({ scope: 'chat', chatId: 'cht_a', appName: 'todo' })
  })
  it('routes chat manifest paths to the chat scope', () => {
    expect(appAttachmentToPreview('.chats/cht_a/artifacts/todo.app/desk.app.json'))
      .toEqual({ scope: 'chat', chatId: 'cht_a', appName: 'todo' })
  })
  it('routes library dir paths to the library scope', () => {
    expect(appAttachmentToPreview('todo.app'))
      .toEqual({ scope: 'library', appName: 'todo', appPath: 'todo.app' })
  })
  it('routes library manifest paths to the library scope', () => {
    expect(appAttachmentToPreview('Projects/todo.app/desk.app.json'))
      .toEqual({ scope: 'library', appName: 'todo', appPath: 'Projects/todo.app' })
  })
  it('routes chat-fragment paths to the chat scope with fragment set', () => {
    expect(
      appAttachmentToPreview('.chats/cht_a/artifacts/todo.app/dist/fragments/add-todo/index.html'),
    ).toEqual({ scope: 'chat', chatId: 'cht_a', appName: 'todo', fragment: 'add-todo' })
  })
  it('routes library-fragment paths to the library scope with fragment set', () => {
    expect(
      appAttachmentToPreview('Projects/todo.app/dist/fragments/list/index.html'),
    ).toEqual({ scope: 'library', appName: 'todo', appPath: 'Projects/todo.app', fragment: 'list' })
  })
  it('returns null for non-app paths', () => {
    expect(appAttachmentToPreview('notes.md')).toBeNull()
    expect(appAttachmentToPreview('.chats/cht_a/attachments/photo.png')).toBeNull()
  })

  it('routes /opt/desk-apps/<name>.app/dist/fragments/<frag> to the global scope', () => {
    expect(
      appAttachmentToPreview('/opt/desk-apps/chat-forms.app/dist/fragments/yes-no'),
    ).toEqual({ scope: 'global', appName: 'chat-forms', fragment: 'yes-no' })
  })

  it('routes /opt/desk-apps/<name>.app (app-only) to the global scope without a fragment', () => {
    expect(
      appAttachmentToPreview('/opt/desk-apps/chat-forms.app'),
    ).toEqual({ scope: 'global', appName: 'chat-forms' })
  })
})

describe('parseGlobalAppPath', () => {
  it('extracts fragment from /opt/desk-apps/<name>.app/dist/fragments/<frag>', () => {
    expect(
      parseGlobalAppPath('/opt/desk-apps/chat-forms.app/dist/fragments/yes-no'),
    ).toEqual({ appName: 'chat-forms', fragment: 'yes-no' })
  })

  it('extracts app from /opt/desk-apps/<name>.app even without dist/fragments tail', () => {
    expect(
      parseGlobalAppPath('/opt/desk-apps/chat-forms.app'),
    ).toEqual({ appName: 'chat-forms' })
    expect(
      parseGlobalAppPath('/opt/desk-apps/chat-forms.app/dist'),
    ).toEqual({ appName: 'chat-forms' })
    expect(
      parseGlobalAppPath('/opt/desk-apps/chat-forms.app/dist/index.html'),
    ).toEqual({ appName: 'chat-forms' })
  })

  it('rejects paths outside the /opt/desk-apps/ prefix', () => {
    expect(parseGlobalAppPath('chat-forms.app/dist/fragments/yes-no')).toBeNull()
    expect(parseGlobalAppPath('/opt/desk-apps/notes/file.md')).toBeNull()
    expect(parseGlobalAppPath('.chats/cht_a/artifacts/chat-forms.app')).toBeNull()
  })

  it('rejects snake_case fragment names (URL matcher requires kebab-case)', () => {
    expect(
      parseGlobalAppPath('/opt/desk-apps/chat-forms.app/dist/fragments/yes_no'),
    ).toBeNull()
  })
})

describe('parseChatAppFragmentPath', () => {
  it('extracts chatId + appName + fragment from a full path', () => {
    expect(
      parseChatAppFragmentPath('.chats/cht_a/artifacts/todo.app/dist/fragments/add-todo/index.html'),
    ).toEqual({ chatId: 'cht_a', appName: 'todo', fragment: 'add-todo' })
  })
  it('matches the bare directory form', () => {
    expect(
      parseChatAppFragmentPath('.chats/cht_a/artifacts/todo.app/dist/fragments/add-todo'),
    ).toEqual({ chatId: 'cht_a', appName: 'todo', fragment: 'add-todo' })
  })
  it('rejects library-shape paths', () => {
    expect(parseChatAppFragmentPath('todo.app/dist/fragments/x/index.html')).toBeNull()
  })
  it('rejects non-fragment paths inside dist', () => {
    expect(
      parseChatAppFragmentPath('.chats/cht_a/artifacts/todo.app/dist/index.html'),
    ).toBeNull()
  })
})

describe('parseLibraryAppFragmentPath', () => {
  it('matches at the workspace root', () => {
    expect(parseLibraryAppFragmentPath('todo.app/dist/fragments/list/index.html'))
      .toEqual({ appName: 'todo', appPath: 'todo.app', fragment: 'list' })
  })
  it('matches under a subfolder', () => {
    expect(parseLibraryAppFragmentPath('Projects/Q2/todo.app/dist/fragments/list')).toEqual({
      appName: 'todo',
      appPath: 'Projects/Q2/todo.app',
      fragment: 'list',
    })
  })
  it('rejects chat-artifact paths', () => {
    expect(
      parseLibraryAppFragmentPath('.chats/cht_a/artifacts/todo.app/dist/fragments/x/index.html'),
    ).toBeNull()
  })
})
