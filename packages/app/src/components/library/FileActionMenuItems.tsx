import {
  Download,
  FolderPlus,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@agent-desk/ui'
import { ShowInHomeMenuItem } from '@/components/shared/ShowInHomeMenuItem'
import type { HomePinRef } from '@/hooks/use-home-pins'

/**
 * The canonical file context-menu (kebab) items, shared by the
 * Library list rows (`LibraryCard`) and the Library file-detail view
 * (`ContextDetail`) so both menus are identical — same items, order,
 * icons, and the separator before Delete.
 *
 * Purely handler-driven: each item renders only when its handler is
 * provided. Callers omit an action by passing `undefined` (e.g. the
 * file-detail view skips Download for non-file/note types, Rename for
 * notes). Render this inside the surface's own `DropdownMenuContent`
 * so each keeps its distinct trigger / test-id.
 */
export interface FileActionMenuItemsProps {
  onUseInChat?: () => void
  isPinned?: boolean
  onPin?: () => void
  onUnpin?: () => void
  onDownload?: () => void
  onRename?: () => void
  onMove?: () => void
  /** When provided, adds a "Show in Home" toggle (Favorites). */
  homePin?: HomePinRef
  onDelete?: () => void
}

export function FileActionMenuItems({
  onUseInChat,
  isPinned,
  onPin,
  onUnpin,
  onDownload,
  onRename,
  onMove,
  homePin,
  onDelete,
}: FileActionMenuItemsProps) {
  return (
    <>
      {onUseInChat && (
        <DropdownMenuItem onClick={onUseInChat}>
          <MessageSquarePlus className="h-4 w-4 mr-2" />
          Use in chat
        </DropdownMenuItem>
      )}
      {(onPin || onUnpin) && (
        <DropdownMenuItem onClick={isPinned ? onUnpin : onPin}>
          {isPinned
            ? <><PinOff className="h-4 w-4 mr-2" />Unpin</>
            : <><Pin className="h-4 w-4 mr-2" />Pin</>
          }
        </DropdownMenuItem>
      )}
      {onDownload && (
        <DropdownMenuItem onClick={onDownload}>
          <Download className="h-4 w-4 mr-2" />
          Download
        </DropdownMenuItem>
      )}
      {onRename && (
        <DropdownMenuItem onClick={onRename}>
          <Pencil className="h-4 w-4 mr-2" />
          Rename
        </DropdownMenuItem>
      )}
      {onMove && (
        <DropdownMenuItem onClick={onMove}>
          <FolderPlus className="h-4 w-4 mr-2" />
          Move to folder
        </DropdownMenuItem>
      )}
      {homePin && <ShowInHomeMenuItem pin={homePin} />}
      {onDelete && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}
