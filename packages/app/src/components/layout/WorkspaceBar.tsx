import { useState, useEffect } from 'react'
import { Reorder } from 'framer-motion'
import { Link } from 'react-router-dom'
import {
  Inbox, Sun, Moon, Search, Sparkles,
  HelpCircle, LogOut, Monitor, Check, Settings2,
  Plus, Columns2, Pencil, Trash2,
} from 'lucide-react'
import { useTheme } from '@/hooks/use-theme'
import { initialsOf } from '@/lib/initials'
import { useAvatarUrl } from '@/hooks/use-avatar'
import { useGlobalPalette } from '@/components/global-palette/GlobalPaletteProvider'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Input,
  Textarea,
  Button,
} from '@agent-desk/ui'
import { useCreateWorkspaceMutation, useDeleteWorkspaceMutation, useGetMeQuery, usePatchWorkspaceMutation } from '@/store/api'
import { logout } from '@/auth/session'
import type { View } from './AppShell'

// ── Logo ──────────────────────────────────────────────────────────────────────
function DeskLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 58 21"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Desk"
    >
      <path d="M47.3203 0C47.919 0 48.3184 0.499147 48.3184 0.998047C48.3178 1.69716 46.6553 4.79062 46.6553 11.9736C46.6553 14.0024 46.9877 15.7653 47.3535 17.0957C48.6839 13.9694 50.3473 12.0071 54.2051 10.0781C54.3381 10.0116 54.4383 9.97755 54.6045 9.97754C55.1034 9.97754 55.6357 10.377 55.6357 10.9756C55.6357 11.3082 55.4693 11.6081 55.1699 11.8076C55.0021 11.9083 53.3076 12.9728 53.3076 15.2998C53.3078 17.9932 56.599 18.9244 56.8994 18.9912C57.2985 19.1243 57.6309 19.4904 57.6309 19.9561C57.6308 20.5545 57.1325 20.9539 56.6338 20.9541C56.4675 20.9541 51.3117 19.9892 51.3115 15.2998C51.3115 14.9672 51.3447 14.5677 51.3779 14.3682C50.0145 15.765 49.2829 17.3948 48.252 20.2881C48.1189 20.6872 47.7194 20.9541 47.3203 20.9541C46.8883 20.9539 46.5891 20.6546 46.4561 20.4219C46.3895 20.2556 44.6602 16.8628 44.6602 11.9736C44.6602 9.37935 44.9263 7.0507 45.1924 5.3877C43.1303 7.78242 40.8021 10.1779 38.873 12.373C39.3718 13.2377 39.6709 14.2689 39.6709 15.2998C39.6708 17.2954 38.7728 20.9537 36.0127 20.9541C34.2167 20.9541 33.3516 19.3236 33.3516 17.96C33.3517 16.1973 34.6488 14.4016 36.2451 12.4395C35.8127 12.1401 35.2803 11.9736 34.6816 11.9736C31.9211 11.9738 29.0937 14.6348 27.3975 16.3311C25.801 17.9276 23.0076 20.9538 20.0479 20.9541C20.0464 20.9541 20.0445 20.9531 20.043 20.9531L20.04 20.9541C16.2485 20.9541 12.3898 19.2575 12.3896 15.2998C12.3896 12.506 14.4188 9.97754 17.3789 9.97754C19.2414 9.97758 20.705 11.4413 20.7051 13.3037C20.7051 15.5987 18.8754 17.561 16.9131 18.459C17.8111 18.7916 18.9425 18.958 20.04 18.958H20.0479C21.7441 18.9576 24.2716 16.663 26.001 14.9336C27.6307 13.3039 30.7903 9.97766 34.6816 9.97754C35.7459 9.97754 36.7106 10.3438 37.5088 10.9092C40.5354 7.45019 44.4936 3.55898 46.4893 0.46582C46.6887 0.166587 46.9879 0.000116897 47.3203 0ZM5.98633 0.332031C9.27907 0.332031 13.3037 2.49443 13.3037 6.31934C13.3037 10.5433 10.077 13.171 7.2832 15.3994C5.62029 16.7297 3.95717 18.0604 2.69336 19.3242C2.49386 19.5236 2.26108 19.623 1.99512 19.623C1.46314 19.623 0.997336 19.1579 0.99707 18.626C0.99707 18.3599 1.09731 18.1263 1.29688 17.9268C2.69375 16.5299 4.35662 15.1995 6.01953 13.8691C8.87988 11.5742 11.3076 9.4125 11.3076 6.31934C11.3076 4.15743 8.68039 2.32812 5.98633 2.32812C3.95752 2.32814 3.42577 2.89392 2.86035 3.8252C2.36148 4.65677 1.99512 6.71889 1.99512 8.98047C1.99513 11.2752 2.12864 13.603 2.29492 14.4346C2.29492 14.5011 2.32812 14.5682 2.32812 14.6348C2.32789 15.1335 1.92853 15.6318 1.33008 15.6318C0.864457 15.6318 0.465035 15.2996 0.365234 14.834C0.132426 13.6699 1.34625e-05 11.3418 0 8.98047C0 4.09127 0.964121 0.332064 5.98633 0.332031ZM37.4756 14.0693C36.0791 15.8317 35.3469 17.2946 35.3467 17.96C35.3467 18.7249 35.6801 18.958 36.0127 18.958C36.5782 18.9571 37.6747 17.2948 37.6748 15.2998C37.6748 14.8676 37.6085 14.4351 37.4756 14.0693ZM17.3789 11.9736C15.6826 11.9736 14.3857 13.4372 14.3857 15.2998C14.3858 15.9981 14.5513 16.5306 14.8506 16.9629C16.6466 16.8631 18.709 14.9002 18.709 13.3037C18.7089 12.5056 18.177 11.9737 17.3789 11.9736Z" />
    </svg>
  )
}

// ── Account fallback while /me is loading ────────────────────────────────────
const ACCOUNT_PLACEHOLDER = {
  name: '…',
  email: '',
  initials: '…',
}

// ── New workspace form options ────────────────────────────────────────────────
const EMOJI_OPTIONS = [
  '🏡','💼','🎨','📚','🚀','💡','🌿','⚡',
  '🎯','🔬','💻','🎵','🌍','⭐','🏆','🔒',
  '🌊','🦋','🍀','🔥','🧠','🌸','🎭','🐝',
]

const COLOR_OPTIONS = [
  { value: '#fef3c7', label: 'Amber'  },
  { value: '#dbeafe', label: 'Blue'   },
  { value: '#fce7f3', label: 'Pink'   },
  { value: '#d1fae5', label: 'Green'  },
  { value: '#ede9fe', label: 'Purple' },
  { value: '#ffedd5', label: 'Orange' },
  { value: '#fee2e2', label: 'Red'    },
  { value: '#ccfbf1', label: 'Teal'   },
]

// ── Types ─────────────────────────────────────────────────────────────────────
export interface WorkspaceInfo {
  id: string
  name: string
  emoji: string
  bg: string
  description: string
  unreadCount: number
}

export type WorkspaceNavView = Extract<View, 'pinned' | 'desk' | 'tasks' | 'context'>

interface WorkspaceBarProps {
  workspaces: WorkspaceInfo[]
  activeWorkspaceId: string
  isGlobalToday: boolean
  todayUnreadCount: number
  onGlobalToday: () => void
  onSelectWorkspace: (id: string) => void
  getWorkspaceHref?: (id: string) => string
  onSignOut?: () => void
  onOpenMyAccount?: () => void
}

// ── Component ─────────────────────────────────────────────────────────────────
export function WorkspaceBar({
  workspaces,
  activeWorkspaceId,
  isGlobalToday,
  todayUnreadCount,
  onGlobalToday,
  onSelectWorkspace,
  getWorkspaceHref,
  onSignOut,
  onOpenMyAccount,
}: WorkspaceBarProps) {
  // Current user — fetched once on mount via RTK Query. Falls back to a
  // placeholder while in-flight so the initial render is stable.
  const { data: me } = useGetMeQuery()
  const [createWorkspaceMutation, { isLoading: isCreating }] =
    useCreateWorkspaceMutation()
  const [patchWorkspaceMutation, { isLoading: isPatching }] =
    usePatchWorkspaceMutation()
  const [deleteWorkspaceMutation] =
    useDeleteWorkspaceMutation()
  const account = me
    ? { name: me.username, email: me.email, initials: initialsOf(me.username) }
    : ACCOUNT_PLACEHOLDER
  const avatarUrl = useAvatarUrl(me?.id)

  const { open: openGlobalPalette } = useGlobalPalette()

  const [pendingDeleteWorkspaceId, setPendingDeleteWorkspaceId] = useState<string | null>(null)

  // Theme — single source of truth in `useTheme`. The Sun/Moon button
  // flips between explicit light/dark; the Preferences tab also exposes a
  // 'system' option.
  const { theme, setTheme } = useTheme()

  // Ordered workspaces (drag-to-reorder). We preserve any client-side
  // reordering the user has already done, but fold in new server-side
  // entries + drop removed ones so workspaces created via the API or in
  // another tab appear without a reload.
  const [orderedWorkspaces, setOrderedWorkspaces] = useState<WorkspaceInfo[]>(workspaces)
  useEffect(() => {
    setOrderedWorkspaces(prev => {
      const byId = new Map(workspaces.map(w => [w.id, w]))
      const kept = prev
        .filter(w => byId.has(w.id))
        .map(w => byId.get(w.id)!)
      const keptIds = new Set(kept.map(w => w.id))
      const added = workspaces.filter(w => !keptIds.has(w.id))
      return [...kept, ...added]
    })
  }, [workspaces])

  // New / edit workspace modal
  const [createOpen, setCreateOpen] = useState(false)
  const [editingWorkspace, setEditingWorkspace] = useState<WorkspaceInfo | null>(null)
  const [newName, setNewName]               = useState('')
  const [newEmoji, setNewEmoji]             = useState('🏢')
  const [newColor, setNewColor]             = useState('#dbeafe')
  const [newDescription, setNewDescription] = useState('')

  const resetForm = () => {
    setNewName(''); setNewEmoji('🏢'); setNewColor('#dbeafe'); setNewDescription('')
    setEditingWorkspace(null)
  }

  const startEditing = (ws: WorkspaceInfo) => {
    setEditingWorkspace(ws)
    setNewName(ws.name)
    setNewEmoji(ws.emoji)
    setNewColor(ws.bg)
    setNewDescription(ws.description)
    setCreateOpen(true)
  }

  const deleteWorkspace = async (wsId: string) => {
    try {
      await deleteWorkspaceMutation(wsId).unwrap()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('delete workspace failed:', err)
    }
  }

  return (
    <>
      <div className="h-[51px] shrink-0 flex items-center relative z-50 overflow-hidden pr-4" style={{ paddingLeft: 'calc(var(--spacing) * 2)' }}>

        {/* ── Centered logo ── */}
        <div className="pointer-events-none absolute inset-0 hidden items-center justify-center -mt-0.5 md:flex">
          <DeskLogo className="h-[20px] w-auto text-foreground" />
        </div>

        {/* ── Global Today ── */}
        <button
          onClick={onGlobalToday}
          className="relative flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors text-foreground/70 hover:text-foreground hover:bg-background/40"
        >
          <Inbox className="h-4 w-4 shrink-0" />
          Inbox
          {todayUnreadCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-background border border-border/70 px-1.5 text-xs font-medium text-foreground">
              {todayUnreadCount}
            </span>
          )}
        </button>

        <Reorder.Group
          as="div"
          axis="x"
          values={orderedWorkspaces}
          onReorder={setOrderedWorkspaces}
          className="flex min-w-0 flex-1 items-center gap-1 group/ws ml-1 overflow-x-auto overflow-y-hidden"
        >
          {orderedWorkspaces.map(ws => {
            const isActive = !isGlobalToday && ws.id === activeWorkspaceId
            return (
              <Reorder.Item
                as="div"
                key={ws.id}
                value={ws}
                className="flex items-center"
                style={{ listStyle: 'none' }}
                dragListener={true}
                dragElastic={0.1}
              >
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <Link
                      to={getWorkspaceHref?.(ws.id) ?? `/w/${ws.id}/pinned`}
                      onClick={(event) => {
                        if (
                          event.defaultPrevented ||
                          event.button !== 0 ||
                          event.metaKey ||
                          event.altKey ||
                          event.ctrlKey ||
                          event.shiftKey
                        ) return
                        event.preventDefault()
                        onSelectWorkspace(ws.id)
                      }}
                      data-testid={`workspace-tab-${ws.id}`}
                      className={`relative flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors cursor-pointer select-none ${
                        isActive
                          ? 'bg-background/60 text-foreground'
                          : 'text-foreground/70 hover:text-foreground hover:bg-background/40'
                      }`}
                    >
                      <span className="text-base leading-none">{ws.emoji}</span>
                      <span>{ws.name.length > 16 ? ws.name.slice(0, 16) + '…' : ws.name}</span>
                      {ws.unreadCount > 0 && (
                        <span className={`flex h-5 min-w-5 items-center justify-center rounded-full border px-1.5 text-xs font-medium ${
                          isActive
                            ? 'bg-muted border-transparent text-muted-foreground'
                            : 'bg-background border-border/70 text-foreground'
                        }`}>
                          {ws.unreadCount}
                        </span>
                      )}
                    </Link>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-48">
                    <ContextMenuItem onSelect={() => onSelectWorkspace(ws.id)}>
                      <Columns2 className="h-4 w-4" />
                      Open in split view
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => startEditing(ws)}>
                      <Pencil className="h-4 w-4" />
                      Customize
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => setPendingDeleteWorkspaceId(ws.id)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </Reorder.Item>
            )
          })}

          {/* Add workspace — ghost icon button, revealed on hover of the tabs area */}
          <div className="flex items-center self-stretch mx-0.5 opacity-0 group-hover/ws:opacity-100 transition-opacity">
            <button
              onClick={() => setCreateOpen(true)}
              title="New workspace"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/40 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </Reorder.Group>

        {/* ── Right-side controls ── */}
        <div className="ml-auto flex items-center gap-1 shrink-0">

          {/* Global search · Ask AI */}
          <button
            onClick={() => openGlobalPalette()}
            aria-label="Search · Ask AI"
            className="relative flex items-center justify-center rounded-md h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-background/40 transition-colors"
            title="Search · Ask AI (⌘K)"
          >
            <Search className="h-4 w-4" />
            <Sparkles className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 text-primary" aria-hidden="true" />
          </button>

          {/* Help */}
          <button
            className="flex items-center justify-center rounded-md h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-background/40 transition-colors"
            title="Help"
          >
            <HelpCircle className="h-4 w-4" />
          </button>

          {/* User avatar */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                {...(me ? { 'data-testid': 'account-avatar' } : {})}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-muted border border-border text-[11px] font-semibold text-muted-foreground hover:bg-muted/70 transition-colors ml-0.5 overflow-hidden"
              >
                {avatarUrl
                  ? <img src={avatarUrl} alt={account.name} className="h-full w-full object-cover" />
                  : account.initials
                }
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem
                onSelect={onOpenMyAccount}
                data-testid="open-my-account"
                className="flex items-center gap-2.5 p-2.5 group/header rounded-none"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold overflow-hidden">
                  {avatarUrl
                    ? <img src={avatarUrl} alt={account.name} className="h-full w-full object-cover" />
                    : account.initials
                  }
                </div>
                <div className="flex min-w-0 flex-col flex-1">
                  <span className="text-sm font-medium truncate">{account.name}</span>
                  <span className="text-xs text-muted-foreground truncate">{account.email}</span>
                </div>
                <Settings2 className="h-4 w-4 shrink-0 opacity-0 group-hover/header:opacity-60 transition-opacity" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Theme</DropdownMenuLabel>
                <DropdownMenuItem onSelect={e => { e.preventDefault(); setTheme('light') }}>
                  <Sun className="h-4 w-4" />Light
                  {theme === 'light' && <Check className="h-4 w-4 ml-auto text-foreground" />}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={e => { e.preventDefault(); setTheme('dark') }}>
                  <Moon className="h-4 w-4" />Dark
                  {theme === 'dark' && <Check className="h-4 w-4 ml-auto text-foreground" />}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={e => { e.preventDefault(); setTheme('system') }}>
                  <Monitor className="h-4 w-4" />System
                  {theme === 'system' && <Check className="h-4 w-4 ml-auto text-foreground" />}
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onSignOut ?? (() => void logout())}
                data-testid="sign-out-button"
              >
                <LogOut className="h-4 w-4" />Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Create / edit workspace modal ── */}
      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) resetForm() }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingWorkspace ? 'Edit workspace' : 'New workspace'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-5 py-1">

            {/* Preview + Name */}
            <div className="flex items-center gap-3">
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-2xl select-none"
                style={{ backgroundColor: newColor }}
              >
                {newEmoji}
              </div>
              <Input
                placeholder="Workspace name"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                className="flex-1"
                autoFocus
              />
            </div>

            {/* Color swatches */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Color</p>
              <div className="flex gap-2 flex-wrap">
                {COLOR_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    title={label}
                    onClick={() => setNewColor(value)}
                    className={`h-6 w-6 rounded-full transition-all ${
                      newColor === value ? 'ring-2 ring-offset-2 ring-foreground/40 scale-110' : 'hover:scale-110'
                    }`}
                    style={{ backgroundColor: value }}
                  />
                ))}
              </div>
            </div>

            {/* Emoji picker */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Icon</p>
              <div className="grid grid-cols-8 gap-1">
                {EMOJI_OPTIONS.map(emoji => (
                  <button
                    key={emoji}
                    onClick={() => setNewEmoji(emoji)}
                    className={`flex items-center justify-center h-8 w-8 rounded-md text-lg transition-colors ${
                      newEmoji === emoji
                        ? 'bg-muted ring-1 ring-ring/40'
                        : 'hover:bg-muted'
                    }`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>

            {/* Description */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Description</p>
              <Textarea
                placeholder="What's this workspace for?"
                value={newDescription}
                onChange={e => setNewDescription(e.target.value)}
                rows={2}
                className="resize-none"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateOpen(false); resetForm() }}>
              Cancel
            </Button>
            <Button
              disabled={!newName.trim() || isCreating || isPatching}
              onClick={async () => {
                if (editingWorkspace) {
                  try {
                    await patchWorkspaceMutation({
                      id: editingWorkspace.id,
                      patch: {
                        name: newName.trim(),
                        description: newDescription,
                        icon: newEmoji,
                        color: newColor,
                      },
                    }).unwrap()
                  } catch (err) {
                    // eslint-disable-next-line no-console
                    console.error('patch workspace failed:', err)
                  }
                  setCreateOpen(false)
                  resetForm()
                  return
                }
                try {
                  const created = await createWorkspaceMutation({
                    name: newName.trim(),
                    description: newDescription,
                    icon: newEmoji,
                    color: newColor,
                  }).unwrap()
                  setCreateOpen(false)
                  resetForm()
                  onSelectWorkspace(created.id)
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error('create workspace failed:', err)
                }
              }}
            >
              {editingWorkspace ? 'Save changes' : 'Create workspace'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDeleteWorkspaceId !== null}
        onOpenChange={open => { if (!open) setPendingDeleteWorkspaceId(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the workspace and all its content. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDeleteWorkspaceId) deleteWorkspace(pendingDeleteWorkspaceId)
                setPendingDeleteWorkspaceId(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
