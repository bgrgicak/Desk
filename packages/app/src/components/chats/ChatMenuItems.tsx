import { Trash2 } from 'lucide-react'
import { DropdownMenuItem } from '@agent-desk/ui'

interface ChatMenuItemsProps {
  chatId: string
  onDelete: (chatId: string) => void
}

export function ChatMenuItems({ chatId, onDelete }: ChatMenuItemsProps) {
  return (
    <DropdownMenuItem onClick={() => onDelete(chatId)}>
      <Trash2 className="h-4 w-4 mr-2" />
      Delete chat
    </DropdownMenuItem>
  )
}
