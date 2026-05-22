import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import { Bell, Bot, Info, Sliders, User, X } from 'lucide-react'
import {
  useGetMeQuery,
  usePatchMeMutation,
  useChangePasswordMutation,
} from '@/store/api'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  Button,
  Input,
  Switch,
  Alert,
  AlertDescription,
  cn,
} from '@agent-desk/ui'
import { useScrolledUnder } from '@/hooks/use-scrolled-under'
import { useCompactViewport } from '@/hooks/use-compact-viewport'
import { PreferenceRow } from '@/components/settings/shared'
import { ModelsSection } from '@/components/settings/ModelsSection'
import type { ModelsFocus } from '@/router/nav'
import { describeApiError } from '@/components/settings/errors'
import { initialsOf } from '@/lib/initials'
import { useAvatarUrl, saveAvatarUrl, deleteAvatarUrl, resizeToDataUrl } from '@/hooks/use-avatar'
import {
  NOTIFICATIONS_DEFAULTS,
  loadNotifications,
  requestBrowserNotificationPermission,
  saveNotifications,
  type NotificationsShape,
} from '@/lib/account-notifications'

// ── Nav ──────────────────────────────────────────────────────────────────────

export type AccountSection = 'account' | 'models' | 'notifications' | 'preferences'

const NAV: { id: AccountSection; label: string; icon: typeof User }[] = [
  { id: 'account',           label: 'My account',        icon: User    },
  { id: 'models',            label: 'AI providers',      icon: Bot     },
  { id: 'notifications',     label: 'Notifications',     icon: Bell    },
  { id: 'preferences',       label: 'Preferences',       icon: Sliders },
]

// ── User prefs (localStorage) ────────────────────────────────────────────────

interface UserPrefsShape {
  reduceMotion: boolean
  cmdEnterToSend: boolean
  showShortcutHints: boolean
  confirmBeforeDelete: boolean
}

const USER_PREFS_DEFAULTS: UserPrefsShape = {
  reduceMotion: false,
  cmdEnterToSend: false,
  showShortcutHints: true,
  confirmBeforeDelete: true,
}

function userPrefsKey(userId: string): string {
  return `desk.userprefs.${userId}`
}

function loadUserPrefs(userId: string | undefined): UserPrefsShape {
  if (!userId) return USER_PREFS_DEFAULTS
  try {
    const raw = localStorage.getItem(userPrefsKey(userId))
    if (!raw) return USER_PREFS_DEFAULTS
    const parsed = JSON.parse(raw) as Partial<UserPrefsShape>
    return { ...USER_PREFS_DEFAULTS, ...parsed }
  } catch {
    return USER_PREFS_DEFAULTS
  }
}

function saveUserPrefs(userId: string | undefined, value: UserPrefsShape): void {
  if (!userId) return
  try {
    localStorage.setItem(userPrefsKey(userId), JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

// ── Account prefs (language) ─────────────────────────────────────────────────

const LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'ja', label: '日本語' },
]

function accountPrefsKey(userId: string): string {
  return `desk.account.${userId}`
}

function loadLanguage(userId: string | undefined): string {
  if (!userId) return 'en'
  try {
    const raw = localStorage.getItem(accountPrefsKey(userId))
    if (!raw) return 'en'
    const parsed = JSON.parse(raw) as { language?: string }
    return parsed.language ?? 'en'
  } catch {
    return 'en'
  }
}

function saveLanguage(userId: string | undefined, language: string): void {
  if (!userId) return
  try {
    localStorage.setItem(accountPrefsKey(userId), JSON.stringify({ language }))
  } catch {
    /* ignore */
  }
}

// ── Sections ─────────────────────────────────────────────────────────────────

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function AccountSection_() {
  const { data: me } = useGetMeQuery()
  const userId = me?.id
  const avatarUrl = useAvatarUrl(userId)

  // Profile fields
  const [name, setName]       = useState(me?.username ?? '')
  const [email, setEmail]     = useState(me?.email ?? '')
  const [language, setLanguage] = useState<string>(loadLanguage(userId))

  useEffect(() => {
    if (me) {
      setName(me.username)
      setEmail(me.email)
    }
  }, [me])

  useEffect(() => { setLanguage(loadLanguage(userId)) }, [userId])

  const trimmedName  = name.trim()
  const trimmedEmail = email.trim()
  const emailValid   = EMAIL_RX.test(trimmedEmail)

  const isDirty = !!me && (
    trimmedName  !== me.username ||
    trimmedEmail !== me.email
  )

  const [patchMe, { isLoading: savingProfile }] = usePatchMeMutation()

  // Avatar upload
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)

  const onAvatarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !userId) return
    setUploadingAvatar(true)
    try {
      const dataUrl = await resizeToDataUrl(file, 256)
      saveAvatarUrl(userId, dataUrl)
    } catch {
      toast.error('Could not process image')
    } finally {
      setUploadingAvatar(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const onDeleteAvatar = () => {
    if (!userId) return
    deleteAvatarUrl(userId)
  }

  // Password change
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword]         = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changePassword, { isLoading: savingPassword }] = useChangePasswordMutation()

  const passwordMismatch =
    newPassword.length > 0 && confirmPassword.length > 0 && newPassword !== confirmPassword
  const passwordReady =
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    confirmPassword.length > 0 &&
    !passwordMismatch

  const canSave = (isDirty && !!trimmedName && emailValid) || passwordReady
  const isSaving = savingProfile || savingPassword

  const onSave = async () => {
    if (!me) return
    if (isDirty && trimmedName && emailValid) {
      try {
        await patchMe({ username: trimmedName, email: trimmedEmail }).unwrap()
      } catch (err) {
        toast.error('Could not save profile', { description: describeApiError(err) })
        return
      }
    }
    if (passwordReady) {
      try {
        await changePassword({ currentPassword, newPassword }).unwrap()
        setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
        toast.success('Password updated')
      } catch (err) {
        toast.error('Could not update password', { description: describeApiError(err) })
      }
    }
  }

  const detectedTimezone = useMemo<string>(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'
    } catch {
      return 'Unknown'
    }
  }, [])

  const initials = me ? initialsOf(me.username) : '…'
  const { ref: scrollRef, scrolledUnder } = useScrolledUnder()

  return (
    <div className="flex-1 flex w-full min-w-0 max-w-full flex-col min-h-0 overflow-hidden">
      <div ref={scrollRef} className="flex-1 min-w-0 max-w-full overflow-y-auto overflow-x-hidden px-4 pt-3 pb-4">
        {/* Avatar + profile fields side by side */}
        <div className="flex min-w-0 max-w-full flex-col gap-4 sm:flex-row sm:gap-6">
          {/* Left: avatar */}
          <div className="flex shrink-0 flex-col items-center gap-2 sm:items-center">
            <div className="h-24 w-24 rounded-full overflow-hidden bg-muted flex items-center justify-center text-xl font-semibold text-muted-foreground border border-border sm:h-32 sm:w-32 sm:text-2xl">
              {avatarUrl
                ? <img src={avatarUrl} alt={name} className="h-full w-full object-cover" />
                : initials
              }
            </div>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={uploadingAvatar}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadingAvatar ? 'Uploading…' : 'Upload'}
            </Button>
            {avatarUrl && (
              <Button
                size="sm"
                variant="ghost"
                className="w-full text-destructive hover:text-destructive"
                onClick={onDeleteAvatar}
              >
                Delete
              </Button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onAvatarFileChange}
            />
          </div>

          {/* Right: profile fields */}
          <div className="flex-1 min-w-0 max-w-full space-y-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Name</p>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your name"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Agents use your name to address you directly in conversations.
              </p>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Email</p>
              <Input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
              {!emailValid && trimmedEmail.length > 0 && (
                <p className="text-xs text-destructive mt-1">Enter a valid email address.</p>
              )}
              {(emailValid || trimmedEmail.length === 0) && (
                <p className="text-xs text-muted-foreground mt-1">
                  Email changes may require you to sign out and sign back in.
                </p>
              )}
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Language</p>
              <select
                value={language}
                onChange={e => {
                  const next = e.target.value
                  setLanguage(next)
                  saveLanguage(userId, next)
                }}
                className="flex h-9 w-full rounded-md border border-input bg-transparent pl-3 pr-8 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20fill%3D%22none%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22M4%206l4%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.5rem_center]"
              >
                {LANGUAGE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Timezone</p>
              <div className="flex h-9 w-full items-center rounded-md border border-input bg-muted/40 px-3 text-sm text-muted-foreground">
                {detectedTimezone}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Detected automatically and synced with the server on each request.
              </p>
            </div>

            {/* Password change */}
            <div className="pt-5 border-t space-y-4">
              <p className="text-sm font-medium">Change password</p>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Current password</p>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={e => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">New password</p>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Confirm new password</p>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
                {passwordMismatch && (
                  <p className="text-xs text-destructive mt-1">New passwords don't match.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className={cn(
          'shrink-0 p-4 flex items-center justify-end gap-2 border-t border-transparent',
          scrolledUnder && 'border-border',
        )}
      >
        <Button
          size="sm"
          disabled={!canSave || isSaving}
          onClick={onSave}
        >
          {isSaving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  )
}

function NotificationsSection() {
  const { data: me } = useGetMeQuery()
  const userId = me?.id
  const [prefs, setPrefs] = useState<NotificationsShape>(NOTIFICATIONS_DEFAULTS)
  useEffect(() => { setPrefs(loadNotifications(userId)) }, [userId])

  const update = (patch: Partial<NotificationsShape>): void => {
    setPrefs(prev => {
      const next = { ...prev, ...patch }
      saveNotifications(userId, next)
      return next
    })
  }

  return (
    <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-y-auto overflow-x-hidden px-4 pt-3 pb-6">
      <Alert className="mb-4">
        <Info className="h-4 w-4" />
        <AlertDescription>Notification preferences are saved on this device.</AlertDescription>
      </Alert>
      <div className="flex flex-col">
        <PreferenceRow
          title="New chat messages"
          description="Notify me when an agent posts a new message in a chat I'm in."
        >
          <Switch checked={prefs.chatMessages} onCheckedChange={v => update({ chatMessages: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Mentions"
          description="Notify me when I'm @-mentioned in chats or comments."
        >
          <Switch checked={prefs.mentions} onCheckedChange={v => update({ mentions: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Task assignments and status changes"
          description="Notify me when a task is assigned to me or its status changes."
        >
          <Switch checked={prefs.taskUpdates} onCheckedChange={v => update({ taskUpdates: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Run completion"
          description="Notify me when a scheduled run finishes — both successes and failures."
        >
          <Switch checked={prefs.runCompletion} onCheckedChange={v => update({ runCompletion: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Connection issues"
          description="Notify me when an MCP or provider connection breaks."
        >
          <Switch checked={prefs.connectionIssues} onCheckedChange={v => update({ connectionIssues: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Comments on artifacts"
          description="Notify me when someone comments on a doc, app, image, or other artifact I created."
        >
          <Switch checked={prefs.artifactComments} onCheckedChange={v => update({ artifactComments: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Workspace invitations"
          description="Notify me when I'm added to a workspace."
        >
          <Switch checked={prefs.workspaceInvitations} onCheckedChange={v => update({ workspaceInvitations: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Daily email digest"
          description="A daily summary of activity across your workspaces, by email."
        >
          <Switch checked={prefs.emailDigest} onCheckedChange={v => update({ emailDigest: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Sounds"
          description="Play a sound for new notifications."
        >
          <Switch checked={prefs.sounds} onCheckedChange={v => update({ sounds: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Desktop notifications"
          description="Show browser notifications when a chat gets the sidebar new-message dot."
        >
          <Switch checked={prefs.desktop} onCheckedChange={v => {
            if (!v) {
              update({ desktop: false })
              return
            }
            void requestBrowserNotificationPermission().then(permission => {
              update({ desktop: permission === 'granted' })
            })
          }} />
        </PreferenceRow>
      </div>
    </div>
  )
}

function PreferencesSection() {
  const { data: me } = useGetMeQuery()
  const userId = me?.id
  const [prefs, setPrefs] = useState<UserPrefsShape>(USER_PREFS_DEFAULTS)
  useEffect(() => { setPrefs(loadUserPrefs(userId)) }, [userId])

  const update = (patch: Partial<UserPrefsShape>): void => {
    setPrefs(prev => {
      const next = { ...prev, ...patch }
      saveUserPrefs(userId, next)
      return next
    })
  }

  return (
    <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-y-auto overflow-x-hidden px-4 pt-3 pb-6">
      <div className="flex flex-col">
        <PreferenceRow
          title="Reduce motion"
          description="Minimize animations and transitions."
        >
          <Switch checked={prefs.reduceMotion} onCheckedChange={v => update({ reduceMotion: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Send messages with ⌘+Enter"
          description="Use ⌘+Enter to send. Plain Enter inserts a newline."
        >
          <Switch checked={prefs.cmdEnterToSend} onCheckedChange={v => update({ cmdEnterToSend: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Show keyboard shortcut hints"
          description="Display ⌘K and other shortcut chips in the UI."
        >
          <Switch checked={prefs.showShortcutHints} onCheckedChange={v => update({ showShortcutHints: v })} />
        </PreferenceRow>
        <PreferenceRow
          title="Confirm before deleting"
          description="Always show a confirmation dialog before destructive actions."
        >
          <Switch checked={prefs.confirmBeforeDelete} onCheckedChange={v => update({ confirmBeforeDelete: v })} />
        </PreferenceRow>
      </div>
    </div>
  )
}

// ── Main modal ───────────────────────────────────────────────────────────────

interface MyAccountModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Active account section. Controlled so the URL is the source of truth. */
  activeSection: AccountSection
  onChangeSection: (next: AccountSection) => void
  /** Models sub-state (new / edit). Forwarded to ModelsSection. */
  modelsFocus: ModelsFocus
  onChangeModelsFocus: (next: ModelsFocus) => void
}

export function MyAccountModal({
  open,
  onOpenChange,
  activeSection,
  onChangeSection,
  modelsFocus,
  onChangeModelsFocus,
}: MyAccountModalProps) {
  const { data: me } = useGetMeQuery()
  const setActiveSection = onChangeSection
  const avatarUrl = useAvatarUrl(me?.id)
  const isCompactViewport = useCompactViewport()

  const account = me
    ? { name: me.username, email: me.email, initials: initialsOf(me.username) }
    : { name: '…', email: '', initials: '…' }

  const activeLabel = NAV.find(n => n.id === activeSection)?.label ?? ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] p-0 gap-0 sm:max-w-[900px] overflow-hidden"
        showCloseButton={false}
        style={{ height: 'min(620px, calc(100dvh - 1rem))' }}
      >
        <DialogTitle className="sr-only">My account</DialogTitle>
        <Button
          variant="ghost"
          size="icon"
          className={cn('absolute right-3 top-3 z-20 h-7 w-7 text-muted-foreground', !isCompactViewport && 'hidden')}
          onClick={() => onOpenChange(false)}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </Button>

        <div className={cn('flex h-full min-h-0 min-w-0 overflow-hidden', isCompactViewport ? 'flex-col' : 'flex-row')}>
          {/* Left nav */}
          <div className={cn('shrink-0 flex flex-col bg-muted/30', isCompactViewport ? 'w-full border-b' : 'h-full w-52 border-r')}>
            <div className={cn('px-4', isCompactViewport ? 'pt-4 pb-2 pr-12' : 'pt-5 pb-3 pr-4')}>
              <div className="flex items-center gap-2">
                <div className={cn('flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold overflow-hidden', isCompactViewport ? 'h-7 w-7' : 'h-8 w-8')}>
                  {avatarUrl
                    ? <img src={avatarUrl} alt={account.name} className="h-full w-full object-cover" />
                    : account.initials
                  }
                </div>
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium truncate">{account.name}</span>
                  <span className="text-xs text-muted-foreground truncate">{account.email}</span>
                </div>
              </div>
            </div>

            <nav className={cn('flex gap-1 px-2', isCompactViewport ? 'overflow-x-auto pb-2' : 'flex-1 flex-col gap-0 space-y-0.5 overflow-x-visible pb-0')}>
              {NAV.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveSection(id)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                    isCompactViewport ? 'shrink-0' : 'w-full shrink',
                    activeSection === id
                      ? 'bg-muted text-foreground font-medium'
                      : 'text-foreground/70 hover:text-foreground hover:bg-muted/60',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </button>
              ))}
            </nav>
          </div>

          {/* Right content */}
          <div className={cn('flex w-full flex-1 flex-col min-w-0 min-h-0 overflow-hidden', !isCompactViewport && 'w-auto')}>
            <div className={cn('min-h-[52px] items-center justify-between gap-3 border-b px-4 shrink-0', isCompactViewport ? 'hidden' : 'flex')}>
              <Breadcrumb className="min-w-0">
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage className="text-sm font-semibold text-foreground">
                      {activeLabel}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground shrink-0"
                onClick={() => onOpenChange(false)}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <motion.div
              key={activeSection}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="flex-1 flex w-full min-w-0 max-w-full flex-col min-h-0 overflow-hidden"
            >
              {activeSection === 'account'           && <AccountSection_ />}
              {activeSection === 'models'            && (
                <ModelsSection focus={modelsFocus} onChangeFocus={onChangeModelsFocus} />
              )}
              {activeSection === 'notifications'     && <NotificationsSection />}
              {activeSection === 'preferences'       && <PreferencesSection />}
            </motion.div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
