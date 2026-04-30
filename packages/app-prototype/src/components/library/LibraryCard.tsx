import { type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  Bot,
  Download,
  FolderPlus,
  MessageSquarePlus,
  MoreHorizontal,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ContextItem } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { iconForItem } from '@/data/file-kind'

export const DRAG_TYPE_LIBRARY_ITEM = 'application/x-library-item'
export const DRAG_TYPE_PINNED_ITEM  = 'application/x-pinned-item'

export type LibraryCardLayout = 'list' | 'grid'

interface LibraryCardProps {
  item: ContextItem
  layout: LibraryCardLayout
  index?: number
  /** Optional preview surface rendered above the metadata in grid layout
   *  (e.g. a scaled artifact thumbnail). Ignored in list layout. */
  thumbnail?: ReactNode
  selected?: boolean
  hasSelection?: boolean
  onSelectChange?: (selected: boolean) => void
  onClick?: () => void
  onUseInChat?: () => void
  onDownload?: () => void
  onMove?: () => void
  onDelete?: () => void
  isPinned?: boolean
  onPin?: () => void
  onUnpin?: () => void
  isDraggable?: boolean
}

/**
 * Unified card used for both Library and Desk surfaces. Folders are not
 * rendered here — callers handle folder rows separately because their
 * navigation semantics differ from leaf items.
 */
export function LibraryCard({
  item,
  layout,
  index = 0,
  thumbnail,
  selected = false,
  hasSelection = false,
  onSelectChange,
  onClick,
  onUseInChat,
  onDownload,
  onMove,
  onDelete,
  isPinned,
  onPin,
  onUnpin,
  isDraggable,
}: LibraryCardProps) {
  const Icon = iconForItem(item)
  const showAgent = item.uploadedBy === 'ai'
  const agentLabel = item.agentName ?? 'AI'

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DRAG_TYPE_LIBRARY_ITEM, item.id)
  }

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={layout === 'grid' ? 'outline' : 'ghost'}
          size="icon"
          className={
            layout === 'grid'
              ? 'h-6 w-6 bg-background/80 backdrop-blur'
              : 'h-7 w-7'
          }
          data-testid={`library-item-menu-${item.name}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className={layout === 'grid' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
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
        {onMove && (
          <DropdownMenuItem onClick={onMove}>
            <FolderPlus className="h-4 w-4 mr-2" />
            Move to folder
          </DropdownMenuItem>
        )}
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  if (layout === 'list') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: index * 0.02 }}
        draggable={isDraggable ? true : undefined}
        onDragStart={isDraggable ? handleDragStart : undefined}
        className={`flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors group cursor-pointer ${
          selected ? 'bg-primary/5 border border-primary/10' : 'hover:bg-muted/50 border border-transparent'
        } ${isDraggable ? 'active:cursor-grabbing' : ''}`}
      >
        {onSelectChange && (
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelectChange(v === true)}
            className="h-4 w-4"
            onClick={(e) => e.stopPropagation()}
          />
        )}
        <div className="flex items-center gap-3 flex-1 min-w-0" onClick={onClick}>
          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{item.name}</p>
            {showAgent && (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Bot className="h-3 w-3 shrink-0" />
                <span className="truncate">{agentLabel}</span>
              </p>
            )}
            {item.usedBy.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Used by {item.usedBy.join(', ')}
                {item.lastAccessed && ` · ${getRelativeTime(item.lastAccessed)}`}
              </p>
            )}
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0 w-20 text-right capitalize">
          {item.type}
        </span>
        <span className="text-xs text-muted-foreground shrink-0 w-20 text-right">
          {getRelativeTime(item.addedAt)}
        </span>
        <div className="flex items-center gap-1 justify-end shrink-0 w-[140px] ml-10">
          {onUseInChat && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => {
                e.stopPropagation()
                onUseInChat()
              }}
            >
              Use in chat
            </Button>
          )}
          {menu}
        </div>
      </motion.div>
    )
  }

  // Grid layout
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: index * 0.03 }}
      draggable={isDraggable ? true : undefined}
      onDragStart={isDraggable ? handleDragStart : undefined}
      className={`group relative rounded-xl border bg-background cursor-pointer hover:shadow-sm transition-all overflow-hidden ${
        selected ? 'ring-2 ring-primary/30 border-primary/20' : 'border-border'
      }`}
      onClick={onClick}
    >
      {onSelectChange && (
        <div
          className={`absolute top-2 left-2 z-10 transition-opacity ${
            selected || hasSelection ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelectChange(v === true)}
            className="h-4 w-4 bg-background/80 backdrop-blur"
          />
        </div>
      )}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {onUseInChat && (
          <Button
            variant="outline"
            size="icon"
            className="h-6 w-6 bg-background/80 backdrop-blur"
            onClick={(e) => {
              e.stopPropagation()
              onUseInChat()
            }}
          >
            <MessageSquarePlus className="h-3 w-3" />
          </Button>
        )}
        {menu}
      </div>
      {thumbnail ? (
        <>
          {thumbnail}
          <div className="p-4 pt-3">
            <p className="text-sm font-medium text-foreground truncate mb-1">{item.name}</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              {showAgent && (
                <>
                  <Bot className="h-3 w-3 shrink-0" />
                  <span className="truncate max-w-[8rem]">{agentLabel}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              {getRelativeTime(item.addedAt)}
            </p>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center text-center p-4 pt-6 pb-3">
          <Icon className="h-8 w-8 text-muted-foreground/40 mb-3" />
          <p className="text-sm font-medium text-foreground line-clamp-2 break-all mb-1 w-full">
            {item.name}
          </p>
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            {showAgent && (
              <>
                <Bot className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[8rem]">{agentLabel}</span>
                <span aria-hidden>·</span>
              </>
            )}
            {getRelativeTime(item.addedAt)}
          </p>
        </div>
      )}
    </motion.div>
  )
}
