import type { Task } from '@/data/ui-types'
import { roomColor } from '@/components/rooms/roomColor'
import type { HomeTask, HomeWorkspaceBuckets } from './HomeWorkspaceTasks'

// ─────────────────────────────────────────────────────────────────────────────
// Mock Home tasks
//
// Dev-only fixture data for the Home digest so the cross-room carousels
// have something to render even when the user has no real tasks yet.
// Flip `MOCK_HOME_TASKS_ENABLED` off (or delete this file's import in
// HomePage) once the backend is producing real data.
//
// The fixtures fan out across three fake "rooms" so the room icon-or-ring
// in the TaskCard meta line shows variety. None of these tasks have a
// `chatId` / `messageId`, so Mark-as-done / Reopen / Run-now / Pause /
// Delete handlers in HomePage no-op (they early-return when both are
// absent). That's the right behaviour for fixtures — the actions only
// flow against real backing messages.
// ─────────────────────────────────────────────────────────────────────────────

export const MOCK_HOME_TASKS_ENABLED = true

interface MockRoom {
  workspaceId: string
  roomName: string
  /** Passed straight into `roomColor()`. */
  bg: string
}

const ROOMS: MockRoom[] = [
  { workspaceId: 'mock-ws-recruiting',  roomName: 'Recruiting',  bg: 'blue' },
  { workspaceId: 'mock-ws-marketing',   roomName: 'Marketing',   bg: 'violet' },
  { workspaceId: 'mock-ws-engineering', roomName: 'Engineering', bg: 'emerald' },
  { workspaceId: 'mock-ws-research',    roomName: 'Research',    bg: 'amber' },
]

function pickRoom(i: number): MockRoom {
  return ROOMS[i % ROOMS.length]
}

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000)
}

function hoursAgo(n: number): Date {
  return minutesAgo(n * 60)
}

function daysAgo(n: number): Date {
  return hoursAgo(n * 24)
}

function makeTask(t: {
  id: string
  title: string
  description: string
  status: Task['status']
  startedAt: Date
  completedAt?: Date
  priority?: Task['priority']
  schedule?: string
  nextRun?: Date
  agentName?: string
  messageState?: Task['messageState']
}): Task {
  return {
    id: t.id,
    name: t.title,
    title: t.title,
    description: t.description,
    agentName: t.agentName ?? 'Assistant',
    status: t.status,
    statusText: '',
    priority: t.priority,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    messageKind: 'task',
    messageRole: 'user',
    messageState:
      t.messageState ??
      (t.status === 'complete' ? 'succeeded' :
        t.status === 'active' ? 'running' : 'pending'),
    artifactIds: [],
    color: 'blue',
    schedule: t.schedule,
    nextRun: t.nextRun,
    history: [],
  }
}

function wrap(task: Task, room: MockRoom): HomeTask {
  return {
    task,
    roomName: room.roomName,
    roomColor: roomColor(room.bg),
    roomIconUrl: null,
    workspaceId: room.workspaceId,
  }
}

// ── Needs your input ────────────────────────────────────────────────────────
const NEEDS_INPUT: HomeTask[] = [
  wrap(
    makeTask({
      id: 'mock-n-1',
      title: 'Review draft offer letter for Maya Chen',
      description:
        'I pulled the salary band + standard equity grant from your template. ' +
        'Confirm the start date (2026-06-01) and the relocation amount and I\'ll send it.',
      status: 'needs_input',
      startedAt: minutesAgo(38),
      priority: 'high',
    }),
    pickRoom(0),
  ),
  wrap(
    makeTask({
      id: 'mock-n-2',
      title: 'Pick the homepage hero copy variant',
      description:
        'Three options ready. Variant B leans into the "no-config" line you mentioned. ' +
        'Want me to ship B, or do you want to A/B them?',
      status: 'needs_input',
      startedAt: hoursAgo(2),
      priority: 'medium',
    }),
    pickRoom(1),
  ),
  wrap(
    makeTask({
      id: 'mock-n-3',
      title: 'Approve the migration plan',
      description:
        'Plan involves a one-time backfill (≈12 min downtime). Read the plan and ' +
        'either give the go-ahead or push back on the window.',
      status: 'needs_input',
      startedAt: hoursAgo(5),
      priority: 'highest',
    }),
    pickRoom(2),
  ),
  wrap(
    makeTask({
      id: 'mock-n-4',
      title: 'Choose a vendor for user research recruiting',
      description:
        'Compared three: Respondent ($), UserInterviews ($$), Wynter ($$$). ' +
        'Pick one and I\'ll book the first batch.',
      status: 'needs_input',
      startedAt: hoursAgo(7),
    }),
    pickRoom(3),
  ),
]

// ── Now happening ──────────────────────────────────────────────────────────
const NOW_HAPPENING: HomeTask[] = [
  wrap(
    makeTask({
      id: 'mock-a-1',
      title: 'Summarise yesterday\'s 1:1 transcripts',
      description:
        'Working through the four transcripts. About 60% done — I\'ll surface ' +
        'common themes and any blockers per report at the end.',
      status: 'active',
      startedAt: minutesAgo(12),
      messageState: 'running',
    }),
    pickRoom(1),
  ),
  wrap(
    makeTask({
      id: 'mock-a-2',
      title: 'Reconcile last week\'s expense receipts',
      description:
        'Matching receipts to the credit-card statement. Two receipts missing — ' +
        'I\'ll flag those for you before submitting.',
      status: 'active',
      startedAt: minutesAgo(25),
      messageState: 'running',
    }),
    pickRoom(2),
  ),
  wrap(
    makeTask({
      id: 'mock-a-3',
      title: 'Draft the weekly product update',
      description:
        'Pulling shipped work from the Engineering room\'s "Done" lane + your ' +
        'top-of-mind notes. Will post a draft for review.',
      status: 'active',
      startedAt: hoursAgo(1),
      messageState: 'running',
    }),
    pickRoom(0),
  ),
]

// ── Recently done ──────────────────────────────────────────────────────────
const DONE: HomeTask[] = [
  wrap(
    makeTask({
      id: 'mock-d-1',
      title: 'Daily competitor pricing snapshot',
      description:
        'Snapshot saved. Notable change: Linear bumped Plus from $14 to $16. ' +
        'Diff vs. last week attached in the library.',
      status: 'complete',
      startedAt: hoursAgo(4),
      completedAt: hoursAgo(4),
      schedule: '0 9 * * *',
    }),
    pickRoom(1),
  ),
  wrap(
    makeTask({
      id: 'mock-d-2',
      title: 'Send the new-hire welcome packet to Jordan',
      description: 'Packet sent. Calendar holds for week 1 are scheduled too.',
      status: 'complete',
      startedAt: hoursAgo(9),
      completedAt: hoursAgo(9),
    }),
    pickRoom(0),
  ),
  wrap(
    makeTask({
      id: 'mock-d-3',
      title: 'Refresh the staging seed data',
      description:
        'Done — 1,240 rows seeded across 7 tables. Smoke tests passed, log in /tmp/seed.log.',
      status: 'complete',
      startedAt: daysAgo(1),
      completedAt: daysAgo(1),
    }),
    pickRoom(2),
  ),
  wrap(
    makeTask({
      id: 'mock-d-4',
      title: 'Pull a list of customers churned in the last 30 days',
      description:
        '17 accounts. Reasons cluster around onboarding friction (8) and pricing (4). ' +
        'Saved to library as `churn-2026-05-20.csv`.',
      status: 'complete',
      startedAt: daysAgo(2),
      completedAt: daysAgo(2),
    }),
    pickRoom(3),
  ),
  wrap(
    makeTask({
      id: 'mock-d-5',
      title: 'Archive last quarter\'s closed deals into the data room',
      description:
        '42 deal threads archived. Index updated. Nothing flagged for compliance.',
      status: 'complete',
      startedAt: daysAgo(3),
      completedAt: daysAgo(3),
    }),
    pickRoom(0),
  ),
]

/**
 * Returns the mock buckets — used by HomePage as a one-shot seed so the
 * carousel has something to render. Real buckets from `HomeWorkspaceTasks`
 * stream in alongside and are concatenated by the parent, so the mocks
 * sit beside any real data instead of replacing it.
 */
export function mockHomeBuckets(): HomeWorkspaceBuckets {
  return {
    needsInput: NEEDS_INPUT,
    active: NOW_HAPPENING,
    done: DONE,
  }
}
