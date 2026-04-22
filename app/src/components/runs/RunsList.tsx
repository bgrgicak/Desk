import { motion } from 'framer-motion'
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  PauseCircle,
  Clock,
  Play,
  Pause,
  X,
  Calendar,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Run } from '@/data/mock-data'
import { getRelativeTime } from '@/data/mock-data'

interface RunsListProps {
  runs: Run[]
}

function RunStatusIcon({ status }: { status: Run['status'] }) {
  switch (status) {
    case 'active':
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />
    case 'failed':
      return <AlertCircle className="h-4 w-4 text-red-500" />
    case 'paused':
      return <PauseCircle className="h-4 w-4 text-amber-500" />
  }
}

export function RunsList({ runs }: RunsListProps) {
  const active = runs.filter(r => r.status === 'active' || r.status === 'paused')
  const scheduled = runs.filter(r => r.scheduled && r.nextRun)
  const completed = runs.filter(r => r.status === 'completed' || r.status === 'failed')

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-6">
        <h1 className="text-xl font-semibold">Runs</h1>
        <p className="text-sm text-muted-foreground mt-0.5 mb-6">Tasks running in the background on your behalf.</p>

        {/* Active runs */}
        {active.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Active</h2>
            <div className="space-y-2">
              {active.map((run, i) => (
                <motion.div
                  key={run.id}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="rounded-xl border p-4"
                >
                  <div className="flex items-start gap-3">
                    <RunStatusIcon status={run.status} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">{run.name}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">{run.statusText}</p>
                      <p className="text-xs text-muted-foreground/60 mt-1">
                        Started {getRelativeTime(run.startedAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {run.status === 'active' && (
                        <>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <Pause className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      {run.status === 'paused' && (
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {/* Scheduled */}
        {scheduled.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Scheduled</h2>
            <div className="space-y-1">
              {scheduled.map((run) => (
                <div key={`sched-${run.id}`} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors">
                  <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{run.name}</p>
                    {run.nextRun && (
                      <p className="text-xs text-muted-foreground">
                        Next: {run.nextRun.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Recurring</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Completed */}
        {completed.length > 0 && (
          <div>
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Recent</h2>
            <div className="space-y-1">
              {completed.map((run) => (
                <div key={run.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/50 transition-colors">
                  <RunStatusIcon status={run.status} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{run.name}</p>
                    <p className="text-xs text-muted-foreground">{run.statusText}</p>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {run.completedAt ? getRelativeTime(run.completedAt) : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
