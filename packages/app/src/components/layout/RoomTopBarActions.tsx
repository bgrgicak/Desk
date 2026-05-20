import { MoreVertical, PanelRight, PanelRightClose } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@agent-desk/ui'
import { ChatMenuItems } from '@/components/chats/ChatMenuItems'
import { TopBarActions } from '@/components/layout/TopBar'

// Right-aligned action cluster for chat routes: kebab menu (chat actions
// from `ChatMenuItems`) and a right-panel toggle. Portals into the top bar
// via `TopBarActions`.

interface RoomTopBarActionsProps {
  chatId: string
  onDeleteChat?: (chatId: string) => void
  panelOpen: boolean
  onTogglePanel: () => void
  /** Hides the right-panel toggle button. The toggle controls the
   *  Files + Tasks panel, which is replaced by the preview panel when
   *  an artifact is open — so the button would be a no-op there. The
   *  kebab menu stays visible regardless. Defaults to shown. */
  showPanelToggle?: boolean
}

export function RoomTopBarActions({
  chatId,
  onDeleteChat,
  panelOpen,
  onTogglePanel,
  showPanelToggle = true,
}: RoomTopBarActionsProps) {
  return (
    <TopBarActions>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <ChatMenuItems chatId={chatId} onDelete={(id) => onDeleteChat?.(id)} />
        </DropdownMenuContent>
      </DropdownMenu>
      {showPanelToggle && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onTogglePanel}
          aria-label={panelOpen ? 'Close side panel' : 'Open side panel'}
        >
          {panelOpen ? (
            <PanelRightClose className="h-4 w-4" />
          ) : (
            <PanelRight className="h-4 w-4" />
          )}
        </Button>
      )}
    </TopBarActions>
  )
}
