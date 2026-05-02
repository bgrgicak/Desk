import { Pin } from 'lucide-react'
import { LibraryCard } from '@/components/library/LibraryCard'
import {
  useGetLibraryQuery,
  useGetAgentsQuery,
  usePinLibraryItemMutation,
  useUnpinLibraryItemMutation,
} from '@/store/api'
import { toContextItem } from '@/store/selectors/library'
import type { ContextItem } from '@/data/ui-types'

interface PinnedViewProps {
  workspaceId: string
  onItemClick: (item: ContextItem) => void
  onCompose: (items: ContextItem[]) => void
}

export function PinnedView({ workspaceId, onItemClick, onCompose }: PinnedViewProps) {
  const { data: libraryResp } = useGetLibraryQuery(
    { workspaceId, pinned: true },
    { skip: !workspaceId },
  )
  const { data: agents = [] } = useGetAgentsQuery()
  const [pinItem] = usePinLibraryItemMutation()
  const [unpinItem] = useUnpinLibraryItemMutation()

  const items = (libraryResp?.items ?? []).map(f => toContextItem(f, workspaceId, agents))

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center px-6 py-4 border-b shrink-0">
        <h1 className="text-base font-semibold">Pinned</h1>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center px-8">
          <Pin className="h-8 w-8 text-muted-foreground/30" />
          <div>
            <p className="text-sm font-medium text-foreground">Nothing pinned yet</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Pin items from your Library to feature them here. Both you and your agents work in Library — Pinned is your curated set.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 p-6">
          {items.map((item, i) => (
            <LibraryCard
              key={item.id}
              item={item}
              layout="grid"
              index={i}
              isPinned
              onUnpin={() => void unpinItem({ workspaceId, path: item.id })}
              onPin={() => void pinItem({ workspaceId, path: item.id })}
              onClick={() => onItemClick(item)}
              onUseInChat={() => onCompose([item])}
            />
          ))}
        </div>
      )}
    </div>
  )
}
