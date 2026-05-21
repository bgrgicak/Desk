import { memo, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import {
  MessageSquarePlus,
  MoreHorizontal,
} from 'lucide-react'
import {
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@agent-desk/ui'
import type { ContextItem } from '@/data/ui-types'
import { getRelativeTime } from '@/data/ui-types'
import { iconForItem } from '@/data/file-kind'
import { FileActionMenuItems } from '@/components/library/FileActionMenuItems'

export const DRAG_TYPE_LIBRARY_ITEM = 'application/x-library-item'
export const DRAG_TYPE_PINNED_ITEM  = 'application/x-pinned-item'
export const DRAG_TYPE_CHAT         = 'application/x-chat'

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
  /** When set, the clickable surface is rendered as a react-router `<Link>`
   *  so middle-click / cmd+click opens the destination in a new tab. With
   *  `href` provided the `<Link>` handles SPA navigation itself and the
   *  `onClick` callback is ignored — callers should make sure `href` already
   *  leads to the desired destination. */
  href?: string
  onClick?: () => void
  onUseInChat?: () => void
  onDownload?: () => void
  onRename?: () => void
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
export const LibraryCard = memo(function LibraryCard({
  item,
  layout,
  index = 0,
  thumbnail,
  selected = false,
  hasSelection = false,
  onSelectChange,
  href,
  onClick,
  onUseInChat,
  onDownload,
  onRename,
  onMove,
  onDelete,
  isPinned,
  onPin,
  onUnpin,
  isDraggable,
}: LibraryCardProps) {
  const Icon = iconForItem(item)

  const handleDragStart = (e: unknown) => {
    const dragEvent = e as React.DragEvent<HTMLElement>
    dragEvent.dataTransfer.effectAllowed = 'move'
    dragEvent.dataTransfer.setData(DRAG_TYPE_LIBRARY_ITEM, item.id)
  }

  // Anchors are draggable by default and would otherwise initiate a URL drag
  // when the user grabs the card. When the row should be draggable for the
  // pin/move workflow we re-attach the library-item drag handler to the link
  // itself; when it shouldn't be draggable we explicitly opt out.
  const linkDragProps = isDraggable
    ? { draggable: true as const, onDragStart: handleDragStart }
    : { draggable: false as const }

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
        <FileActionMenuItems
          onUseInChat={onUseInChat}
          isPinned={isPinned}
          onPin={onPin}
          onUnpin={onUnpin}
          onDownload={onDownload}
          onRename={onRename}
          onMove={onMove}
          onDelete={onDelete}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )

  if (layout === 'list') {
    const nameContent = (
      <>
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{item.name}</p>
          {item.usedBy.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Used by {item.usedBy.join(', ')}
              {item.lastAccessed && ` · ${getRelativeTime(item.lastAccessed)}`}
            </p>
          )}
        </div>
      </>
    )
    return (
      <motion.div
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: index * 0.02 }}
        draggable={!href && isDraggable ? true : undefined}
        onDragStart={!href && isDraggable ? handleDragStart : undefined}
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
        {href ? (
          // When the parent supplies an href the `<Link>` itself handles SPA
          // navigation on plain left-click and lets the browser open a new
          // tab on middle / cmd / ctrl click. The legacy `onClick` callback
          // only navigates (no other side effects), so it would otherwise
          // double-push a history entry — we intentionally skip it here.
          <Link
            to={href}
            className="flex items-center gap-3 flex-1 min-w-0 no-underline text-inherit"
            {...linkDragProps}
          >
            {nameContent}
          </Link>
        ) : (
          <div className="flex items-center gap-3 flex-1 min-w-0" onClick={onClick}>
            {nameContent}
          </div>
        )}
        <span className="hidden text-xs text-muted-foreground shrink-0 w-20 text-right capitalize sm:block">
          {item.type}
        </span>
        <span className="hidden text-xs text-muted-foreground shrink-0 w-20 text-right sm:block">
          {getRelativeTime(item.addedAt)}
        </span>
        <div className="flex items-center gap-1 justify-end shrink-0 sm:w-[140px] sm:ml-10">
          {onUseInChat && (
            <Button
              size="sm"
              variant="outline"
              className="hidden h-7 text-xs opacity-0 transition-opacity group-hover:opacity-100 sm:inline-flex"
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
  const gridBody = thumbnail ? (
    <>
      {thumbnail}
      <div className="p-4 pt-3">
        <p className="text-sm font-medium text-foreground truncate mb-1">{item.name}</p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
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
        {getRelativeTime(item.addedAt)}
      </p>
    </div>
  )
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: index * 0.03 }}
      draggable={!href && isDraggable ? true : undefined}
      onDragStart={!href && isDraggable ? handleDragStart : undefined}
      className={`group relative rounded-xl border bg-background cursor-pointer hover:shadow-sm transition-all overflow-hidden ${
        selected ? 'ring-2 ring-primary/30 border-primary/20' : 'border-border'
      }`}
      onClick={href ? undefined : onClick}
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
      {href ? (
        // See list-layout comment: the `<Link>` handles SPA navigation
        // itself, and the parent's `onClick` would be a redundant second
        // history push.
        <Link
          to={href}
          className="block no-underline text-inherit"
          {...linkDragProps}
        >
          {gridBody}
        </Link>
      ) : (
        gridBody
      )}
    </motion.div>
  )
})
