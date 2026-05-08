import { motion } from 'framer-motion'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { useRunMessageMutation } from '@/store/api'

interface FailedRunBannerProps {
  chatId: string
  messageId: string
}

/**
 * Inline error banner rendered in the chat thread when an agent turn fails.
 * Shows a friendly, non-technical message with a "Try again" button that
 * re-fires the failed agent_turn via `POST /chats/{id}/messages/{id}/run`.
 */
export function FailedRunBanner({ chatId, messageId }: FailedRunBannerProps) {
  const [runMessage, { isLoading: isRetrying }] = useRunMessageMutation()

  function handleRetry() {
    runMessage({ chatId, messageId })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 dark:border-orange-900/50 dark:bg-orange-950/30"
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-orange-500 dark:text-orange-400" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground">
          I wasn't able to finish my response.
        </p>
        <p className="text-sm text-muted-foreground mt-0.5">
          This can happen when something goes wrong on my end. You can try again or send a new message.
        </p>
        <button
          onClick={handleRetry}
          disabled={isRetrying}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow-sm hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
        >
          <RotateCcw className={`h-3.5 w-3.5 ${isRetrying ? 'animate-spin' : ''}`} />
          {isRetrying ? 'Retrying…' : 'Try again'}
        </button>
      </div>
    </motion.div>
  )
}
