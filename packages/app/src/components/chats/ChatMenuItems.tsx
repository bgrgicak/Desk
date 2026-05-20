import { Pin, PinOff, Trash2 } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@agent-desk/ui'
import { ShowInHomeMenuItem } from '@/components/shared/ShowInHomeMenuItem'
import type { HomePinRef } from '@/hooks/use-home-pins'

interface ChatMenuItemsProps {
  chatId: string
  isPinned?: boolean
  onPin?: (chatId: string) => void
  onUnpin?: (chatId: string) => void
  onDelete: (chatId: string) => void
  /** When provided, adds a "Show in Home" toggle (Favorites). */
  homePin?: HomePinRef
}

export function ChatMenuItems({
  chatId,
  isPinned,
  onPin,
  onUnpin,
  onDelete,
  homePin,
}: ChatMenuItemsProps) {
  return (
    <>
      {(onPin || onUnpin) && (
        <DropdownMenuItem onClick={() => (isPinned ? onUnpin?.(chatId) : onPin?.(chatId))}>
          {isPinned
            ? <><PinOff className="h-4 w-4 mr-2" />Unpin</>
            : <><Pin className="h-4 w-4 mr-2" />Pin</>
          }
        </DropdownMenuItem>
      )}
      {homePin && <ShowInHomeMenuItem pin={homePin} />}
      {(onPin || onUnpin || homePin) && <DropdownMenuSeparator />}
      <DropdownMenuItem onClick={() => onDelete(chatId)}>
        <Trash2 className="h-4 w-4 mr-2" />
        Delete chat
      </DropdownMenuItem>
    </>
  )
}
