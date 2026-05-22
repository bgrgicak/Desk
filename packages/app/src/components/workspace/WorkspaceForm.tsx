import { useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button, Input, Textarea, cn } from '@agent-desk/ui'
import { ROOM_PALETTE } from '@/components/rooms/palette'
import { roomColor } from '@/components/rooms/roomColor'
import { initialsOf } from '@/lib/initials'
import { resizeToDataUrl } from '@/hooks/use-avatar'
import {
  useWorkspaceIconUrl,
  saveWorkspaceIconUrl,
  deleteWorkspaceIconUrl,
} from '@/hooks/use-workspace-icon'
import { useScrolledUnder } from '@/hooks/use-scrolled-under'

export interface WorkspaceFormValues {
  name: string
  description: string
  color: string
}

interface WorkspaceFormProps {
  mode: 'create' | 'edit'
  /** Edit mode: the workspace whose icon is persisted immediately. */
  workspaceId?: string
  initial: WorkspaceFormValues
  submitLabel: string
  busy?: boolean
  /** Persist name/description/color. Return the workspace id so a
   *  freshly-created room can have its pending icon attached. */
  onSubmit: (values: WorkspaceFormValues) => Promise<string | undefined>
  /** Called after a successful submit (and icon attach) — close /
   *  navigate. */
  onDone?: () => void
  /** Left-aligned footer slot (e.g. the settings panel's Delete). */
  footerStart?: ReactNode
}

/**
 * Shared room (workspace) editor — same layout as the My account tab:
 * a round avatar with Upload / Delete on the left, labelled fields with
 * helper text on the right, and a sticky Save footer. Used by both the
 * Home "create room" modal and the Settings → Workspace panel so they
 * stay identical.
 */
export function WorkspaceForm({
  mode,
  workspaceId,
  initial,
  submitLabel,
  busy = false,
  onSubmit,
  onDone,
  footerStart,
}: WorkspaceFormProps) {
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [color, setColor] = useState(initial.color)

  // Edit mode reads/writes the icon store live; create mode holds a
  // pending data-URL and attaches it once the room id exists.
  const persistedIcon = useWorkspaceIconUrl(workspaceId)
  const [pendingIcon, setPendingIcon] = useState<string | null>(null)
  const iconUrl = mode === 'edit' ? persistedIcon : pendingIcon

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const { ref: scrollRef, scrolledUnder } = useScrolledUnder()

  const onIconFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const dataUrl = await resizeToDataUrl(file, 256)
      if (mode === 'edit' && workspaceId) saveWorkspaceIconUrl(workspaceId, dataUrl)
      else setPendingIcon(dataUrl)
    } catch {
      toast.error('Could not process image')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const onDeleteIcon = () => {
    if (mode === 'edit' && workspaceId) deleteWorkspaceIconUrl(workspaceId)
    else setPendingIcon(null)
  }

  const trimmedName = name.trim()
  const canSave = trimmedName.length > 0 && !busy && !uploading

  const handleSubmit = async () => {
    if (!canSave) return
    const id = await onSubmit({
      name: trimmedName,
      description: description.trim(),
      color,
    })
    if (mode === 'create' && id && pendingIcon) {
      saveWorkspaceIconUrl(id, pendingIcon)
    }
    onDone?.()
  }

  const tint = roomColor(color)

  return (
    <div className="flex-1 flex w-full min-w-0 max-w-full flex-col min-h-0 overflow-hidden">
      <div ref={scrollRef} className="flex-1 min-w-0 max-w-full overflow-y-auto overflow-x-hidden px-4 pt-2 pb-4">
        <div className="flex min-w-0 max-w-full flex-col gap-4 sm:flex-row sm:gap-6">
          {/* Left: room avatar */}
          <div className="flex shrink-0 flex-col items-center gap-2">
            <div
              className="h-24 w-24 overflow-hidden rounded-full border border-border flex items-center justify-center text-xl font-semibold text-white sm:h-32 sm:w-32 sm:text-2xl select-none"
              style={iconUrl ? undefined : { backgroundColor: tint }}
            >
              {iconUrl
                ? <img src={iconUrl} alt={trimmedName || 'Room'} className="h-full w-full object-cover" />
                : initialsOf(trimmedName || 'Room')}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
            {iconUrl && (
              <Button
                size="sm"
                variant="ghost"
                className="w-full text-destructive hover:text-destructive"
                onClick={onDeleteIcon}
              >
                Delete
              </Button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onIconFile}
            />
          </div>

          {/* Right: fields */}
          <div className="flex-1 min-w-0 max-w-full space-y-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Name</p>
              <Input
                autoFocus={mode === 'create'}
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Marketing"
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); void handleSubmit() }
                }}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Shown in the room switcher and breadcrumb, and how agents refer to this room.
              </p>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Description</p>
              <Textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={2}
                className="resize-none"
                placeholder="What this room is for…"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Optional. Given to agents as standing context for every chat and task in this room.
              </p>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Accent</p>
              <div className="flex min-w-0 flex-wrap gap-2">
                {ROOM_PALETTE.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    title={label}
                    onClick={() => setColor(value)}
                    className={cn(
                      'h-6 w-6 rounded-full transition-all',
                      color === value
                        ? 'ring-2 ring-offset-2 ring-foreground/40 scale-110'
                        : 'hover:scale-110',
                    )}
                    style={{ backgroundColor: value }}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Tints this room's dot, breadcrumb and avatar so you can tell rooms apart at a glance.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div
        className={cn(
          'shrink-0 p-4 flex items-center gap-2 border-t border-transparent',
          footerStart ? 'justify-between' : 'justify-end',
          scrolledUnder && 'border-border',
        )}
      >
        {footerStart}
        <Button size="sm" disabled={!canSave} onClick={() => void handleSubmit()}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </div>
  )
}
