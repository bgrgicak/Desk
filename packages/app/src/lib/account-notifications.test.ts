import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '@/store/types'
import {
  acceptBrowserNotificationPermissionOffer,
  chatNotificationPath,
  chatNotificationTitle,
  desktopNotificationPromptOfferedKey,
  isInternalChatMessage,
  maybeOfferBrowserNotificationPermissionOnce,
  maybeShowChatBrowserNotification,
  messagePreview,
  notificationsKey,
  shouldOfferBrowserNotificationPermissionOnce,
  shouldShowChatBrowserNotification,
} from './account-notifications'

function message(overrides: Partial<ServerMessage> = {}): ServerMessage {
  return {
    id: 'msg_1',
    chatId: 'cht_1',
    role: 'agent',
    kind: 'chat',
    content: { type: 'text', text: 'hello' },
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('chat browser notification rules', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('matches the sidebar unread bubble rule for non-viewed regular messages', () => {
    expect(shouldShowChatBrowserNotification(message(), 'cht_other')).toBe(true)
  })

  it('does not notify for the currently viewed chat', () => {
    expect(shouldShowChatBrowserNotification(message(), 'cht_1')).toBe(false)
  })

  it('does not notify for messages posted by the current user on another device', () => {
    const userMessage = message({ role: 'user' })
    expect(shouldShowChatBrowserNotification(userMessage, 'cht_other', 'usr_1', 'usr_1')).toBe(false)
    expect(shouldShowChatBrowserNotification(userMessage, 'cht_other', 'usr_1')).toBe(false)
    expect(shouldShowChatBrowserNotification(userMessage, 'cht_other', 'usr_1', 'usr_2')).toBe(true)
  })

  it('still notifies for non-user messages from other chats unless they are tied to the current user', () => {
    expect(shouldShowChatBrowserNotification(message(), 'cht_other', 'usr_1')).toBe(true)
    expect(shouldShowChatBrowserNotification(message(), 'cht_other', 'usr_1', 'usr_1')).toBe(false)
    expect(shouldShowChatBrowserNotification(message(), 'cht_other', 'usr_1', 'usr_2')).toBe(true)
  })

  it('does not notify for internal messages', () => {
    const internalMessages = [
      message({ content: { type: 'agent_turn', userMessageId: 'msg_user' }, role: 'system' }),
      message({ content: { type: 'summary_request' }, role: 'system' }),
      message({ content: { type: 'summary', body: '# Summary' } }),
      message({ kind: 'summary' }),
    ]

    for (const msg of internalMessages) {
      expect(isInternalChatMessage(msg)).toBe(true)
      expect(shouldShowChatBrowserNotification(msg, 'cht_other')).toBe(false)
    }
  })

  it('treats artifact references as visible agent activity', () => {
    const msg = message({ content: { type: 'artifactRef', path: 'artifacts/a.md' } })
    expect(isInternalChatMessage(msg)).toBe(false)
    expect(shouldShowChatBrowserNotification(msg, 'cht_other')).toBe(true)
  })

  it('builds a click-through path to the chat that triggered the notification', () => {
    expect(chatNotificationPath('cht_1', 'wks_1')).toBe('/w/wks_1/pinned?chat=cht_1')
    expect(chatNotificationPath('cht 1', 'wks 1')).toBe('/w/wks%201/pinned?chat=cht+1')
    expect(chatNotificationPath('cht_1', 'wks_1', 'msg_1')).toBe('/w/wks_1/pinned?chat=cht_1&message=msg_1')
    expect(chatNotificationPath('cht_1')).toBeNull()
  })

  it('uses the chat title and start of the message for notification text', () => {
    expect(chatNotificationTitle('Project updates')).toBe('Project updates')
    expect(chatNotificationTitle('   ')).toBe('Chat message')
    expect(messagePreview(message({ content: { type: 'text', text: '  hello   from desk  ' } }))).toBe('hello from desk')
    expect(messagePreview(message({
      content: {
        type: 'events',
        log: [
          { kind: 'event', event: { type: 'text', part: { text: 'hello ' } } },
          { kind: 'event', event: { type: 'text', part: { text: 'from events' } } },
        ],
      },
    }))).toBe('hello from events')
  })

  it('ignores the one-time prompt marker when reading desktop prefs and opens the triggering chat on click', () => {
    const data = new Map<string, string>([
      [desktopNotificationPromptOfferedKey('usr_1'), 'true'],
      [notificationsKey('usr_1'), JSON.stringify({ chatMessages: true, desktop: true })],
    ])
    const localStorageMock = {
      getItem: vi.fn((key: string) => data.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { data.set(key, value) }),
      key: vi.fn((index: number) => Array.from(data.keys())[index] ?? null),
      get length() { return data.size },
    }
    const notificationMock = vi.fn(function (this: Notification, title: string, options?: NotificationOptions) {
      Object.assign(this, { title, options, close: vi.fn() })
    })
    Object.defineProperty(notificationMock, 'permission', { value: 'granted' })
    const assign = vi.fn()
    const windowMock = { Notification: notificationMock, focus: vi.fn(), location: { assign, href: '' } }

    vi.stubGlobal('localStorage', localStorageMock)
    vi.stubGlobal('Notification', notificationMock)
    vi.stubGlobal('window', windowMock)

    maybeShowChatBrowserNotification(
      message({ content: { type: 'text', text: '  Hello from the other chat with useful context.  ' } }),
      'cht_other',
      'wks_1',
      'Project Room',
      'usr_1',
      'usr_2',
    )

    expect(notificationMock).toHaveBeenCalledWith('Project Room', expect.objectContaining({
      body: 'Hello from the other chat with useful context.',
      tag: 'desk-chat-cht_1',
    }))

    const instance = notificationMock.mock.instances[0] as unknown as Notification
    const event = { preventDefault: vi.fn() } as unknown as Event
    instance.onclick?.(event)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(windowMock.focus).toHaveBeenCalled()
    expect(assign).toHaveBeenCalledWith('/w/wks_1/pinned?chat=cht_1&message=msg_1')
  })

  it('offers the browser permission prompt only once and enables desktop prefs when granted', async () => {
    const data = new Map<string, string>()
    const localStorageMock = {
      getItem: vi.fn((key: string) => data.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { data.set(key, value) }),
      key: vi.fn((index: number) => Array.from(data.keys())[index] ?? null),
      get length() { return data.size },
    }
    const notificationMock = {
      permission: 'default' as NotificationPermission,
      requestPermission: vi.fn(async () => {
        notificationMock.permission = 'granted'
        return 'granted' as NotificationPermission
      }),
    }

    vi.stubGlobal('localStorage', localStorageMock)
    vi.stubGlobal('Notification', notificationMock)
    vi.stubGlobal('window', { Notification: notificationMock })

    expect(shouldOfferBrowserNotificationPermissionOnce('usr_1')).toBe(true)
    await expect(acceptBrowserNotificationPermissionOffer('usr_1')).resolves.toBe('granted')
    expect(shouldOfferBrowserNotificationPermissionOnce('usr_1')).toBe(false)
    await expect(maybeOfferBrowserNotificationPermissionOnce('usr_1')).resolves.toBe('granted')

    expect(notificationMock.requestPermission).toHaveBeenCalledTimes(1)
    expect(data.get(desktopNotificationPromptOfferedKey('usr_1'))).toBe('true')
    expect(JSON.parse(data.get(notificationsKey('usr_1')) ?? '{}')).toMatchObject({
      chatMessages: true,
      desktop: true,
    })
  })
})
