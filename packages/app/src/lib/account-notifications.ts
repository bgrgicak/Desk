import type { ServerMessage } from '@/store/types'

export interface NotificationsShape {
  chatMessages: boolean
  mentions: boolean
  taskUpdates: boolean
  runCompletion: boolean
  connectionIssues: boolean
  artifactComments: boolean
  workspaceInvitations: boolean
  emailDigest: boolean
  sounds: boolean
  desktop: boolean
}

export const NOTIFICATIONS_DEFAULTS: NotificationsShape = {
  chatMessages: true,
  mentions: true,
  taskUpdates: true,
  runCompletion: true,
  connectionIssues: true,
  artifactComments: true,
  workspaceInvitations: true,
  emailDigest: false,
  sounds: false,
  desktop: false,
}

export function notificationsKey(userId: string): string {
  return `desk.notifications.${userId}`
}

export function desktopNotificationPromptOfferedKey(userId: string): string {
  return `desk.notifications.desktopPromptOffered.${userId}`
}

export function loadNotifications(userId: string | undefined): NotificationsShape {
  if (!userId) return NOTIFICATIONS_DEFAULTS
  try {
    const raw = localStorage.getItem(notificationsKey(userId))
    if (!raw) return NOTIFICATIONS_DEFAULTS
    const parsed = JSON.parse(raw) as Partial<NotificationsShape>
    return { ...NOTIFICATIONS_DEFAULTS, ...parsed }
  } catch {
    return NOTIFICATIONS_DEFAULTS
  }
}

export function saveNotifications(userId: string | undefined, value: NotificationsShape): void {
  if (!userId) return
  try {
    localStorage.setItem(notificationsKey(userId), JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

export function isInternalChatMessage(msg: ServerMessage): boolean {
  const ct = msg.content?.type
  const mk = msg.kind ?? 'chat'
  return (
    ct === 'agent_turn' ||
    ct === 'summary_request' ||
    ct === 'summary' ||
    ct === 'artifactRef' ||
    mk === 'summary'
  )
}

export function shouldShowChatBrowserNotification(
  msg: ServerMessage,
  viewingChatId?: string | null,
  currentUserId?: string | null,
  actorUserId?: string | null,
): boolean {
  if (isInternalChatMessage(msg)) return false
  if (viewingChatId === msg.chatId) return false

  // User-authored messages are echoed to every device logged in as that user.
  // Do not show a desktop notification for the sender's own message; if the
  // server ever omits actorUserId for a user message, fail closed rather than
  // notifying the same account on another device.
  if (msg.role === 'user') {
    return !!actorUserId && !!currentUserId && actorUserId !== currentUserId
  }

  return !actorUserId || actorUserId !== currentUserId
}

export function chatNotificationTitle(chatTitle?: string | null): string {
  const title = chatTitle?.trim()
  return title || 'Chat message'
}

export function messagePreview(msg: ServerMessage): string {
  const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ')
  const truncate = (text: string): string => text.length > 120 ? `${text.slice(0, 117)}…` : text

  if (msg.content.type === 'text') {
    const text = normalize(msg.content.text)
    if (text) return truncate(text)
  }

  if (msg.content.type === 'events') {
    let sawStructuredEvent = false
    let text = ''
    for (const entry of msg.content.log) {
      if (entry.kind === 'event') {
        sawStructuredEvent = true
        if (entry.event.type === 'text' && typeof entry.event.part?.text === 'string') {
          text += entry.event.part.text
        }
      } else if (entry.kind === 'unparsed' && !sawStructuredEvent) {
        text += `${entry.line}\n`
      }
    }
    const preview = normalize(text)
    if (preview) return truncate(preview)
  }

  if (msg.content.type === 'artifactRef') {
    return `Shared ${msg.content.name?.trim() || msg.content.path}`
  }
  return msg.role === 'agent' ? 'The agent posted a new message.' : 'A new message was posted.'
}

export function chatNotificationPath(chatId: string, workspaceId?: string | null, messageId?: string | null): string | null {
  if (!workspaceId) return null
  const params = new URLSearchParams({ chat: chatId })
  if (messageId) params.set('message', messageId)
  return `/w/${encodeURIComponent(workspaceId)}/pinned?${params.toString()}`
}

function openChatNotification(chatId: string, workspaceId?: string | null, messageId?: string | null): void {
  try { window.focus() } catch { /* ignore */ }
  const path = chatNotificationPath(chatId, workspaceId, messageId)
  if (!path) return
  try {
    window.location.assign(path)
  } catch {
    window.location.href = path
  }
}

function showNotification(msg: ServerMessage, workspaceId?: string | null, chatTitle?: string | null): void {
  const notification = new Notification(chatNotificationTitle(chatTitle), {
    body: messagePreview(msg),
    tag: `desk-chat-${msg.chatId}`,
  })
  notification.onclick = (event) => {
    event.preventDefault()
    openChatNotification(msg.chatId, workspaceId, msg.id)
    notification.close()
  }
}

export function maybeShowChatBrowserNotification(
  msg: ServerMessage,
  viewingChatId?: string | null,
  workspaceId?: string | null,
  chatTitle?: string | null,
  userId?: string | null,
  actorUserId?: string | null,
): void {
  if (!shouldShowChatBrowserNotification(msg, viewingChatId, userId, actorUserId)) return
  if (!userId) return
  const prefs = loadNotifications(userId)
  if (!prefs.chatMessages || !prefs.desktop) return
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission === 'granted') {
    showNotification(msg, workspaceId, chatTitle)
  }
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | null> {
  if (typeof window === 'undefined' || !('Notification' in window)) return null
  if (Notification.permission === 'default') {
    try {
      return await Notification.requestPermission()
    } catch {
      return null
    }
  }
  return Notification.permission
}

export function shouldOfferBrowserNotificationPermissionOnce(userId: string | undefined): boolean {
  if (!userId) return false
  if (typeof window === 'undefined' || !('Notification' in window)) return false
  if (Notification.permission !== 'default') return false

  const offeredKey = desktopNotificationPromptOfferedKey(userId)
  try {
    return localStorage.getItem(offeredKey) !== 'true'
  } catch {
    return true
  }
}

export function markBrowserNotificationPermissionOffered(userId: string | undefined): void {
  if (!userId) return
  try {
    localStorage.setItem(desktopNotificationPromptOfferedKey(userId), 'true')
  } catch {
    /* ignore */
  }
}

export async function acceptBrowserNotificationPermissionOffer(userId: string | undefined): Promise<NotificationPermission | null> {
  if (!userId) return null
  if (typeof window === 'undefined' || !('Notification' in window)) return null

  markBrowserNotificationPermissionOffered(userId)

  const permission = await requestBrowserNotificationPermission()
  if (permission === 'granted') {
    const next = { ...loadNotifications(userId), chatMessages: true, desktop: true }
    saveNotifications(userId, next)
  }
  return permission
}

export async function maybeOfferBrowserNotificationPermissionOnce(userId: string | undefined): Promise<NotificationPermission | null> {
  if (!shouldOfferBrowserNotificationPermissionOnce(userId)) {
    if (typeof window === 'undefined' || !('Notification' in window)) return null
    return Notification.permission
  }
  return acceptBrowserNotificationPermissionOffer(userId)
}
