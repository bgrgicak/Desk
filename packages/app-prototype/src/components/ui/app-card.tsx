import { motion } from 'framer-motion'

interface AppCardProps {
  children: React.ReactNode
  onClick?: () => void
  index?: number
  isSelected?: boolean
  isDragging?: boolean
  // dnd-kit forwarded props
  setNodeRef?: (node: HTMLElement | null) => void
  dragStyle?: React.CSSProperties
  dragAttributes?: Record<string, unknown>
  dragListeners?: Record<string, unknown>
  className?: string
}

export function AppCard({
  children,
  onClick,
  index = 0,
  isSelected = false,
  isDragging = false,
  setNodeRef,
  dragStyle,
  dragAttributes,
  dragListeners,
  className = '',
}: AppCardProps) {
  return (
    <motion.button
      ref={setNodeRef as ((node: HTMLButtonElement | null) => void) | undefined}
      style={dragStyle}
      initial={{ opacity: 0 }}
      animate={{ opacity: isDragging ? 0.4 : 1 }}
      transition={{ delay: index * 0.04, duration: 0.2 }}
      onClick={onClick}
      type="button"
      {...(dragAttributes as React.ButtonHTMLAttributes<HTMLButtonElement>)}
      {...(dragListeners as React.ButtonHTMLAttributes<HTMLButtonElement>)}
      className={[
        'w-full text-left rounded-xl border bg-background overflow-hidden',
        'hover:shadow-md hover:border-foreground/10 transition-all duration-200',
        'focus:outline-none focus:ring-2 focus:ring-ring/20',
        isSelected ? 'ring-2 ring-ring/30 border-foreground/10' : 'border-border',
        isDragging ? 'cursor-grabbing' : 'cursor-pointer',
        className,
      ].join(' ')}
    >
      {children}
    </motion.button>
  )
}
