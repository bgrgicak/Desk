import { useState } from 'react'
import { ListFilter, MoreVertical, PanelRight, PanelRightClose, Search, X } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@agent-desk/ui'
import { ChatMenuItems } from '@/components/chats/ChatMenuItems'
import { TopBarActions } from '@/components/layout/TopBar'
import {
  TasksFilterPopover,
  isTasksFilterActive,
  type TasksFilterValues,
} from '@/components/chats/TasksFilterPopover'

// Right-aligned action cluster for chat routes: kebab menu (chat actions
// from `ChatMenuItems`), search + filter icon-popovers that drive the right
// panel's Files + Tasks lists, and the right-panel toggle. Portals into the
// top bar via `TopBarActions`. The search/filter icons mirror the pattern in
// `TaskFilterSearch` (TasksPage's top bar) so chat and task list controls
// feel like one component family.

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
  /** Hides the search + tasks-filter icon-popovers. They only make sense
   *  when the right panel is actually visible, since that's what they
   *  filter. Defaults to shown. */
  showPanelControls?: boolean
  searchQuery: string
  onSearchChange: (q: string) => void
  tasksFilter: TasksFilterValues
  onTasksFilterChange: (next: TasksFilterValues) => void
}

export function RoomTopBarActions({
  chatId,
  onDeleteChat,
  panelOpen,
  onTogglePanel,
  showPanelToggle = true,
  showPanelControls = true,
  searchQuery,
  onSearchChange,
  tasksFilter,
  onTasksFilterChange,
}: RoomTopBarActionsProps) {
  const filterActive = isTasksFilterActive(tasksFilter)
  // Pending state mirrors `TaskFilterSearch` / `TasksFilterPopover` — edits
  // only commit on Apply, dismiss reverts.
  const [filterOpen, setFilterOpen] = useState(false)
  const [pendingFilter, setPendingFilter] = useState<TasksFilterValues>(tasksFilter)
  const openFilter = (open: boolean) => {
    if (open) setPendingFilter(tasksFilter)
    setFilterOpen(open)
  }
  const applyFilter = () => {
    onTasksFilterChange(pendingFilter)
    setFilterOpen(false)
  }
  const cancelFilter = () => {
    setPendingFilter(tasksFilter)
    setFilterOpen(false)
  }

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
      {showPanelControls && (
        <>
          <Popover open={filterOpen} onOpenChange={openFilter}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`relative h-8 w-8 ${filterActive ? 'text-primary' : ''}`}
                aria-label="Filter tasks"
              >
                <ListFilter className="h-4 w-4" />
                {filterActive && (
                  <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={8} className="w-auto p-0">
              <TasksFilterPopover
                values={pendingFilter}
                onChange={setPendingFilter}
                onApply={applyFilter}
                onCancel={cancelFilter}
              />
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`h-8 w-8 ${searchQuery ? 'text-primary' : ''}`}
                aria-label="Search files and tasks"
              >
                <Search className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={8} className="w-72 p-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  autoFocus
                  type="text"
                  value={searchQuery}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder="Search files and tasks…"
                  className="h-9 w-full rounded-md border bg-background pl-8 pr-8 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring/40 focus:ring-2 focus:ring-ring/20"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => onSearchChange('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </>
      )}
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
