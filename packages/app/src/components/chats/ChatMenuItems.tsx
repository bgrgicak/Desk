/**
 * Shared dropdown-menu items for chat actions: "Copy messages" and "Delete chat".
 *
 * Rendered inside a `<DropdownMenuContent>` by both the sidebar chat-list
 * menu (AppShell) and the chat-header menu (ChatView).
 */
import { useCallback } from 'react'
import { Copy, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@agent-desk/ui'
import { api } from '@/store/api'
import { useAppDispatch } from '@/store/hooks'
import { messagesToClipboardText } from '@/components/compose/messageVisibility'

interface ChatMenuItemsProps {
  chatId: string
  onDelete: (chatId: string) => void
}

export function ChatMenuItems({ chatId, onDelete }: ChatMenuItemsProps) {
  const dispatch = useAppDispatch()

  const handleCopy = useCallback(async () => {
    try {
      // Fetch messages on demand — if they're already cached RTK Query
      // returns them instantly with no extra network request.
      const result = await dispatch(
        api.endpoints.getChatMessages.initiate({ chatId }),
      ).unwrap()

      const items = result?.items
      if (!items || items.length === 0) {
        toast.info('Nothing to copy')
        return
      }
      const text = messagesToClipboardText(items)
      if (!text) {
        toast.info('Nothing to copy')
        return
      }
      await navigator.clipboard.writeText(text)
      toast.success('Messages copied to clipboard')
    } catch {
      toast.error('Failed to copy messages')
    }
  }, [chatId, dispatch])

  return (
    <>
      <DropdownMenuItem onClick={handleCopy}>
        <Copy className="h-4 w-4 mr-2" />
        Copy text
      </DropdownMenuItem>
      <DropdownMenuItem
        className="text-destructive focus:text-destructive"
        onClick={() => onDelete(chatId)}
      >
        <Trash2 className="h-4 w-4 mr-2" />
        Delete chat
      </DropdownMenuItem>
    </>
  )
}
