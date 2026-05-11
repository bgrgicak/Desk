import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  pointerWithin,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type CollisionDetection,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AnimatePresence, motion } from 'framer-motion'
import { Plus } from 'lucide-react'
import { TaskCard } from './TaskCard'
import { StatusBadge } from './task-badges'
import type { Task } from '@/data/ui-types'

// ── Column config ─────────────────────────────────────────────────────────────

const COLUMNS: { id: Task['status']; label: string }[] = [
  { id: 'todo',      label: 'To do'     },
  { id: 'active',    label: 'Active'    },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'complete',  label: 'Complete'  },
]

const PLACEHOLDER_PREFIX = '__placeholder__:'

function placeholderId(columnId: Task['status']) {
  return `${PLACEHOLDER_PREFIX}${columnId}`
}

function getPlaceholderColumnId(id: string): Task['status'] | null {
  if (!id.startsWith(PLACEHOLDER_PREFIX)) return null
  const columnId = id.slice(PLACEHOLDER_PREFIX.length)
  return COLUMNS.some(column => column.id === columnId) ? columnId as Task['status'] : null
}

function taskStatusFromDroppableId(id: string): Task['status'] | null {
  const placeholderColumnId = getPlaceholderColumnId(id)
  if (placeholderColumnId) return placeholderColumnId
  return COLUMNS.some(column => column.id === id) ? id as Task['status'] : null
}

const pointerFirstCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  return pointerCollisions.length > 0 ? pointerCollisions : closestCorners(args)
}

type DropTarget = {
  columnId: Task['status']
  insertBeforeId: string | null  // null = append to end
}

// ── Drop placeholder card ─────────────────────────────────────────────────────

function PlaceholderCard({ id }: { id: string }) {
  const { setNodeRef, transform } = useSortable({ id })
  return (
    <motion.div
      ref={setNodeRef}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 40, opacity: 1 }}
      exit={{ height: 0, opacity: 0, transition: { duration: 0 } }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      style={{ transform: CSS.Transform.toString(transform) }}
      className="w-full shrink-0 rounded-xl border-2 border-dotted border-muted-foreground/25 bg-muted/20 overflow-hidden"
    />
  )
}

// ── Sortable card wrapper ─────────────────────────────────────────────────────

function SortableTaskCard({
  task,
  index,
  isSelected,
  onClick,
}: {
  task: Task
  index: number
  isSelected: boolean
  onClick: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <TaskCard
      task={task}
      index={index}
      isSelected={isSelected}
      onClick={onClick}
      setNodeRef={setNodeRef}
      style={style}
      attributes={attributes as unknown as Record<string, unknown>}
      listeners={listeners as unknown as Record<string, unknown>}
      isDragging={isDragging}
    />
  )
}

// ── Droppable column ──────────────────────────────────────────────────────────

type DisplayItem = Task | string

function Column({
  column,
  displayItems,
  selectedTaskId,
  onSelectTask,
  onAddTask,
  isFirst,
  isLast,
}: {
  column: (typeof COLUMNS)[number]
  displayItems: DisplayItem[]
  selectedTaskId: string | null
  onSelectTask: (task: Task) => void
  onAddTask: () => void
  isFirst: boolean
  isLast: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id })
  const [hovered, setHovered] = useState(false)

  const edgePx = isFirst ? 'pl-4 pr-3' : isLast ? 'pl-3 pr-4' : 'px-3'
  const taskCount = displayItems.filter(item => typeof item !== 'string' || !getPlaceholderColumnId(item)).length
  const sortableIds = displayItems.map(item => typeof item === 'string' && getPlaceholderColumnId(item) ? item : (item as Task).id)

  return (
    <div
      ref={setNodeRef}
      data-task-column-id={column.id}
      data-testid={`tasks-column-${column.id}`}
      className="flex-1 flex flex-col border-r last:border-r-0 min-w-[180px] min-h-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Column header */}
      <div className={`flex items-center gap-2 pt-3 ${edgePx}`}>
        <StatusBadge status={column.id} />
        <span className="text-xs text-muted-foreground font-medium">{taskCount}</span>
        <button
          onClick={onAddTask}
          className={[
            'flex h-5 w-5 items-center justify-center rounded-md ml-auto',
            'text-muted-foreground hover:text-foreground hover:bg-muted transition-all',
            hovered ? 'opacity-100' : 'opacity-0',
          ].join(' ')}
          aria-label={`Add task to ${column.label}`}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Column body */}
      <div
        data-testid={`tasks-column-${column.id}-list`}
        className={[
          'flex-1 min-h-0 overflow-y-auto overscroll-contain pt-3 flex flex-col gap-2 transition-colors',
          edgePx,
          isOver ? 'bg-muted/20' : '',
        ].join(' ')}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <AnimatePresence initial={false}>
            {displayItems.map((item, i) => {
              if (typeof item === 'string' && getPlaceholderColumnId(item)) {
                return <PlaceholderCard key={item} id={item} />
              }
              const task = item as Task
              return (
                <SortableTaskCard
                  key={task.id}
                  task={task}
                  index={i}
                  isSelected={selectedTaskId === task.id}
                  onClick={() => onSelectTask(task)}
                />
              )
            })}
          </AnimatePresence>
        </SortableContext>
        {taskCount === 0 && (
          <div className="h-20 flex items-center justify-center">
            <span className="text-xs text-muted-foreground/40">No tasks</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main BoardView ─────────────────────────────────────────────────────────────

interface BoardViewProps {
  tasks: Task[]
  selectedTaskId: string | null
  onSelectTask: (task: Task) => void
  /** Cross-column drops fire this so the parent can persist the new
   * status (PATCH /chats/:id/messages/:id). Intra-column reorder is
   * client-only — the server has no order field. */
  onTaskMove?: (task: Task, newStatus: Task['status']) => Promise<boolean | void> | boolean | void
  onAddTask?: (status: Task['status']) => void
}

export function BoardView({
  tasks,
  selectedTaskId,
  onSelectTask,
  onTaskMove,
  onAddTask,
}: BoardViewProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const activeTaskRef = useRef<Task | null>(null)
  const dropTargetRef = useRef<DropTarget | null>(null)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  useEffect(() => {
    // Track the pointer for the whole board lifetime, not only after a drag is
    // active. dnd-kit can promote the pointer gesture to a drag and then end it
    // before React has committed an `activeTask`-gated listener, especially in
    // dense layouts or when the detail sidebar changes column geometry. Keeping
    // the latest pointer here makes the drop target resolver independent of
    // dnd-kit's sometimes-stale `over` collision.
    const trackPointer = (event: PointerEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
    }
    window.addEventListener('pointermove', trackPointer, { capture: true })
    window.addEventListener('pointerup', trackPointer, { capture: true })
    window.addEventListener('pointerdown', trackPointer, { capture: true })
    return () => {
      window.removeEventListener('pointermove', trackPointer, { capture: true })
      window.removeEventListener('pointerup', trackPointer, { capture: true })
      window.removeEventListener('pointerdown', trackPointer, { capture: true })
    }
  }, [])

  function getColumnIdAtLastPointer(): Task['status'] | null {
    const point = lastPointerRef.current
    if (!point) return null
    const elementAtPoint = document.elementFromPoint(point.x, point.y) as HTMLElement | null
    const directColumn = elementAtPoint?.closest<HTMLElement>('[data-task-column-id]')
    const directColumnId = directColumn?.dataset.taskColumnId
    if (COLUMNS.some(c => c.id === directColumnId)) return directColumnId as Task['status']

    for (const column of Array.from(document.querySelectorAll<HTMLElement>('[data-task-column-id]'))) {
      const rect = column.getBoundingClientRect()
      if (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
      ) {
        const columnId = column.dataset.taskColumnId
        return COLUMNS.some(c => c.id === columnId) ? columnId as Task['status'] : null
      }
    }
    return null
  }

  function updateDropTarget(target: DropTarget | null) {
    dropTargetRef.current = target
    setDropTarget(target)
  }

  function resolveDropTarget(active: Task | null, overId: string | null): DropTarget | null {
    if (!active) return null
    const pointerColumnId = getColumnIdAtLastPointer()
    const overTask = overId ? tasks.find(t => t.id === overId) : null
    const overColumnId = overId ? taskStatusFromDroppableId(overId) : null

    // Pointer geometry is the user's semantic intent; @dnd-kit `over` is only
    // a sortable implementation detail. Prefer the stable column under the
    // pointer so layout shifts (notably opening the right task sidebar) cannot
    // turn a valid cross-column drop into a placeholder/task miss.
    if (pointerColumnId && pointerColumnId !== active.status) {
      return {
        columnId: pointerColumnId,
        insertBeforeId: overTask?.status === pointerColumnId ? overTask.id : null,
      }
    }

    if (overTask && overTask.status !== active.status) {
      return { columnId: overTask.status, insertBeforeId: overTask.id }
    }
    if (overColumnId && overColumnId !== active.status) {
      return { columnId: overColumnId, insertBeforeId: null }
    }
    if (overTask && overTask.id !== active.id) {
      return { columnId: active.status, insertBeforeId: overTask.id }
    }
    if (overColumnId && overColumnId === active.status) {
      return { columnId: active.status, insertBeforeId: null }
    }
    return pointerColumnId ? { columnId: pointerColumnId, insertBeforeId: null } : null
  }

  function getColumnDisplayItems(columnId: Task['status']): DisplayItem[] {
    if (!activeTask) return tasks.filter(t => t.status === columnId)

    if (activeTask.status === columnId) {
      if (dropTarget?.columnId === columnId) {
        // Same-column with a hover target: remove faded card, show placeholder at target position
        const base = tasks.filter(t => t.status === columnId && t.id !== activeTask.id)
        if (!dropTarget.insertBeforeId) return [...base, placeholderId(columnId)]
        const idx = base.findIndex(t => t.id === dropTarget.insertBeforeId)
        const result: DisplayItem[] = [...base]
        result.splice(idx >= 0 ? idx : base.length, 0, placeholderId(columnId))
        return result
      }
      // No target yet: keep faded card in its original position
      return tasks.filter(t => t.status === columnId)
    }

    // Cross-column: base = all tasks in this column
    const base = tasks.filter(t => t.status === columnId)
    if (!dropTarget || dropTarget.columnId !== columnId) return base
    if (!dropTarget.insertBeforeId) return [...base, placeholderId(columnId)]
    const idx = base.findIndex(t => t.id === dropTarget.insertBeforeId)
    const result: DisplayItem[] = [...base]
    result.splice(idx >= 0 ? idx : base.length, 0, placeholderId(columnId))
    return result
  }

  function handleDragStart(event: DragStartEvent) {
    const task = tasks.find(t => t.id === event.active.id)
    activeTaskRef.current = task ?? null
    setActiveTask(task ?? null)
  }

  function handleDragOver(event: DragOverEvent) {
    const { over } = event
    const active = activeTaskRef.current
    if (!active) { updateDropTarget(null); return }
    updateDropTarget(resolveDropTarget(active, over ? String(over.id) : null))
  }

  function handleDragEnd(event: DragEndEvent) {
    const { over } = event
    const prev = activeTaskRef.current
    const target = dropTargetRef.current
    const resolvedTarget = resolveDropTarget(prev, over ? String(over.id) : null)

    activeTaskRef.current = null
    dropTargetRef.current = null
    setActiveTask(null)
    setDropTarget(null)
    lastPointerRef.current = null

    if (!prev) return

    // Cross-column drop — fire the persistence hook.
    const targetColId: Task['status'] | undefined =
      resolvedTarget?.columnId ??
      target?.columnId

    // Intra-column reorder is client-only (server has no order field). Check
    // the resolved pointer-first target, not dnd-kit's raw `over`, because the
    // raw collision can still name an original-column card after layout shifts
    // such as opening the right task sidebar.
    if (!targetColId || targetColId === prev.status) return
    void Promise.resolve(onTaskMove?.(prev, targetColId)).catch(() => {})
  }

  function handleDragCancel() {
    activeTaskRef.current = null
    dropTargetRef.current = null
    setActiveTask(null)
    setDropTarget(null)
    lastPointerRef.current = null
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerFirstCollisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex flex-1 min-h-0 overflow-x-auto">
        {COLUMNS.map((col, i) => (
          <Column
            key={col.id}
            column={col}
            displayItems={getColumnDisplayItems(col.id)}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
            onAddTask={() => onAddTask?.(col.id)}
            isFirst={i === 0}
            isLast={i === COLUMNS.length - 1}
          />
        ))}
      </div>

      {createPortal(
        <DragOverlay dropAnimation={null}>
          {activeTask && (
            <div className="pointer-events-none rotate-1 opacity-90 shadow-xl">
              <TaskCard task={activeTask} onClick={() => {}} />
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  )
}
