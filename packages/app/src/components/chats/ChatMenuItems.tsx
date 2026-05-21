import { Pin, PinOff, Trash2 } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@agent-desk/ui'

interface ChatMenuItemsProps {
  chatId: string
  isPinned?: boolean
  onPin?: (chatId: string) => void
  onUnpin?: (chatId: string) => void
  onDelete: (chatId: string) => void
}

export function ChatMenuItems({ chatId, isPinned, onPin, onUnpin, onDelete }: ChatMenuItemsProps) {
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
      {(onPin || onUnpin) && <DropdownMenuSeparator />}
      <DropdownMenuItem onClick={() => onDelete(chatId)}>
        <Trash2 className="h-4 w-4 mr-2" />
        Delete chat
      </DropdownMenuItem>
    </>
  )
}
