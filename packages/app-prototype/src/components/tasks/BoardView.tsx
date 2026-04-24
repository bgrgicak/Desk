import { useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus } from 'lucide-react'
import { TaskCard } from './TaskCard'
import { StatusBadge } from './task-badges'
import type { Task } from '@/data/mock-data'

// ── Column config ─────────────────────────────────────────────────────────────

const COLUMNS: { id: Task['status']; label: string }[] = [
  { id: 'todo',      label: 'To do'     },
  { id: 'active',    label: 'Active'    },
  { id: 'complete',  label: 'Complete'  },
  { id: 'scheduled', label: 'Scheduled' },
]

const PLACEHOLDER_ID = '__placeholder__'

type DropTarget = {
  columnId: Task['status']
  insertBeforeId: string | null  // null = append to end
}

// ── Drop placeholder card ─────────────────────────────────────────────────────

function PlaceholderCard() {
  const { setNodeRef, transform, transition } = useSortable({ id: PLACEHOLDER_ID })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="h-10 w-full rounded-xl border-2 border-dotted border-muted-foreground/25 bg-muted/20"
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
      attributes={attributes}
      listeners={listeners}
      isDragging={isDragging}
    />
  )
}

// ── Droppable column ──────────────────────────────────────────────────────────

type DisplayItem = Task | typeof PLACEHOLDER_ID

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
  const taskCount = displayItems.filter(item => item !== PLACEHOLDER_ID).length
  const sortableIds = displayItems.map(item => item === PLACEHOLDER_ID ? PLACEHOLDER_ID : (item as Task).id)

  return (
    <div
      className="flex-1 flex flex-col border-r last:border-r-0 min-w-[180px] min-h-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Column header — no bottom border */}
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
        ref={setNodeRef}
        className={[
          'flex-1 overflow-y-auto pt-3 space-y-2 transition-colors min-h-[120px]',
          edgePx,
          isOver ? 'bg-muted/20' : '',
        ].join(' ')}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {displayItems.map((item, i) => {
            if (item === PLACEHOLDER_ID) {
              return <PlaceholderCard key={PLACEHOLDER_ID} />
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
  onTasksChange: (tasks: Task[]) => void
  onAddTask?: (status: Task['status']) => void
}

export function BoardView({
  tasks,
  selectedTaskId,
  onSelectTask,
  onTasksChange,
  onAddTask,
}: BoardViewProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  function getColumnDisplayItems(columnId: Task['status']): DisplayItem[] {
    if (!activeTask) return tasks.filter(t => t.status === columnId)

    if (activeTask.status === columnId) {
      // Same column: normal sort — dnd-kit handles transforms
      return tasks.filter(t => t.status === columnId)
    }

    // Cross-column: base = all tasks in this column (active task stays in its source column visually)
    const base = tasks.filter(t => t.status === columnId)

    if (!dropTarget || dropTarget.columnId !== columnId) return base

    // Insert placeholder at the correct position in the target column
    if (!dropTarget.insertBeforeId) return [...base, PLACEHOLDER_ID]

    const idx = base.findIndex(t => t.id === dropTarget.insertBeforeId)
    const result: DisplayItem[] = [...base]
    result.splice(idx >= 0 ? idx : base.length, 0, PLACEHOLDER_ID)
    return result
  }

  function handleDragStart(event: DragStartEvent) {
    const task = tasks.find(t => t.id === event.active.id)
    setActiveTask(task ?? null)
  }

  function handleDragOver(event: DragOverEvent) {
    const { over } = event
    if (!over || !activeTask) { setDropTarget(null); return }

    const overId = String(over.id)

    // Don't re-compute when hovering over the placeholder itself
    if (overId === PLACEHOLDER_ID) return

    const overTask = tasks.find(t => t.id === overId)
    const overColumn = COLUMNS.find(c => c.id === overId)

    if (overTask && overTask.status !== activeTask.status) {
      setDropTarget({ columnId: overTask.status, insertBeforeId: overId })
    } else if (overColumn && overColumn.id !== activeTask.status) {
      setDropTarget({ columnId: overColumn.id, insertBeforeId: null })
    } else {
      setDropTarget(null)
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    const prev = activeTask
    const target = dropTarget

    setActiveTask(null)
    setDropTarget(null)

    if (!over || !prev) return

    const activeId = String(active.id)
    const overId = String(over.id)

    // ── Intra-column reorder ──────────────────────────────────────────────────
    const overTask = overId !== PLACEHOLDER_ID ? tasks.find(t => t.id === overId) : null
    if (overTask && overTask.status === prev.status && activeId !== overId) {
      const colTasks = tasks.filter(t => t.status === prev.status)
      const reordered = arrayMove(
        colTasks,
        colTasks.findIndex(t => t.id === activeId),
        colTasks.findIndex(t => t.id === overId),
      )
      onTasksChange([...tasks.filter(t => t.status !== prev.status), ...reordered])
      return
    }

    // ── Cross-column drop ─────────────────────────────────────────────────────
    const targetColId: Task['status'] | undefined =
      target?.columnId ??
      (overTask && overTask.status !== prev.status ? overTask.status : undefined) ??
      COLUMNS.find(c => c.id === overId)?.id

    if (!targetColId || targetColId === prev.status) return

    const updated: Task = { ...prev, status: targetColId }
    const rest = tasks.filter(t => t.id !== activeId)

    if (target?.insertBeforeId) {
      const idx = rest.findIndex(t => t.id === target.insertBeforeId)
      const newList = [...rest]
      newList.splice(idx >= 0 ? idx : newList.length, 0, updated)
      onTasksChange(newList)
    } else {
      onTasksChange([...rest, updated])
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full overflow-x-auto">
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
        <DragOverlay>
          {activeTask && (
            <div className="rotate-1 opacity-90 shadow-xl">
              <TaskCard task={activeTask} onClick={() => {}} />
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  )
}
