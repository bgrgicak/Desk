import { Home } from 'lucide-react'
import { DropdownMenuItem } from '@roomy-ai/ui'
import { useIsHomePinned, toggleHomePin, type HomePinRef } from '@/hooks/use-home-pins'

/**
 * Shared kebab item that toggles an entity (file / artifact / chat /
 * task) in the Home screen's Favorites section. One implementation so
 * every menu stays consistent. Prototype-only persistence via
 * `use-home-pins` (localStorage) — backend wiring is a separate task.
 */
export function ShowInHomeMenuItem({ pin }: { pin: HomePinRef }) {
  const pinned = useIsHomePinned(pin.kind, pin.id)
  return (
    <DropdownMenuItem
      onClick={() => toggleHomePin(pin)}
      data-testid={`show-in-home-${pin.kind}`}
    >
      <Home className="h-4 w-4 mr-2" />
      {pinned ? 'Remove from Home' : 'Show in Home'}
    </DropdownMenuItem>
  )
}
