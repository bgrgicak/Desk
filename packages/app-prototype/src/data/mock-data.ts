import { FileText, Zap, ImageIcon, Table, Globe, type LucideIcon } from 'lucide-react'

export type ArtifactType = 'document' | 'app' | 'image' | 'spreadsheet' | 'site'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  status?: string
  isGrouped?: boolean
}

export interface Artifact {
  id: string
  name: string
  type: ArtifactType
  agentName: string
  agentModel: string
  createdAt: Date
  updatedAt: Date
  content: string
  conversation: ChatMessage[]
  thumbnail?: string
}

// ── Inline UI cards shown below an agent message in the Today detail panel ────
export type InboxUICard =
  | {
      type: 'email-draft'
      to: string
      subject: string
      body: string
    }
  | {
      type: 'expense-flags'
      entries: { description: string; date: string; amount: string }[]
    }
  | {
      type: 'reconnect'
      service: string
      detail: string
    }

export interface InboxItem {
  id: string
  type: 'question' | 'completion' | 'error'
  agentName: string
  message: string
  artifactId?: string
  runId?: string
  timestamp: Date
  read: boolean
  quickReplies?: string[]
  uiCard?: InboxUICard
}

export interface TodoItem {
  id: string
  text: string
  done: boolean
  source: 'ai' | 'user'
}

export interface ContextItem {
  id: string
  type: 'file' | 'link' | 'note'
  name: string
  content: string
  folder?: string
  folderId?: string | null
  addedAt: Date
  usedBy: string[]
  uploadedBy: 'user' | 'ai'
  lastAccessed?: Date
  relatedArtifactIds: string[]
  fileSize?: string
  mimeType?: string
}

export interface Folder {
  id: string
  name: string
  parentId: string | null
  createdAt: Date
}

export interface RunOccurrence {
  id: string
  startedAt: Date
  endedAt: Date
  status: 'completed' | 'failed' | 'active'
  statusText?: string
}

export interface Run {
  id: string
  name: string
  agentName: string
  status: 'active' | 'completed' | 'paused' | 'failed'
  statusText: string
  startedAt: Date
  completedAt?: Date
  artifactIds: string[]
  scheduled?: boolean
  nextRun?: Date
  color: 'blue' | 'emerald' | 'amber' | 'violet' | 'slate' | 'rose' | 'orange'
  schedule?: string
  history: RunOccurrence[]
}

export interface Chat {
  id: string          // matches conversation ID used in ComposeOverlay
  title: string
  lastMessage: string // preview of the last message in the conversation
  updatedAt: Date
  createdAt: Date
  artifactIds?: string[]   // was: artifactId?: string
  messages?: ChatMessage[] // for standalone chats without an artifact
  unread?: boolean    // whether this chat has unseen activity
  referenceIds?: string[]  // context items from Library available in this chat
  workspaceId?: string     // which workspace this chat belongs to (for Today strip)
}

// ── Today screen types ────────────────────────────────────────────────────────
export type TodayItemType =
  | 'broken-connection'
  | 'decision-from-run'
  | 'agent-question'
  | 'calendar-prompt'
  | 'unresolved-follow-up'
  | 'user-todo'

export type TodayBand = 'right-now' | 'today' | 'this-week' | 'earlier'

export interface TodayChip { label: string }

export interface TodayItem {
  id: string
  type: TodayItemType
  ask: string          // hero line — plain English, truncates in list
  context: string      // agent's explanation (empty for user-todos)
  workspaceId: string
  workspaceName: string
  sourceLabel: string  // "Morning Digest run", "Calendar", "Added by you", …
  timestamp: Date
  band: TodayBand
  chips?: TodayChip[]
  routeToWorkspace?: boolean  // primary action routes out instead of chips
  note?: string               // user-todo notes
  attachment?: { name: string; size: string }
}

export interface ArtifactUpdate {
  id: string
  artifactId: string
  message: string
  timestamp: Date
}

export const MOCK_ARTIFACT_UPDATES: ArtifactUpdate[] = [
  {
    id: 'upd-1',
    artifactId: 'art-1',
    message: "I've refreshed the budget table with the latest Q2 actuals and updated the timeline milestones.",
    timestamp: new Date('2026-04-16T08:15:00'),
  },
  {
    id: 'upd-2',
    artifactId: 'art-2',
    message: "Added a CSV export button and a monthly breakdown chart to the expense tracker.",
    timestamp: new Date('2026-04-16T09:30:00'),
  },
  {
    id: 'upd-3',
    artifactId: 'art-3',
    message: "Refreshed all brand colours to match the new palette you shared yesterday.",
    timestamp: new Date('2026-04-15T17:45:00'),
  },
]

// ─── Mock Agents ───

export const MOCK_AGENTS = [
  { name: 'Claude Sonnet 4',  model: 'Claude Sonnet 4'  },
  { name: 'Claude Opus 4',    model: 'Claude Opus 4'    },
  { name: 'Claude Haiku 3.5', model: 'Claude Haiku 3.5' },
  { name: 'GPT-4o',           model: 'GPT-4o'           },
  { name: 'GPT-4o mini',      model: 'GPT-4o mini'      },
  { name: 'Summariser',       model: 'Claude Haiku 3.5' },
  { name: 'Research Pro',     model: 'GPT-4o'           },
  { name: 'Copywriter',       model: 'Claude Sonnet 4'  },
]

// ─── Providers + configurable agents (Settings → Agents) ───

export type ProviderKind = 'claude' | 'chatgpt' | 'other'

export interface Provider {
  id: string
  kind: ProviderKind
  name: string
  apiKey: string
  organizationId?: string
  baseUrl?: string
}

export interface SettingsAgent {
  id: string
  name: string
  providerId: string
  model: string
  instructions: string
  enabled: boolean
}

export const PROVIDER_MODELS: Record<ProviderKind, string[]> = {
  claude: ['Claude Sonnet 4', 'Claude Opus 4', 'Claude Haiku 3.5'],
  chatgpt: ['GPT-4o', 'GPT-4o mini', 'GPT-4 Turbo'],
  other: [],
}

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  other: 'Other',
}

export const MOCK_PROVIDERS: Provider[] = [
  {
    id: 'prov-claude',
    kind: 'claude',
    name: 'Claude',
    apiKey: 'sk-ant-••••••••••••••••••••••••1f4a',
    baseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'prov-chatgpt',
    kind: 'chatgpt',
    name: 'ChatGPT',
    apiKey: 'sk-••••••••••••••••••••••••••••••••f3c2',
    organizationId: 'org-acme',
    baseUrl: 'https://api.openai.com/v1',
  },
]

export const MOCK_SETTINGS_AGENTS: SettingsAgent[] = [
  {
    id: 'sa-summariser',
    name: 'Summariser',
    providerId: 'prov-claude',
    model: 'Claude Haiku 3.5',
    instructions: 'Summarise any input into three crisp bullet points. No fluff, no preamble.',
    enabled: true,
  },
  {
    id: 'sa-research-pro',
    name: 'Research Pro',
    providerId: 'prov-chatgpt',
    model: 'GPT-4o',
    instructions: 'Do deep, source-backed research. Prefer primary sources and cite everything with links.',
    enabled: true,
  },
  {
    id: 'sa-copywriter',
    name: 'Copywriter',
    providerId: 'prov-claude',
    model: 'Claude Sonnet 4',
    instructions: 'Write punchy, on-brand marketing copy. Warm, direct, never corporate.',
    enabled: false,
  },
]

// ─── Connections (Settings → Connections) ───

export type ConnectionKind =
  | 'claude' | 'chatgpt'
  | 'google-drive' | 'notion' | 'github' | 'slack' | 'figma' | 'linear' | 'web-clipper'

export interface ConnectionMeta {
  name: string
  description: string
  icon: string // emoji used when no brand mark applies
}

export const CONNECTION_CATALOG: Record<ConnectionKind, ConnectionMeta> = {
  'claude':       { name: 'Claude',       description: 'Claude models via the Anthropic API',  icon: '🅰️' },
  'chatgpt':      { name: 'ChatGPT',      description: 'OpenAI models via the OpenAI API',     icon: '🅶' },
  'google-drive': { name: 'Google Drive', description: 'Docs, Sheets and Slides',              icon: '📁' },
  'notion':       { name: 'Notion',       description: 'Pages and databases',                   icon: '📝' },
  'github':       { name: 'GitHub',       description: 'Repositories and issues',               icon: '🐙' },
  'slack':        { name: 'Slack',        description: 'Messages and channels',                 icon: '💬' },
  'figma':        { name: 'Figma',        description: 'Design files and prototypes',           icon: '🎨' },
  'linear':       { name: 'Linear',       description: 'Issues, projects and cycles',           icon: '🔷' },
  'web-clipper':  { name: 'Web Clipper',  description: 'Save pages from your browser',          icon: '🌐' },
}

export interface Connection {
  id: string
  kind: ConnectionKind
  name: string
  apiKey?: string
  baseUrl?: string
  enabled: boolean
}

export const MOCK_CONNECTIONS: Connection[] = [
  {
    id: 'conn-claude',
    kind: 'claude',
    name: 'Claude',
    apiKey: 'sk-ant-••••••••••••••••••••••••1f4a',
    baseUrl: 'https://api.anthropic.com',
    enabled: true,
  },
  {
    id: 'conn-chatgpt',
    kind: 'chatgpt',
    name: 'ChatGPT',
    apiKey: 'sk-••••••••••••••••••••••••••••••••f3c2',
    baseUrl: 'https://api.openai.com/v1',
    enabled: false,
  },
  {
    id: 'conn-notion',
    kind: 'notion',
    name: 'Notion',
    apiKey: 'secret_••••••••••••••••••••••••9b2d',
    enabled: true,
  },
  {
    id: 'conn-github',
    kind: 'github',
    name: 'GitHub',
    apiKey: 'ghp_••••••••••••••••••••••••••••7a1c',
    enabled: true,
  },
  {
    id: 'conn-slack',
    kind: 'slack',
    name: 'Slack',
    apiKey: 'xoxb-••••••••••••••••••••••••ae3f',
    enabled: false,
  },
  {
    id: 'conn-figma',
    kind: 'figma',
    name: 'Figma',
    apiKey: 'figd_••••••••••••••••••••••••62c8',
    enabled: false,
  },
]

// ─── Mock Artifacts ───

export const MOCK_ARTIFACTS: Artifact[] = [
  {
    id: 'art-1',
    name: 'Q2 Marketing Strategy',
    type: 'document',
    agentName: 'Copywriter',
    agentModel: 'Claude Sonnet 4',
    createdAt: new Date('2026-04-15T09:30:00'),
    updatedAt: new Date('2026-04-15T14:22:00'),
    content: `# Q2 Marketing Strategy

## Executive Summary

This quarter we're shifting focus toward community-led growth and reducing paid acquisition spend by 30%. The data from Q1 shows organic channels outperforming paid by 2.4x on retention metrics.

## Key Initiatives

### 1. Community Ambassador Program
Launch a structured ambassador program targeting power users who already share our product organically. Budget: $15,000/quarter for rewards and tooling.

**Success metrics:**
- 50 active ambassadors by end of Q2
- 200 referral signups per month
- 4.5+ average NPS from referred users

### 2. Content Engine Refresh
Move from weekly long-form blog posts to daily short-form content across LinkedIn, Twitter, and our community forum.

**Content calendar:**
- Monday: Product tip (short video)
- Tuesday: Customer spotlight
- Wednesday: Industry insight
- Thursday: Behind the scenes
- Friday: Community roundup

### 3. Partnership Pipeline
Establish co-marketing agreements with 3 complementary tools in our ecosystem.

**Target partners:**
- Notion (knowledge management overlap)
- Linear (project tracking integration)
- Loom (async communication)

## Budget Allocation

| Channel | Q1 Spend | Q2 Proposed | Change |
|---------|----------|-------------|--------|
| Paid Social | $45,000 | $31,500 | -30% |
| Content | $12,000 | $20,000 | +67% |
| Community | $5,000 | $15,000 | +200% |
| Partnerships | $0 | $8,000 | New |
| Events | $8,000 | $5,500 | -31% |

## Timeline

- **April 1-15:** Finalize ambassador criteria and onboarding flow
- **April 16-30:** Soft launch with 10 hand-picked ambassadors
- **May:** Full content calendar rollout + first partnership signed
- **June:** Mid-quarter review and budget reallocation based on performance`,
    conversation: [
      { id: 'm1-1', role: 'user',      content: 'Help me put together our Q2 marketing strategy. We want to shift toward community-led growth and reduce paid acquisition spend by 30%.',                                                                                                                                                                          timestamp: new Date('2026-04-16T09:10:00') },
      { id: 'm1-2', role: 'assistant', content: "I'll draft a comprehensive Q2 marketing strategy focused on community-led growth. Let me pull together the key components.",                                                                                                                                                                                   timestamp: new Date('2026-04-16T09:12:00') },
      { id: 'm1-3', role: 'assistant', content: "Here's your Q2 Marketing Strategy. I've structured it around three main initiatives: a community ambassador program, a refreshed content engine, and a partnership pipeline. The budget shifts 30% away from paid social toward community and content channels.",                                                timestamp: new Date('2026-04-16T09:20:00') },
      { id: 'm1-4', role: 'user',      content: 'Can you add a timeline section at the end?',                                                                                                                                                                                                                                                                 timestamp: new Date('2026-04-16T09:22:00') },
      { id: 'm1-5', role: 'assistant', content: "Done! I've added a month-by-month timeline covering April through June, with key milestones for each initiative.",                                                                                                                                                                                            timestamp: new Date('2026-04-16T09:25:00') },
    ],
  },
  {
    id: 'art-2',
    name: 'Expense Tracker',
    type: 'app',
    agentName: 'Claude',
    agentModel: 'Claude Opus 4',
    createdAt: new Date('2026-04-01T15:00:00'),
    updatedAt: new Date('2026-04-01T15:08:00'),
    content: 'app',
    conversation: [
      { id: 'm10-1', role: 'user',      content: "Can you build me an expense tracker? I need category breakdowns, a monthly budget cap per category, and the ability to export to CSV.",                                                                            timestamp: new Date('2026-04-01T14:45:00') },
      { id: 'm10-2', role: 'assistant', content: "Building your expense tracker now — categories, budget caps, and CSV export all included.",                                                                                                                        timestamp: new Date('2026-04-01T14:50:00') },
      { id: 'm10-3', role: 'assistant', content: "Your expense tracker is ready. It includes category breakdowns, a monthly budget limit per category, and a CSV export. Click the card to open it.",                                                               timestamp: new Date('2026-04-01T15:00:00') },
    ],
  },
  {
    id: 'art-3',
    name: 'Team Offsite Agenda',
    type: 'document',
    agentName: 'ChatGPT',
    agentModel: 'GPT-4o',
    createdAt: new Date('2026-04-13T10:28:00'),
    updatedAt: new Date('2026-04-13T10:32:00'),
    content: `# Team Offsite Agenda
## May 12-14, 2026 — Lake Tahoe

### Day 1: Alignment
| Time | Activity | Lead |
|------|----------|------|
| 9:00 | Welcome & icebreaker | Sarah |
| 10:00 | Company vision review | Marcus |
| 11:30 | Team health check | Everyone |
| 12:30 | Lunch | — |
| 14:00 | Q1 retrospective | Team leads |
| 15:30 | Break | — |
| 16:00 | Q2 goals workshop | Marcus |
| 18:00 | Group dinner | — |

### Day 2: Deep Work
| Time | Activity | Lead |
|------|----------|------|
| 9:00 | Cross-team project pitches | Everyone |
| 10:30 | Breakout sessions (3 tracks) | TBD |
| 12:30 | Lunch | — |
| 14:00 | Hackathon kickoff | Dev leads |
| 18:00 | Progress demos | Everyone |
| 19:00 | Casual dinner + games | — |

### Day 3: Wrap Up
| Time | Activity | Lead |
|------|----------|------|
| 9:00 | Hackathon final demos | Everyone |
| 10:30 | Action items & owners | Sarah |
| 11:30 | Feedback & close | Marcus |
| 12:00 | Lunch & departure | — |

### Logistics
- **Venue:** Lakefront Lodge, South Lake Tahoe
- **Travel:** Company covers flights + shuttle from Reno airport
- **Rooms:** Shared cabins (2 per cabin), assignments sent April 28
- **Dress code:** Casual. Bring layers — it's still cool in May.`,
    conversation: [
      { id: 'm5-1', role: 'user',      content: "We're planning a team offsite for 18 people, 2 nights, somewhere in the US. Budget around $15K all-in. We need workshop space and some social time.",                                                                                                                                       timestamp: new Date('2026-04-13T09:55:00') },
      { id: 'm5-2', role: 'assistant', content: "Looking at venues that fit — 18 people, workshop-ready, social-friendly, $15K ceiling.",                                                                                                                                                                                                   timestamp: new Date('2026-04-13T10:00:00') },
      { id: 'm5-3', role: 'assistant', content: "I've shortlisted three venues within your budget: The Foundry in Brooklyn, Basecamp Marin, and The Greenhouse in Austin. Each has pros and cons — want a side-by-side comparison?",                                                                                                          timestamp: new Date('2026-04-13T10:10:00') },
      { id: 'm5-4', role: 'user',      content: "Yes please, and flag which one has the best AV setup.",                                                                                                                                                                                                                                    timestamp: new Date('2026-04-13T10:12:00') },
      { id: 'm5-5', role: 'assistant', content: "Best AV setup is The Foundry — dedicated presentation room with 4K projection, a PA system, and an on-site tech coordinator included in the rate. But Basecamp Marin wins overall on outdoor space and cabin atmosphere.",                                                                   timestamp: new Date('2026-04-13T10:18:00') },
      { id: 'm5-6', role: 'user',      content: "We'll go with Basecamp Marin. Can you draft a 3-day agenda? Mix of strategy, team-building, and a hackathon. 20 people, mid-May in Lake Tahoe.",                                                                                                                                           timestamp: new Date('2026-04-13T10:19:00') },
      { id: 'm5-7', role: 'assistant', content: "Here's your 3-day offsite agenda for Basecamp Marin in mid-May. Day 1 focuses on alignment and retrospective, Day 2 has deep-work tracks and a hackathon, and Day 3 wraps up with demos and action items. I've included time blocks, leads, and a logistics section.",                      timestamp: new Date('2026-04-13T10:28:00') },
    ],
  },
  {
    id: 'art-4',
    name: 'Brand Color Palette',
    type: 'image',
    agentName: 'Claude',
    agentModel: 'Claude Haiku 3.5',
    createdAt: new Date('2026-03-11T09:00:00'),
    updatedAt: new Date('2026-03-11T09:10:00'),
    content: 'image',
    conversation: [
      { id: 'm16-1', role: 'user',      content: "Can you explore some color palette options for the brand? We want to move away from the current cold blues. Leaning warmer or more neutral.",                                                                                                                                                   timestamp: new Date('2026-03-11T08:50:00') },
      { id: 'm16-2', role: 'assistant', content: "Exploring palette directions — shifting away from cool blues toward warm and neutral tones.",                                                                                                                                                                                               timestamp: new Date('2026-03-11T08:55:00') },
      { id: 'm16-3', role: 'assistant', content: "I've generated five palette options ranging from earthy and warm to cool and minimal. Each comes with accessible contrast ratios for text and background combinations.",                                                                                                                     timestamp: new Date('2026-03-11T09:00:00') },
    ],
  },
  {
    id: 'art-5',
    name: 'Customer Interview Notes',
    type: 'document',
    agentName: 'Summariser',
    agentModel: 'Claude Haiku 3.5',
    createdAt: new Date('2026-04-11T08:55:00'),
    updatedAt: new Date('2026-04-11T09:01:00'),
    content: `# Customer Interview Notes
## April 11, 2026 — Acme Corp (Enterprise)

**Interviewee:** Jamie Rodriguez, Head of Operations
**Interviewer:** You
**Duration:** 30 minutes

### Key Quotes

> "We spend about 3 hours a day just moving data between spreadsheets. If something could automate even half of that, we'd save 30 hours a week across the team."

> "The last tool we tried was too technical. My team isn't engineers — they need something that just works."

> "We need to trust the output. If the AI makes a mistake on a client invoice, that's a real problem."

### Pain Points
1. **Manual data transfer** — copying between spreadsheets, CRM, and invoicing
2. **Tool complexity** — previous solutions required technical setup
3. **Trust in output** — need confidence in accuracy for client-facing work

### Opportunities
- Automated data sync between their existing tools
- Natural language interface (no technical knowledge needed)
- Verification step before any client-facing output

### Follow-up Actions
- [ ] Send them a sandbox to test our data sync feature
- [ ] Schedule follow-up in 2 weeks
- [ ] Share findings with product team

### Sentiment
**Overall:** Very positive. High intent to adopt if we solve the trust problem.`,
    conversation: [
      { id: 'm6-1', role: 'user',      content: "I just finished an interview with Jamie Rodriguez, Head of Operations at Acme Corp. Here are my rough notes — can you clean them up into a structured format?\n\nJamie, Acme Corp, Head of Ops. 30 min call. Spends ~3hrs/day moving data between spreadsheets. Tried another tool but team found it too technical. Big worry about AI accuracy on client invoices. Very interested if we can solve the trust problem.",  timestamp: new Date('2026-04-11T08:48:00') },
      { id: 'm6-2', role: 'assistant', content: "Cleaning up and structuring your interview notes now.",                                                                                                                                                                                                                                                                                                                                                                                      timestamp: new Date('2026-04-11T08:50:00') },
      { id: 'm6-3', role: 'assistant', content: "Here are your structured interview notes for Jamie Rodriguez at Acme Corp. I've organised them into key quotes, pain points, opportunities, and follow-up actions. The three main themes are: manual data transfer, tool complexity, and trust in AI accuracy.",                                                                                                                                                                           timestamp: new Date('2026-04-11T08:55:00') },
    ],
  },
  {
    id: 'art-6',
    name: 'Weekly Standup Dashboard',
    type: 'app',
    agentName: 'ChatGPT',
    agentModel: 'GPT-4o mini',
    createdAt: new Date('2026-04-04T09:25:00'),
    updatedAt: new Date('2026-04-04T09:31:00'),
    content: 'app',
    conversation: [
      { id: 'm9-1', role: 'user',      content: "Can you build a weekly standup dashboard? It should show last week's velocity, open blockers, and shipping targets. I want it to refresh automatically every Monday morning.",                                      timestamp: new Date('2026-04-04T09:10:00') },
      { id: 'm9-2', role: 'assistant', content: "Building the standup dashboard now — velocity, blockers, and shipping targets with a Monday 8am auto-refresh.",                                                                                                   timestamp: new Date('2026-04-04T09:15:00') },
      { id: 'm9-3', role: 'assistant', content: "The dashboard is live. It pulls last week's velocity, open blockers, and shipping targets automatically. Refresh happens every Monday at 8am.",                                                                    timestamp: new Date('2026-04-04T09:25:00') },
    ],
  },
  {
    id: 'art-7',
    name: 'Product Roadmap Q2-Q3',
    type: 'spreadsheet',
    agentName: 'Research Pro',
    agentModel: 'GPT-4o',
    createdAt: new Date('2026-04-06T11:00:00'),
    updatedAt: new Date('2026-04-06T11:08:00'),
    content: `# Product Roadmap Q2-Q3 2026

## Q2: Foundation
| Initiative | Owner | Status | Target |
|-----------|-------|--------|--------|
| User authentication v2 | Engineering | In Progress | Apr 30 |
| Dashboard redesign | Design | Planning | May 15 |
| API rate limiting | Infrastructure | Not Started | May 30 |
| Mobile app beta | Mobile | In Progress | Jun 15 |
| Analytics pipeline | Data | Planning | Jun 30 |

## Q3: Growth
| Initiative | Owner | Status | Target |
|-----------|-------|--------|--------|
| Team workspaces | Engineering | Not Started | Jul 31 |
| Integrations marketplace | Platform | Not Started | Aug 15 |
| Enterprise SSO | Security | Not Started | Aug 31 |
| Performance optimization | Infrastructure | Not Started | Sep 15 |
| Public API v2 | Platform | Not Started | Sep 30 |`,
    conversation: [
      { id: 'm8-1', role: 'user',      content: "Can you create a product roadmap covering Q2 and Q3? I need owner, status, and target dates across engineering, design, and infrastructure.",                                                                      timestamp: new Date('2026-04-06T10:48:00') },
      { id: 'm8-2', role: 'assistant', content: "Building the Q2-Q3 roadmap now — I'll include owner, status, and target dates across all teams.",                                                                                                               timestamp: new Date('2026-04-06T10:50:00') },
      { id: 'm8-3', role: 'assistant', content: "Here's your Q2-Q3 roadmap with 10 initiatives across engineering, design, infrastructure, and platform teams. Q2 focuses on foundation work (auth, dashboard, mobile), Q3 shifts to growth features (workspaces, integrations, enterprise).", timestamp: new Date('2026-04-06T11:00:00') },
    ],
  },
  {
    id: 'art-8',
    name: 'Landing Page',
    type: 'site',
    agentName: 'Claude',
    agentModel: 'Claude Opus 4',
    createdAt: new Date('2026-04-08T13:00:00'),
    updatedAt: new Date('2026-04-08T14:30:00'),
    content: 'site',
    conversation: [
      {
        id: 'msg-8-1',
        role: 'user',
        content: "Build a landing page for our product launch. Hero section with headline and CTA, features grid (3 features), social proof section with testimonials, and a final CTA. Keep it clean and modern.",
        timestamp: new Date('2026-04-08T13:00:00'),
      },
      {
        id: 'msg-8-2',
        role: 'assistant',
        content: "Your landing page is live! It includes a bold hero section, three feature cards with icons, a testimonials carousel, and a bottom CTA. The design is minimal with plenty of whitespace.",
        timestamp: new Date('2026-04-08T13:02:00'),
      },
      {
        id: 'msg-8-3',
        role: 'user',
        content: 'Make the hero headline bigger and add an animation when the page loads',
        timestamp: new Date('2026-04-08T14:25:00'),
      },
      {
        id: 'msg-8-4',
        role: 'assistant',
        content: "Updated! The hero headline is now larger with a fade-in animation on load. The feature cards also stagger in as you scroll down.",
        timestamp: new Date('2026-04-08T14:30:00'),
      },
    ],
  },
]

// ─── Mock Inbox Items ───

export const MOCK_INBOX: InboxItem[] = [
  {
    id: 'inbox-1',
    type: 'question',
    agentName: 'Claude',
    message: 'I found 3 emails about the Henderson project deadline. Should I draft replies for all of them, or just the one from your manager?',
    artifactId: undefined,
    runId: 'run-1',
    timestamp: new Date('2026-04-22T08:15:00'),
    read: false,
    quickReplies: ['Just my manager\'s', 'Draft all three'],
    uiCard: {
      type: 'email-draft',
      to: 'Sarah Henderson <s.henderson@acme.com>',
      subject: 'Re: Henderson Project — April 25 Deadline',
      body: "Hi Sarah,\n\nThanks for the update. We're on track for the April 25 deadline. I'll have the final deliverables over to you by EOD Friday.\n\nBest,\nJaroslaw",
    },
  },
  {
    id: 'inbox-2',
    type: 'completion',
    agentName: 'Claude',
    message: 'Your weekly summary is ready. 12 tasks completed, 3 carried over.',
    artifactId: 'art-1',
    timestamp: new Date('2026-04-22T07:00:00'),
    read: false,
  },
  {
    id: 'inbox-3',
    type: 'question',
    agentName: 'Claude',
    message: "The expense report has two entries without receipts. Want me to flag them or skip them?",
    artifactId: 'art-2',
    timestamp: new Date('2026-04-21T22:30:00'),
    read: true,
    quickReplies: ['Flag them', 'Skip them'],
    uiCard: {
      type: 'expense-flags',
      entries: [
        { description: 'Client lunch — Café Merci', date: 'Apr 8', amount: '$124.50' },
        { description: 'Taxi to HQ', date: 'Apr 11', amount: '$42.00' },
      ],
    },
  },
  {
    id: 'inbox-4',
    type: 'completion',
    agentName: 'Claude',
    message: 'Landing page updates are deployed. The hero animation is now live.',
    artifactId: 'art-8',
    timestamp: new Date('2026-04-19T14:30:00'),
    read: true,
  },
  {
    id: 'inbox-5',
    type: 'error',
    agentName: 'Claude',
    message: "Couldn't sync your calendar — the connection to Google Calendar needs to be refreshed.",
    runId: 'run-3',
    timestamp: new Date('2026-04-14T06:00:00'),
    read: true,
    uiCard: {
      type: 'reconnect',
      service: 'Google Calendar',
      detail: 'Last synced Apr 14 · 847 events',
    },
  },
]

// ─── Mock Todos ───

export const MOCK_TODOS: TodoItem[] = [
  { id: 'todo-1', text: 'Review Q2 marketing budget with Sarah', done: false, source: 'ai' },
  { id: 'todo-2', text: 'Send offsite venue confirmation', done: false, source: 'user' },
  { id: 'todo-3', text: 'Follow up with Acme Corp in 2 weeks', done: false, source: 'ai' },
  { id: 'todo-4', text: 'Update team on roadmap changes', done: true, source: 'user' },
]

// ─── Mock Today items (8 covering all item types) ───

export const MOCK_TODAY_ITEMS: TodayItem[] = [
  {
    id: 'today-1',
    type: 'broken-connection',
    ask: 'Reconnect your Google Calendar.',
    context: "Your Morning Digest couldn't run this morning because your Google Calendar connection expired at 9:04 am. I've paused the run until you reconnect. Reconnecting will resume tomorrow's digest automatically.",
    workspaceId: 'general',
    workspaceName: 'General',
    sourceLabel: 'Morning Digest',
    timestamp: new Date('2026-04-21T09:04:00'),
    band: 'right-now',
    chips: [{ label: 'Reconnect' }, { label: 'Remind me later' }, { label: 'Ignore' }],
  },
  {
    id: 'today-2',
    type: 'decision-from-run',
    ask: 'Approve the draft reply to Sarah Chen?',
    context: "Your Weekly Comms run drafted a reply to Sarah's message about the Q2 budget review. It's polite, confirms your availability, and proposes Thursday at 3 pm as a meeting time. I'm holding it until you approve.",
    workspaceId: 'work',
    workspaceName: 'Work',
    sourceLabel: 'Weekly Comms run',
    timestamp: new Date('2026-04-21T08:47:00'),
    band: 'right-now',
    chips: [{ label: 'Approve' }, { label: 'Edit before sending' }, { label: 'Cancel' }],
  },
  {
    id: 'today-3',
    type: 'calendar-prompt',
    ask: 'Quarterly review is in 2 hours — want talking points?',
    context: "Your calendar shows a Q2 Quarterly Review at 3:00 pm today. I can pull together a summary of Q2 progress, open blockers, and highlights from your recent runs and docs. Takes about 3 minutes.",
    workspaceId: 'work',
    workspaceName: 'Work',
    sourceLabel: 'Calendar',
    timestamp: new Date('2026-04-21T13:02:00'),
    band: 'today',
    chips: [{ label: 'Yes, prep them' }, { label: 'Not needed' }, { label: 'Remind me in 1 hour' }],
  },
  {
    id: 'today-4',
    type: 'agent-question',
    ask: 'Keep the current expense format or switch to the new template?',
    context: "I noticed you have expense reports in two different formats. The new finance team template uses pivot tables and is easier to reconcile at month-end. Switching your existing reports would take about 15 minutes.",
    workspaceId: 'work',
    workspaceName: 'Work',
    sourceLabel: 'Work agent',
    timestamp: new Date('2026-04-21T10:15:00'),
    band: 'today',
    chips: [{ label: 'Keep current' }, { label: 'Switch template' }, { label: 'Decide later' }],
  },
  {
    id: 'today-5',
    type: 'agent-question',
    ask: 'Your Morning Digest found 3 items worth reviewing.',
    context: "This morning's digest flagged a competitor product launch, a pricing change from one of your vendors, and a new research paper relevant to your current project. Open General to see the full digest with links.",
    workspaceId: 'general',
    workspaceName: 'General',
    sourceLabel: 'Morning Digest run',
    timestamp: new Date('2026-04-21T07:30:00'),
    band: 'today',
    routeToWorkspace: true,
  },
  {
    id: 'today-6',
    type: 'unresolved-follow-up',
    ask: 'You left the Douro trip planning unfinished.',
    context: "You were comparing Douro Valley rental properties on Monday and closed the chat before deciding. There are 3 shortlisted options and a pricing comparison ready to review whenever you pick it back up.",
    workspaceId: 'general',
    workspaceName: 'General',
    sourceLabel: 'Douro trip chat',
    timestamp: new Date('2026-04-19T15:22:00'),
    band: 'this-week',
    routeToWorkspace: true,
  },
  {
    id: 'today-7',
    type: 'user-todo',
    ask: 'Review Q2 budget proposals.',
    context: '',
    workspaceId: 'work',
    workspaceName: 'Work',
    sourceLabel: 'Added by you',
    timestamp: new Date('2026-04-20T09:00:00'),
    band: 'this-week',
    note: "Sarah sent two versions — conservative (headcount flat) and aggressive (adds 3 engineers in H2). Both are in the Finance folder.",
  },
  {
    id: 'today-8',
    type: 'user-todo',
    ask: 'Sign off on the Creative Lab brief.',
    context: '',
    workspaceId: 'creative',
    workspaceName: 'Creative Lab',
    sourceLabel: 'Added by you',
    timestamp: new Date('2026-04-17T14:30:00'),
    band: 'earlier',
    attachment: { name: 'Creative Lab Brief v2.pdf', size: '340 KB' },
  },
]

// ─── Mock Folders ───

export const MOCK_FOLDERS: Folder[] = [
  { id: 'fld-finance', name: 'Finance', parentId: null, createdAt: new Date('2026-03-15T09:00:00') },
  { id: 'fld-strategy', name: 'Strategy', parentId: null, createdAt: new Date('2026-03-10T09:00:00') },
  { id: 'fld-design', name: 'Design', parentId: null, createdAt: new Date('2026-03-08T09:00:00') },
  { id: 'fld-research', name: 'Research', parentId: null, createdAt: new Date('2026-03-20T09:00:00') },
  // Subfolders
  { id: 'fld-q1-reports', name: 'Q1 Reports', parentId: 'fld-finance', createdAt: new Date('2026-04-01T09:00:00') },
  { id: 'fld-customer-interviews', name: 'Customer interviews', parentId: 'fld-research', createdAt: new Date('2026-04-05T09:00:00') },
]

// ─── Mock Context Items ───

export const MOCK_CONTEXT: ContextItem[] = [
  {
    id: 'ctx-1',
    type: 'file',
    name: 'Q1 Revenue Report.xlsx',
    content: 'Spreadsheet with Q1 2026 revenue data by product line and region.',
    folder: 'Finance',
    folderId: 'fld-q1-reports',
    addedAt: new Date('2026-04-10T09:00:00'),
    usedBy: ['Claude'],
    uploadedBy: 'user',
    lastAccessed: new Date('2026-04-15T09:30:00'),
    relatedArtifactIds: ['art-1'],
    fileSize: '2.4 MB',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    id: 'ctx-2',
    type: 'link',
    name: 'Competitor Analysis — Notion',
    content: 'https://notion.so/team/competitor-analysis-2026',
    folder: 'Strategy',
    folderId: 'fld-strategy',
    addedAt: new Date('2026-04-08T14:30:00'),
    usedBy: [],
    uploadedBy: 'user',
    relatedArtifactIds: [],
  },
  {
    id: 'ctx-3',
    type: 'file',
    name: 'Brand Guidelines v3.pdf',
    content: 'Updated brand guidelines including new color palette and typography.',
    folder: 'Design',
    folderId: 'fld-design',
    addedAt: new Date('2026-04-05T11:00:00'),
    usedBy: ['Claude'],
    uploadedBy: 'user',
    lastAccessed: new Date('2026-04-12T14:20:00'),
    relatedArtifactIds: ['art-4'],
    fileSize: '8.1 MB',
    mimeType: 'application/pdf',
  },
  {
    id: 'ctx-4',
    type: 'note',
    name: 'Product principles',
    content: '1. Simple by default, powerful when needed\n2. Show, don\'t tell\n3. Earn trust through transparency\n4. Speed is a feature',
    folder: 'Strategy',
    folderId: 'fld-strategy',
    addedAt: new Date('2026-04-03T16:00:00'),
    usedBy: ['Claude'],
    uploadedBy: 'user',
    relatedArtifactIds: [],
  },
  {
    id: 'ctx-5',
    type: 'file',
    name: 'Customer Interview — Acme Corp.mp3',
    content: '30-minute recorded interview with Jamie Rodriguez, Head of Operations.',
    folder: 'Research',
    folderId: 'fld-customer-interviews',
    addedAt: new Date('2026-04-11T10:00:00'),
    usedBy: ['Claude'],
    uploadedBy: 'user',
    lastAccessed: new Date('2026-04-11T10:15:00'),
    relatedArtifactIds: ['art-5'],
    fileSize: '24.3 MB',
    mimeType: 'audio/mpeg',
  },
  {
    id: 'ctx-6',
    type: 'link',
    name: 'Design System — Figma',
    content: 'https://figma.com/file/abc123/design-system',
    folder: 'Design',
    folderId: 'fld-design',
    addedAt: new Date('2026-04-01T09:00:00'),
    usedBy: [],
    uploadedBy: 'ai',
    relatedArtifactIds: ['art-8'],
  },
  // Items at root (no folder) — to demonstrate mixing folders and items
  {
    id: 'ctx-7',
    type: 'note',
    name: 'Quick thoughts on onboarding',
    content: 'New users get lost in the first 30 seconds. Need to clarify the value prop above the fold.',
    folderId: null,
    addedAt: new Date('2026-04-14T11:30:00'),
    usedBy: [],
    uploadedBy: 'user',
    relatedArtifactIds: [],
  },
  {
    id: 'ctx-8',
    type: 'file',
    name: 'Q2 OKRs draft.pdf',
    content: 'Draft of Q2 objectives and key results, pending leadership review.',
    folderId: null,
    addedAt: new Date('2026-04-13T15:00:00'),
    usedBy: ['Claude'],
    uploadedBy: 'user',
    lastAccessed: new Date('2026-04-14T10:00:00'),
    relatedArtifactIds: [],
    fileSize: '1.2 MB',
    mimeType: 'application/pdf',
  },
]

// ─── Folder helpers ───

export function getFolderById(id: string | null | undefined): Folder | undefined {
  if (!id) return undefined
  return MOCK_FOLDERS.find(f => f.id === id)
}

export function getFolderPath(folderId: string | null): Folder[] {
  const path: Folder[] = []
  let current = getFolderById(folderId)
  while (current) {
    path.unshift(current)
    current = getFolderById(current.parentId)
  }
  return path
}

export function getChildFolders(parentId: string | null): Folder[] {
  return MOCK_FOLDERS.filter(f => f.parentId === parentId)
}

export function getItemsInFolder(folderId: string | null, items: ContextItem[]): ContextItem[] {
  return items.filter(i => (i.folderId ?? null) === folderId)
}

export function countItemsRecursive(folderId: string, items: ContextItem[]): number {
  // Count items directly in this folder + items in any descendant folder
  const descendantIds = new Set<string>([folderId])
  let added = true
  while (added) {
    added = false
    for (const f of MOCK_FOLDERS) {
      if (f.parentId && descendantIds.has(f.parentId) && !descendantIds.has(f.id)) {
        descendantIds.add(f.id)
        added = true
      }
    }
  }
  return items.filter(i => i.folderId && descendantIds.has(i.folderId)).length
}

// ─── Mock Runs ───

// Helper to make weekday occurrences for April 2026
// April 2026: Mon Apr 6 – Wed Apr 15 (weekdays), then Apr 16 is Thu
function _makeWeekdayOccurrences(
  runId: string,
  hour: number,
  durationMins: number,
  currentStatus: 'completed' | 'failed' | 'active',
  currentStatusText?: string,
): RunOccurrence[] {
  const weekdays: RunOccurrence[] = []
  // April 1 (Wed) through April 15 (Wed) — all weekdays except today's (Apr 16 handled separately)
  for (let day = 1; day <= 15; day++) {
    const d = new Date(`2026-04-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`)
    const dow = d.getDay()
    if (dow === 0 || dow === 6) continue // skip weekends
    const end = new Date(d.getTime() + durationMins * 60_000)
    weekdays.push({
      id: `${runId}-apr${day}`,
      startedAt: d,
      endedAt: end,
      status: 'completed',
      statusText: 'Completed successfully',
    })
  }
  // Today Apr 16 occurrence
  const todayStart = new Date(`2026-04-16T${String(hour).padStart(2, '0')}:00:00`)
  const todayEnd = new Date(todayStart.getTime() + durationMins * 60_000)
  weekdays.push({
    id: `${runId}-apr16`,
    startedAt: todayStart,
    endedAt: todayEnd,
    status: currentStatus,
    statusText: currentStatusText,
  })
  return weekdays.reverse() // most recent first
}

function _makeThursdayOccurrences(runId: string, hour: number, durationMins: number): RunOccurrence[] {
  // Thursdays in April 2026: Apr 2, 9, 16 (today) + next would be Apr 23
  const thursdays = [2, 9]
  const result: RunOccurrence[] = thursdays.map(day => {
    const start = new Date(`2026-04-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`)
    const end = new Date(start.getTime() + durationMins * 60_000)
    return {
      id: `${runId}-apr${day}`,
      startedAt: start,
      endedAt: end,
      status: 'completed' as const,
      statusText: 'Summarised 47 updates from 8 team members.',
    }
  })
  // Today Apr 16 (Thursday) occurrence
  const todayStart = new Date(`2026-04-16T${String(hour).padStart(2, '0')}:00:00`)
  result.push({
    id: `${runId}-apr16`,
    startedAt: todayStart,
    endedAt: new Date(todayStart.getTime() + durationMins * 60_000),
    status: 'completed',
    statusText: 'Finished. Summarised 47 updates from 8 team members.',
  })
  return result.reverse()
}

function _makeWednesdayOccurrences(runId: string, hour: number, durationMins: number): RunOccurrence[] {
  // Wednesdays in April 2026: Apr 1, 8, 15
  const wednesdays = [1, 8, 15]
  return wednesdays.map(day => {
    const start = new Date(`2026-04-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`)
    const end = new Date(start.getTime() + durationMins * 60_000)
    return {
      id: `${runId}-apr${day}`,
      startedAt: start,
      endedAt: end,
      status: day === 15 ? 'failed' : 'completed' as 'completed' | 'failed',
      statusText: day === 15
        ? "Couldn't connect to Google Calendar. The connection needs to be refreshed."
        : 'Sync completed. 12 events updated.',
    }
  }).reverse()
}

export const MOCK_RUNS: Run[] = [
  {
    id: 'run-1',
    name: 'Morning email digest',
    agentName: 'Claude',
    status: 'active',
    statusText: 'Reading your inbox and sorting by priority...',
    startedAt: new Date('2026-04-16T08:00:00'),
    artifactIds: [],
    scheduled: true,
    nextRun: new Date('2026-04-17T08:00:00'),
    color: 'blue',
    schedule: 'Daily at 8 am',
    history: _makeWeekdayOccurrences('run-1', 8, 4, 'active', 'Reading your inbox and sorting by priority...'),
  },
  {
    id: 'run-2',
    name: 'Weekly team summary',
    agentName: 'Claude',
    status: 'completed',
    statusText: 'Finished. Summarised 47 updates from 8 team members.',
    startedAt: new Date('2026-04-16T07:00:00'),
    completedAt: new Date('2026-04-16T07:02:00'),
    artifactIds: ['art-1'],
    scheduled: true,
    nextRun: new Date('2026-04-23T07:00:00'),
    color: 'emerald',
    schedule: 'Every Thursday at 7 am',
    history: _makeThursdayOccurrences('run-2', 7, 2),
  },
  {
    id: 'run-3',
    name: 'Calendar sync',
    agentName: 'Claude',
    status: 'failed',
    statusText: "Couldn't connect to Google Calendar. The connection needs to be refreshed.",
    startedAt: new Date('2026-04-15T06:00:00'),
    completedAt: new Date('2026-04-15T06:00:30'),
    artifactIds: [],
    scheduled: true,
    nextRun: new Date('2026-04-16T06:00:00'),
    color: 'slate',
    schedule: 'Daily at 6 am',
    history: _makeWednesdayOccurrences('run-3', 6, 1),
  },
  {
    id: 'run-4',
    name: 'Expense report compilation',
    agentName: 'Claude',
    status: 'paused',
    statusText: 'Waiting for your input — found entries without receipts.',
    startedAt: new Date('2026-04-15T22:00:00'),
    artifactIds: ['art-2'],
    color: 'amber',
    schedule: 'Every Wednesday at 10 pm',
    history: [
      {
        id: 'run-4-apr15',
        startedAt: new Date('2026-04-15T22:00:00'),
        endedAt: new Date('2026-04-15T22:05:00'),
        status: 'active',
        statusText: 'Waiting for your input — found entries without receipts.',
      },
      {
        id: 'run-4-apr08',
        startedAt: new Date('2026-04-08T22:00:00'),
        endedAt: new Date('2026-04-08T22:03:00'),
        status: 'completed',
        statusText: 'Report compiled. 24 expenses processed.',
      },
      {
        id: 'run-4-apr01',
        startedAt: new Date('2026-04-01T22:00:00'),
        endedAt: new Date('2026-04-01T22:04:00'),
        status: 'completed',
        statusText: 'Report compiled. 18 expenses processed.',
      },
    ],
  },
  {
    id: 'run-5',
    name: 'Landing page deployment',
    agentName: 'Claude',
    status: 'completed',
    statusText: 'Successfully deployed. All changes are live.',
    startedAt: new Date('2026-04-15T14:25:00'),
    completedAt: new Date('2026-04-15T14:30:00'),
    artifactIds: ['art-8'],
    color: 'violet',
    history: [
      {
        id: 'run-5-apr15',
        startedAt: new Date('2026-04-15T14:25:00'),
        endedAt: new Date('2026-04-15T14:30:00'),
        status: 'completed',
        statusText: 'Successfully deployed. All changes are live.',
      },
    ],
  },
  {
    id: 'run-6',
    name: 'Data migration',
    agentName: 'Claude',
    status: 'active',
    statusText: 'Migrating records from legacy database — 68% complete.',
    startedAt: new Date('2026-04-14T09:00:00'),
    artifactIds: [],
    color: 'orange',
    history: [
      {
        id: 'run-6-apr14-16',
        startedAt: new Date('2026-04-14T09:00:00'),
        endedAt: new Date('2026-04-16T18:00:00'),
        status: 'active',
        statusText: 'Migrating records from legacy database — 68% complete.',
      },
    ],
  },
]

// ─── Mock Chats ───
// Dates are relative to the fixed "now" used in getRelativeTime (2026-04-16)
const _cd = (daysAgo: number, hour = 10, min = 0) => {
  const dt = new Date('2026-04-16T00:00:00')
  dt.setDate(dt.getDate() - daysAgo)
  dt.setHours(hour, min, 0, 0)
  return dt
}

export const MOCK_CHATS: Chat[] = [
  // ── Today ──
  { id: 'm-1', title: 'Q2 Marketing Strategy',               workspaceId: 'work',    updatedAt: _cd(0,  9, 30), createdAt: _cd(0,  9, 10), artifactIds: ['art-1'], unread: true, referenceIds: ['ctx-1', 'ctx-4'], lastMessage: "I've updated the influencer outreach section with the revised budget figures and added two new campaign pillars for the social push in June.", messages: [
    { id: 'm1-1', role: 'user',      content: "Help me put together our Q2 marketing strategy. We want to shift toward community-led growth and reduce paid acquisition spend by 30%.",                                                                            timestamp: _cd(0,  9, 10) },
    { id: 'm1-2', role: 'assistant', content: "I'll draft a comprehensive Q2 marketing strategy focused on community-led growth. Let me pull together the key components.",                                                                                        timestamp: _cd(0,  9, 12) },
    { id: 'm1-3', role: 'assistant', content: "Here's your Q2 Marketing Strategy. I've structured it around three main initiatives: a community ambassador program, a refreshed content engine, and a partnership pipeline. The budget shifts 30% away from paid social toward community and content channels.",                timestamp: _cd(0,  9, 20) },
    { id: 'm1-4', role: 'user',      content: "Can you add a timeline section at the end?",                                                                                                                                                                       timestamp: _cd(0,  9, 22) },
    { id: 'm1-5', role: 'assistant', content: "Done! I've added a month-by-month timeline covering April through June, with key milestones for each initiative.",                                                                                                  timestamp: _cd(0,  9, 25) },
    { id: 'm1-6', role: 'user',      content: "Can you update the influencer outreach section — budget moved from $80K to $65K — and add two new campaign pillars for the June social push?",                                                                     timestamp: _cd(0,  9, 27) },
    { id: 'm1-7', role: 'assistant', content: "I've updated the influencer outreach section with the revised budget figures and added two new campaign pillars for the social push in June: \"Community-first storytelling\" and \"Creator micro-series\".",        timestamp: _cd(0,  9, 30) },
  ] },
  { id: 'm-2', title: 'Tweaks to the expense tracker',       workspaceId: 'work',    updatedAt: _cd(0, 11, 15), createdAt: _cd(0, 11, 15), artifactIds: ['art-2'], lastMessage: "Done — the monthly totals now roll up automatically and I've added a colour-coded overspend indicator in column F.", messages: [
    { id: 'm2-1', role: 'user',      content: "Two tweaks to the expense tracker please: make the monthly totals roll up automatically instead of being hardcoded, and add a colour-coded indicator for overspend.",                                               timestamp: _cd(0, 11,  5) },
    { id: 'm2-2', role: 'assistant', content: "Got it — updating the formulas and adding the indicator now.",                                                                                                                                                      timestamp: _cd(0, 11,  7) },
    { id: 'm2-3', role: 'assistant', content: "Done — the monthly totals now roll up automatically and I've added a colour-coded overspend indicator in column F. Green when under budget, amber within 10%, red beyond that.",                                    timestamp: _cd(0, 11, 15) },
    { id: 'm2-4', role: 'user',      content: "Perfect. Can you also add a \"Notes\" column at the end of each row?",                                                                                                                                              timestamp: _cd(0, 11, 17) },
    { id: 'm2-5', role: 'assistant', content: "Added a free-text Notes column (column H) to every row. It auto-resizes and won't affect any of the sum formulas.",                                                                                                timestamp: _cd(0, 11, 19) },
  ] },
  { id: 'm-3', title: "What's the churn rate in the Q1 report?", workspaceId: 'general', updatedAt: _cd(0, 14,  0), createdAt: _cd(0, 14,  0), referenceIds: ['ctx-1'], lastMessage: "Based on the Q1 report, your churn rate was 3.2%, down from 4.1% the previous quarter. The biggest improvement was in the SMB segment.", messages: [
    { id: 'm3-1', role: 'user',      content: "What's the churn rate in the Q1 report?",                                                                                                                                                          timestamp: _cd(0, 13, 58) },
    { id: 'm3-2', role: 'assistant', content: "Based on the Q1 report, your churn rate was 3.2%, down from 4.1% the previous quarter. The biggest improvement was in the SMB segment.",                                                            timestamp: _cd(0, 14,  0) },
    { id: 'm3-3', role: 'user',      content: "What was driving the improvement in SMB?",                                                                                                                                                          timestamp: _cd(0, 14,  2) },
    { id: 'm3-4', role: 'assistant', content: "The SMB improvement was mainly driven by the new onboarding flow launched in January — 30-day retention improved from 61% to 74%. The self-serve help centre also reduced early cancellations by about 18%.", timestamp: _cd(0, 14,  3) },
  ] },
  // ── This week ──
  { id: 'm-4', title: 'Add dark mode to the landing page',   workspaceId: 'creative', updatedAt: _cd(2, 16, 45), createdAt: _cd(2, 16, 45), artifactIds: ['art-8'], unread: true, lastMessage: "Dark mode styles are in. I used CSS custom properties so you can toggle the theme without touching the component logic. Want me to wire up the toggle button too?", messages: [
    { id: 'm4-1', role: 'user',      content: "Can you add dark mode to the landing page? We want it to follow the system preference automatically.",                                                                                                             timestamp: _cd(2, 16, 30) },
    { id: 'm4-2', role: 'assistant', content: "Sure — I'll use CSS custom properties with a `prefers-color-scheme` media query so it picks up the system preference automatically. Working on it now.",                                                           timestamp: _cd(2, 16, 33) },
    { id: 'm4-3', role: 'assistant', content: "Dark mode styles are in. I used CSS custom properties so you can toggle the theme without touching the component logic. Want me to wire up the toggle button too?",                                                  timestamp: _cd(2, 16, 45) },
    { id: 'm4-4', role: 'user',      content: "Yes please, add the toggle in the nav.",                                                                                                                                                                           timestamp: _cd(2, 16, 47) },
    { id: 'm4-5', role: 'assistant', content: "Toggle added to the nav — it's a sun/moon icon that flips between light and dark and persists the user's choice in localStorage.",                                                                                  timestamp: _cd(2, 16, 52) },
  ] },
  { id: 'm-5', title: 'Team offsite planning',                workspaceId: 'work',    updatedAt: _cd(3, 10, 32), createdAt: _cd(3,  9, 55), artifactIds: ['art-3'], lastMessage: "Done — hackathon kickoff now moves to 14:00 on Day 2.", messages: [
    { id: 'm5-1', role: 'user',      content: "We're planning a team offsite for 18 people, 2 nights, somewhere in the US. Budget around $15K all-in. We need workshop space and some social time.",                                                               timestamp: _cd(3,  9, 55) },
    { id: 'm5-2', role: 'assistant', content: "Looking at venues that fit — 18 people, workshop-ready, social-friendly, $15K ceiling.",                                                                                                                            timestamp: _cd(3, 10,  0) },
    { id: 'm5-3', role: 'assistant', content: "I've shortlisted three venues within your budget: The Foundry in Brooklyn, Basecamp Marin, and The Greenhouse in Austin. Each has pros and cons — want a side-by-side comparison?",                                  timestamp: _cd(3, 10, 10) },
    { id: 'm5-4', role: 'user',      content: "Yes please, and flag which one has the best AV setup.",                                                                                                                                                            timestamp: _cd(3, 10, 12) },
    { id: 'm5-5', role: 'assistant', content: "Best AV setup is The Foundry — dedicated presentation room with 4K projection, a PA system, and an on-site tech coordinator included in the rate. But Basecamp Marin wins overall on outdoor space and cabin atmosphere.", timestamp: _cd(3, 10, 18) },
    { id: 'm5-6', role: 'user',      content: "We'll go with Basecamp Marin. Can you draft a 3-day agenda? Mix of strategy, team-building, and a hackathon. 20 people, mid-May in Lake Tahoe.",                                                                   timestamp: _cd(3, 10, 19) },
    { id: 'm5-7', role: 'assistant', content: "Here's your 3-day offsite agenda for Basecamp Marin in mid-May. Day 1 focuses on alignment and retrospective, Day 2 has deep-work tracks and a hackathon, and Day 3 wraps up with demos and action items. I've included time blocks, leads, and a logistics section.", timestamp: _cd(3, 10, 28) },
    { id: 'm5-8', role: 'user',      content: "Can you shift the hackathon to start after lunch on Day 2?",                                                                                                                                                       timestamp: _cd(3, 10, 30) },
    { id: 'm5-9', role: 'assistant', content: "Done — hackathon kickoff now moves to 14:00 on Day 2. I've shifted the morning cross-team sessions to fill the gap and added a short retrospective slot before lunch.",                                              timestamp: _cd(3, 10, 32) },
  ] },
  { id: 'm-6', title: 'Acme Corp interview notes',            workspaceId: 'work',    updatedAt: _cd(5,  9,  1), createdAt: _cd(5,  8, 48), artifactIds: ['art-5'], referenceIds: ['ctx-5', 'ctx-2'], lastMessage: "Jamie mentioned spreadsheets, their CRM, and invoicing software as the three systems they're constantly copying between.", messages: [
    { id: 'm6-1', role: 'user',      content: "I just finished an interview with Jamie Rodriguez, Head of Operations at Acme Corp. Here are my rough notes — can you clean them up into a structured format?\n\nJamie, Acme Corp, Head of Ops. 30 min call. Spends ~3hrs/day moving data between spreadsheets. Tried another tool but team found it too technical. Big worry about AI accuracy on client invoices. Very interested if we can solve the trust problem.", timestamp: _cd(5,  8, 48) },
    { id: 'm6-2', role: 'assistant', content: "Cleaning up and structuring your interview notes now.",                                                                                                                                                             timestamp: _cd(5,  8, 50) },
    { id: 'm6-3', role: 'assistant', content: "Here are your structured interview notes for Jamie Rodriguez at Acme Corp. I've organised them into key quotes, pain points, opportunities, and follow-up actions. The three main themes are: manual data transfer, tool complexity, and trust in AI accuracy.", timestamp: _cd(5,  8, 55) },
    { id: 'm6-4', role: 'user',      content: "Which integrations came up in the conversation?",                                                                                                                                                                  timestamp: _cd(5,  8, 58) },
    { id: 'm6-5', role: 'assistant', content: "Jamie mentioned spreadsheets, their CRM, and invoicing software as the three systems they're constantly copying between. They didn't name specific tools — they care more about the automation layer than integration names. Worth exploring in the follow-up.", timestamp: _cd(5,  9,  1) },
  ] },
  { id: 'm-17', title: 'Does this contract clause look standard?', workspaceId: 'work', updatedAt: _cd(4, 16, 10), createdAt: _cd(4, 16, 10), lastMessage: "The exclusivity clause in section 4.2 is broader than typical — it covers both direct and indirect competition for 24 months post-termination. Worth flagging to your lawyer before signing.", messages: [
    { id: 'm17-1', role: 'user',      content: "Can you take a look at this contract clause and tell me if it seems standard?",                                                                                                                      timestamp: _cd(4, 16,  8) },
    { id: 'm17-2', role: 'assistant', content: "The exclusivity clause in section 4.2 is broader than typical — it covers both direct and indirect competition for 24 months post-termination. Worth flagging to your lawyer before signing.", timestamp: _cd(4, 16, 10) },
  ] },
  { id: 'm-18', title: 'What time zone should we use for the all-hands?', workspaceId: 'general', updatedAt: _cd(5, 11, 20), createdAt: _cd(5, 11, 20), lastMessage: "Given your team distribution across London, Austin, and Singapore, UTC+1 (London) tends to be the fairest. 9am London = 3am Austin = 4pm Singapore — Austin folks take the early hit, but it's the most manageable overlap.", messages: [
    { id: 'm18-1', role: 'user',      content: "We have people in London, Austin, and Singapore. What time zone should we anchor the weekly all-hands to?",                                                                                          timestamp: _cd(5, 11, 18) },
    { id: 'm18-2', role: 'assistant', content: "Given your team distribution across London, Austin, and Singapore, UTC+1 (London) tends to be the fairest. 9am London = 3am Austin = 4pm Singapore — Austin folks take the early hit, but it's the most manageable overlap.", timestamp: _cd(5, 11, 20) },
  ] },
  { id: 'm-7', title: 'Brand guidelines typography question', workspaceId: 'creative', updatedAt: _cd(6, 14, 30), createdAt: _cd(6, 14, 30), lastMessage: "The brand guidelines specify Inter for UI and Tiempos Headline for display text. For body copy below 14px you should use Inter at regular weight — semibold is reserved for headings only.", messages: [
    { id: 'm7-1', role: 'user',      content: "Quick question — what font does the brand guide say to use for body copy?",                                                                                                                                                  timestamp: _cd(6, 14, 28) },
    { id: 'm7-2', role: 'assistant', content: "The brand guidelines specify Inter for UI and Tiempos Headline for display text. For body copy below 14px you should use Inter at regular weight — semibold is reserved for headings only.",                                     timestamp: _cd(6, 14, 30) },
    { id: 'm7-3', role: 'user',      content: "And what about code snippets?",                                                                                                                                                                                             timestamp: _cd(6, 14, 31) },
    { id: 'm7-4', role: 'assistant', content: "The guidelines don't specify a monospace font explicitly, but in past marketing material we've used JetBrains Mono at 90% of the base font size with a light-gray code block background. That's become the de-facto standard.", timestamp: _cd(6, 14, 32) },
  ] },
  // ── Earlier ──
  { id: 'm-8',  title: 'Product roadmap Q2-Q3',               updatedAt: _cd(10, 11,  8), createdAt: _cd(10, 10, 48), artifactIds: ['art-7', 'art-1'], lastMessage: "Estimates added — API gateway is 6 weeks, advanced filters 2 weeks, bulk export 1 week, SSO 4 weeks.", messages: [
    { id: 'm8-1', role: 'user',      content: "Can you create a product roadmap covering Q2 and Q3? I need owner, status, and target dates across engineering, design, and infrastructure.",                                                                        timestamp: _cd(10, 10, 48) },
    { id: 'm8-2', role: 'assistant', content: "Building the Q2-Q3 roadmap now — I'll include owner, status, and target dates across all teams.",                                                                                                                   timestamp: _cd(10, 10, 50) },
    { id: 'm8-3', role: 'assistant', content: "Here's your Q2-Q3 roadmap with 10 initiatives across engineering, design, infrastructure, and platform teams. Q2 focuses on foundation work (auth, dashboard, mobile), Q3 shifts to growth features (workspaces, integrations, enterprise).", timestamp: _cd(10, 11,  0) },
    { id: 'm8-4', role: 'user',      content: "Based on the latest sales feedback: move the API gateway to P0, push mobile redesign to Q4, and add the three items the sales team flagged — advanced filters, bulk export, and SSO.",                              timestamp: _cd(10, 11,  2) },
    { id: 'm8-5', role: 'assistant', content: "Estimates added — API gateway is 6 weeks, advanced filters 2 weeks, bulk export 1 week, SSO 4 weeks. I marked them all as rough T-shirt sizes since we haven't spec'd them fully.",                                 timestamp: _cd(10, 11,  8) },
  ] },
  { id: 'm-9',  title: 'Weekly standup dashboard',           updatedAt: _cd(12,  9, 31), createdAt: _cd(12,  9, 10), artifactIds: ['art-6', 'art-2'], lastMessage: "Added — there's now a 'Shipped last week' row at the top with a green tick for each completed item.", messages: [
    { id: 'm9-1', role: 'user',      content: "Can you build a weekly standup dashboard? It should show last week's velocity, open blockers, and shipping targets. I want it to refresh automatically every Monday morning.",                                       timestamp: _cd(12,  9, 10) },
    { id: 'm9-2', role: 'assistant', content: "Building the standup dashboard now — velocity, blockers, and shipping targets with a Monday 8am auto-refresh.",                                                                                                     timestamp: _cd(12,  9, 15) },
    { id: 'm9-3', role: 'assistant', content: "The dashboard is live. It pulls last week's velocity, open blockers, and shipping targets automatically. Refresh happens every Monday at 8am.",                                                                       timestamp: _cd(12,  9, 25) },
    { id: 'm9-4', role: 'user',      content: "Can you add a 'Shipped last week' section above the velocity chart?",                                                                                                                                              timestamp: _cd(12,  9, 27) },
    { id: 'm9-5', role: 'assistant', content: "Added — there's now a 'Shipped last week' row at the top with a green tick for each completed item. It pulls from the same data source as the velocity chart.",                                                     timestamp: _cd(12,  9, 31) },
  ] },
  { id: 'm-10', title: 'Build an expense tracker',           updatedAt: _cd(15, 15,  8), createdAt: _cd(15, 14, 45), artifactIds: ['art-2'], lastMessage: "Done — there's now a Recurring toggle on each row. Items flagged as recurring are highlighted in light blue.", messages: [
    { id: 'm10-1', role: 'user',      content: "Can you build me an expense tracker? I need category breakdowns, a monthly budget cap per category, and the ability to export to CSV.",                                                                            timestamp: _cd(15, 14, 45) },
    { id: 'm10-2', role: 'assistant', content: "Building your expense tracker now — categories, budget caps, and CSV export all included.",                                                                                                                        timestamp: _cd(15, 14, 50) },
    { id: 'm10-3', role: 'assistant', content: "Your expense tracker is ready. It includes category breakdowns, a monthly budget limit per category, and a CSV export. Click the card to open it.",                                                                 timestamp: _cd(15, 15,  0) },
    { id: 'm10-4', role: 'user',      content: "Can you add a 'Recurring' flag to each row so I can mark subscriptions?",                                                                                                                                         timestamp: _cd(15, 15,  4) },
    { id: 'm10-5', role: 'assistant', content: "Done — there's now a Recurring toggle on each row. Items flagged as recurring are highlighted in light blue and excluded from the one-off spending totals at the bottom.",                                          timestamp: _cd(15, 15,  8) },
  ] },
  { id: 'm-11', title: 'Summarise Q1 revenue data',          updatedAt: _cd(17, 10,  0), createdAt: _cd(17, 10,  0), referenceIds: ['ctx-1', 'ctx-8'], lastMessage: "Q1 revenue came in at $2.4M, up 18% YoY. Enterprise grew fastest at 34%, while SMB was flat. Key driver was the March product launch — it contributed $420K in new ARR.", messages: [
    { id: 'm11-1', role: 'user',      content: "Can you summarise the Q1 revenue data from the spreadsheet I shared?",                                                                                                                                          timestamp: _cd(17,  9, 58) },
    { id: 'm11-2', role: 'assistant', content: "Q1 revenue came in at $2.4M, up 18% YoY. Enterprise grew fastest at 34%, while SMB was flat. Key driver was the March product launch — it contributed $420K in new ARR.",                                      timestamp: _cd(17, 10,  0) },
    { id: 'm11-3', role: 'user',      content: "What was the average enterprise deal size?",                                                                                                                                                                    timestamp: _cd(17, 10,  2) },
    { id: 'm11-4', role: 'assistant', content: "Average enterprise deal size was $42K in Q1, up from $31K in Q4 2025. The jump reflects the new pricing tiers introduced in February — the $35K mid-market tier in particular closed faster than expected.", timestamp: _cd(17, 10,  3) },
  ] },
  { id: 'm-12', title: 'Logo refresh for creative project',  updatedAt: _cd(21, 14,  0), createdAt: _cd(21, 14,  0), lastMessage: "Here are four directions for the logo refresh — geometric mark, wordmark-only, monogram, and illustrated icon. Let me know which direction to develop further.", messages: [
    { id: 'm12-1', role: 'user',      content: "I need a logo refresh for the Meridian project. We want something modern but approachable, not too techy.",                                                                               timestamp: _cd(21, 13, 55) },
    { id: 'm12-2', role: 'assistant', content: "Here are four directions for the logo refresh — geometric mark, wordmark-only, monogram, and illustrated icon. Let me know which direction to develop further.",                        timestamp: _cd(21, 14,  0) },
    { id: 'm12-3', role: 'user',      content: "I like the illustrated icon direction. Can you push it further with warmer colours?",                                                                                                  timestamp: _cd(21, 14,  4) },
    { id: 'm12-4', role: 'assistant', content: "Great choice. Warmer palette suits the brand tone well. I'd suggest a terracotta-and-sand combination — it reads confident without feeling corporate. Want me to generate a few colour variants so you can pick?", timestamp: _cd(21, 14,  6) },
  ] },
  { id: 'm-13', title: 'Landing page hero section copy',     updatedAt: _cd(23,  9, 45), createdAt: _cd(23,  9, 45), artifactIds: ['art-8'], lastMessage: "Three headline options for the hero: 1) 'Ship faster, together' 2) 'Your team's second brain' 3) 'From idea to done in minutes'. Option 2 tested best in our previous A/B data.", messages: [
    { id: 'm13-1', role: 'user',      content: "I need copy for the landing page hero section. Three headline options please — something punchy, benefit-led, not too techy.",                                                                                     timestamp: _cd(23,  9, 38) },
    { id: 'm13-2', role: 'assistant', content: "Writing three options now — keeping them short, benefit-first, no jargon.",                                                                                                                                        timestamp: _cd(23,  9, 40) },
    { id: 'm13-3', role: 'assistant', content: "Three headline options for the hero: 1) \"Ship faster, together\" 2) \"Your team's second brain\" 3) \"From idea to done in minutes\". Option 2 tested best in our previous A/B data.",                               timestamp: _cd(23,  9, 45) },
    { id: 'm13-4', role: 'user',      content: "Can you write a two-sentence subheadline to go with option 2?",                                                                                                                                                   timestamp: _cd(23,  9, 48) },
    { id: 'm13-5', role: 'assistant', content: "Here's a subheadline for option 2: \"Ask it anything. Watch it build, write, and organise — so your team can focus on the work that matters.\" Keeps the tone conversational and leads with the outcome.",           timestamp: _cd(23,  9, 52) },
  ] },
  { id: 'm-14', title: 'Competitor analysis notes',          updatedAt: _cd(26, 11, 30), createdAt: _cd(26, 11, 30), lastMessage: "I've covered Notion, Linear, and Coda. The biggest gap you can exploit is their weak AI integration — all three bolt it on rather than building around it. That's your differentiator.", messages: [
    { id: 'm14-1', role: 'user',      content: "Can you do a quick competitive analysis of Notion, Linear and Coda from an AI features perspective?",                                                                                                                                          timestamp: _cd(26, 11, 25) },
    { id: 'm14-2', role: 'assistant', content: "I've covered Notion, Linear, and Coda. The biggest gap you can exploit is their weak AI integration — all three bolt it on rather than building around it. That's your differentiator.",                                                     timestamp: _cd(26, 11, 30) },
    { id: 'm14-3', role: 'user',      content: "What about Craft and Obsidian?",                                                                                                                                                                                                           timestamp: _cd(26, 11, 32) },
    { id: 'm14-4', role: 'assistant', content: "Both are strong in the personal productivity space but lag on collaboration. Craft's AI is limited to writing polish; Obsidian's Copilot plugin is community-built and inconsistent. Neither is positioning around AI-first workflows.", timestamp: _cd(26, 11, 34) },
  ] },
  { id: 'm-15', title: 'Email draft — Henderson project',    updatedAt: _cd(31, 10,  0), createdAt: _cd(31, 10,  0), lastMessage: "Draft ready. I kept the tone professional but warm and referenced the timeline we discussed in March. Let me know if you want a shorter version or a more direct ask at the end.", messages: [
    { id: 'm15-1', role: 'user',      content: "Can you write an email to the Henderson project team about the timeline slippage? Acknowledge the delay, explain the revised dates, and keep it professional but warm.",                                      timestamp: _cd(31,  9, 55) },
    { id: 'm15-2', role: 'assistant', content: "Draft ready. I kept the tone professional but warm and referenced the timeline we discussed in March. Let me know if you want a shorter version or a more direct ask at the end.",                           timestamp: _cd(31, 10,  0) },
    { id: 'm15-3', role: 'user',      content: "Make it slightly shorter and move the apology earlier in the email.",                                                                                                                                         timestamp: _cd(31, 10,  3) },
    { id: 'm15-4', role: 'assistant', content: "Done — moved the acknowledgment of the delay to the second paragraph and trimmed about 40 words from the middle. The call to action is now cleaner at the end. Ready to send?",                            timestamp: _cd(31, 10,  5) },
  ] },
  { id: 'm-16', title: 'Color palette exploration',          updatedAt: _cd(36,  9,  0), createdAt: _cd(36,  9,  0), artifactIds: ['art-4'], lastMessage: "I've generated five palette options ranging from earthy and warm to cool and minimal. Each comes with accessible contrast ratios for text and background combinations.", messages: [
    { id: 'm16-1', role: 'user',      content: "Can you explore some color palette options for the brand? We want to move away from the current cold blues. Leaning warmer or more neutral.",                                                                      timestamp: _cd(36,  8, 50) },
    { id: 'm16-2', role: 'assistant', content: "Exploring palette directions — shifting away from cool blues toward warm and neutral tones.",                                                                                                                      timestamp: _cd(36,  8, 55) },
    { id: 'm16-3', role: 'assistant', content: "I've generated five palette options ranging from earthy and warm to cool and minimal. Each comes with accessible contrast ratios for text and background combinations.",                                             timestamp: _cd(36,  9,  0) },
    { id: 'm16-4', role: 'user',      content: "I love palette 3 — the terracotta one. Can you create a dark-mode version of it?",                                                                                                                                timestamp: _cd(36,  9,  5) },
    { id: 'm16-5', role: 'assistant', content: "Dark mode variant of palette 3 is in the artifact now. I kept the terracotta accent as the primary highlight but shifted the backgrounds to near-black warm neutrals so the contrast ratios stay WCAG AA compliant.", timestamp: _cd(36,  9, 10) },
  ] },
]

// ─── Helper functions ───

export function getArtifactById(id: string): Artifact | undefined {
  return MOCK_ARTIFACTS.find(a => a.id === id)
}

export function getRelativeTime(date: Date): string {
  const now = new Date('2026-04-16T10:00:00') // fixed "now" for mock
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function getArtifactIcon(type: ArtifactType): LucideIcon {
  switch (type) {
    case 'document': return FileText
    case 'app': return Zap
    case 'image': return ImageIcon
    case 'spreadsheet': return Table
    case 'site': return Globe
  }
}

// Compose flow mock scenarios
export interface ComposeScenario {
  triggers: string[]
  statusMessages: string[]
  resultArtifact: Omit<Artifact, 'id' | 'createdAt' | 'updatedAt' | 'conversation'>
  finalResponse: string
}

export const COMPOSE_SCENARIOS: ComposeScenario[] = [
  {
    triggers: ['summarise', 'summarize', 'summary', 'recap'],
    statusMessages: ['Reading your files...', 'Pulling out the key points...', 'Writing the summary...'],
    resultArtifact: {
      name: 'Summary',
      type: 'document',
      agentName: 'Claude',
      agentModel: 'Claude Sonnet 4',
      content: '# Summary\n\nThis is a mock summary of your content. In the full app, this would contain an actual AI-generated summary of whatever files or content you referenced.',
    },
    finalResponse: "Here's your summary. I've highlighted the key themes and action items.",
  },
  {
    triggers: ['build', 'create', 'make', 'app', 'tracker', 'dashboard', 'tool'],
    statusMessages: ['Understanding what you need...', 'Designing the interface...', 'Building the components...', 'Adding the finishing touches...'],
    resultArtifact: {
      name: 'New App',
      type: 'app',
      agentName: 'Claude',
      agentModel: 'Claude Sonnet 4',
      content: 'app',
    },
    finalResponse: "Your app is ready! I've built it with the features you described. You can start using it right away.",
  },
  {
    triggers: ['write', 'draft', 'document', 'doc', 'plan', 'strategy', 'brief', 'report', 'email', 'agenda', 'notes'],
    statusMessages: ['Thinking about the structure...', 'Writing the first draft...', 'Reviewing and polishing...'],
    resultArtifact: {
      name: 'New Document',
      type: 'document',
      agentName: 'Claude',
      agentModel: 'Claude Sonnet 4',
      content: '# New Document\n\nThis is a mock document. In the full app, this would contain AI-generated content based on your request.',
    },
    finalResponse: "Your document is ready. Take a look and let me know if you'd like any changes.",
  },
  {
    triggers: ['image', 'design', 'logo', 'illustration', 'palette', 'visual'],
    statusMessages: ['Exploring visual directions...', 'Generating the design...'],
    resultArtifact: {
      name: 'New Design',
      type: 'image',
      agentName: 'Claude',
      agentModel: 'Claude Sonnet 4',
      content: 'image',
    },
    finalResponse: "Here's your design. Let me know if you want to adjust colors, layout, or style.",
  },
]

export function matchComposeScenario(input: string): ComposeScenario {
  const lower = input.toLowerCase()
  const matched = COMPOSE_SCENARIOS.find(s => s.triggers.some(t => lower.includes(t)))
  return matched || COMPOSE_SCENARIOS[2] // default to document
}
