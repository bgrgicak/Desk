import { motion, AnimatePresence } from 'framer-motion'
import { Loader2 } from 'lucide-react'

interface StatusIndicatorProps {
  text: string | null
  isTyping?: boolean
}

export function StatusIndicator({ text, isTyping }: StatusIndicatorProps) {
  return (
    <AnimatePresence mode="wait">
      {(text || isTyping) && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          className="flex items-center gap-2 px-4 py-2"
          key={text || 'typing'}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {text || 'Thinking'}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
