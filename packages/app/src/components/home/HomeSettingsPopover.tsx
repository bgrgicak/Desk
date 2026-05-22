import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, SlidersHorizontal } from 'lucide-react'
import {
  Button,
  Checkbox,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@roomy-ai/ui'
import {
  HOME_SECTION_LABELS,
  useHomeSections,
  type HomeSectionKey,
} from '@/hooks/use-home-sections'

function SortableRow({
  id,
  label,
  checked,
  onToggle,
}: {
  id: HomeSectionKey
  label: string
  checked: boolean
  onToggle: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-md px-1.5 py-1.5 text-sm ${
        isDragging ? 'bg-foreground/[0.04]' : ''
      }`}
    >
      <button
        type="button"
        aria-label={`Reorder ${label}`}
        className="cursor-grab text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <Checkbox
        id={`home-section-${id}`}
        checked={checked}
        onCheckedChange={onToggle}
      />
      <label htmlFor={`home-section-${id}`} className="flex-1 cursor-pointer select-none">
        {label}
      </label>
    </div>
  )
}

/** A non-draggable row used for the Summary entry — same visual rhythm
 *  as `SortableRow` but without a grip handle. The Summary section is
 *  always shown (checkbox checked + disabled) — it's the page header
 *  and isn't user-hideable. */
function FixedRow({
  id,
  label,
}: {
  id: HomeSectionKey
  label: string
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-sm">
      <span
        aria-hidden
        className="inline-block h-4 w-4 shrink-0"
        // Reserve the grip column so the checkbox + label still line
        // up with the sortable rows below.
      />
      <Checkbox
        id={`home-section-${id}`}
        checked
        disabled
        aria-readonly
      />
      <label htmlFor={`home-section-${id}`} className="flex-1 select-none text-muted-foreground">
        {label}
      </label>
    </div>
  )
}

/**
 * Home page "Settings" control: a popover with a drag-reorderable,
 * checkbox show/hide list of the page's sections. Persists via
 * `useHomeSections` (localStorage, cross-tab).
 *
 * The Summary row stays fixed at the top — order is meaningful for
 * the task rows but the greeting/summary always reads as the page
 * header.
 */
export function HomeSettingsPopover() {
  const { order, isVisible, setOrder, toggle } = useHomeSections()
  const sortable = order.filter((k): k is Exclude<HomeSectionKey, 'summary'> => k !== 'summary')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = sortable.indexOf(active.id as Exclude<HomeSectionKey, 'summary'>)
    const to = sortable.indexOf(over.id as Exclude<HomeSectionKey, 'summary'>)
    if (from < 0 || to < 0) return
    const nextSortable = arrayMove(sortable, from, to)
    // Persist as `[summary, ...sortable]` so the visible order in the
    // popover (Summary first) matches the stored order on disk.
    setOrder(['summary', ...nextSortable])
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-foreground"
          aria-label="Home settings"
          data-testid="home-settings-button"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <p className="px-1.5 pb-2 pt-1 text-xs font-medium text-muted-foreground">
          Manage sections
        </p>
        <FixedRow id="summary" label={HOME_SECTION_LABELS.summary} />
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={sortable} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col">
              {sortable.map(key => (
                <SortableRow
                  key={key}
                  id={key}
                  label={HOME_SECTION_LABELS[key]}
                  checked={isVisible(key)}
                  onToggle={() => toggle(key)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </PopoverContent>
    </Popover>
  )
}
