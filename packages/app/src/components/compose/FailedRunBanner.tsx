import { motion } from 'framer-motion'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { useRunMessageMutation } from '@/store/api'

interface FailedRunBannerProps {
  chatId: string
  messageId: string
  failureDetail?: string | null
  isNew?: boolean
}

export const failedRunBannerClassName = 'flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/30'

/**
 * Inline error banner rendered in the chat thread when an agent turn fails.
 * Shows a friendly, non-technical message with a "Try again" button that
 * re-fires the failed agent_turn via `POST /chats/{id}/messages/{id}/run`.
 */
export function FailedRunBanner({ chatId, messageId, failureDetail, isNew = false }: FailedRunBannerProps) {
  const [runMessage, { isLoading: isRetrying, isError: retryFailed }] = useRunMessageMutation()

  function handleRetry() {
    runMessage({ chatId, messageId })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className={failedRunBannerClassName}
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-red-500 dark:text-red-400" />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-foreground">
            I wasn't able to finish my response.
          </p>
          {isNew && (
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
              <span className="text-xs text-red-500">New</span>
            </div>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          {failureDetail
            ? `What went wrong: ${failureDetail}`
            : 'This can happen when something goes wrong on my end. You can try again or send a new message.'}
        </p>
        {retryFailed && (
          <p className="text-xs text-destructive mt-1">
            Retry failed — please try again or send a new message.
          </p>
        )}
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
