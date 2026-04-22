# Desk App — Agent Handoff

## What This Is

A high-fidelity React prototype for **Desk**, an AI productivity app. It's a design prototype only — no backend, all data mocked. The focus is on interaction design, visual polish, and exploring UX patterns for an AI-native workspace.

## Running the App

```bash
cd app
npm run dev        # starts on http://localhost:5174
```

The dev server port is 5174 (configured in `.claude/launch.json`).

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | React 19 + TypeScript + Vite |
| Styling | Tailwind CSS v4 |
| Components | shadcn/ui (in `src/components/ui/`) |
| Animation | Framer Motion |
| Icons | Lucide React |
| Mock chat | `use-mock-chat.ts` hook (simulates typing delays + responses) |

## Project Structure

```
app/src/
├── App.tsx                          # Root state + routing logic (no router library)
├── data/mock-data.ts                # All mock data + TypeScript interfaces
├── hooks/
│   ├── use-mock-chat.ts             # Simulates AI conversation with typing delays
│   └── use-mobile.ts               # Responsive breakpoint hook
└── components/
    ├── layout/
    │   ├── AppShell.tsx             # Main shell: sidebar nav, chat list, Today sheet
    │   └── WorkspaceBar.tsx         # Top bar: workspace tabs, Inbox button, logo
    ├── compose/
    │   ├── ComposeOverlay.tsx       # Full-screen new chat overlay
    │   ├── ComposeShell.tsx         # Chat shell for existing chats
    │   ├── ComposeThread.tsx        # Message thread within a chat
    │   ├── ConversationSidebar.tsx  # Side panel for artifact conversations
    │   ├── ChatInput.tsx            # Reusable input bar (compact + full modes)
    │   ├── ChatMessage.tsx          # Single message bubble (user/assistant)
    │   └── StatusIndicator.tsx      # "Thinking…" typing indicator
    ├── artifact/
    │   ├── ArtifactDetail.tsx       # Full artifact view + conversation panel
    │   ├── ArtifactPreview.tsx      # Renders artifact content by type
    │   └── ConversationPanel.tsx    # Side/bottom conversation panel
    ├── desk/
    │   ├── DeskGrid.tsx             # Artifact card grid with filters
    │   ├── ArtifactCard.tsx         # Individual artifact card
    │   └── ArtifactThumbnail.tsx    # Type-aware thumbnail renderer
    ├── today/
    │   ├── TodayPanel.tsx           # Primary Inbox panel (list + sort)
    │   ├── TodayDetailPanel.tsx     # Detail/chat panel for a selected inbox item
    │   ├── InboxCard.tsx            # Individual inbox item card
    │   ├── InboxUICard.tsx          # Rich UI cards shown inside detail panel
    │   └── TodayInbox.tsx           # (legacy, superseded by TodayPanel)
    ├── runs/
    │   ├── RunsPage.tsx             # Runs list page
    │   ├── RunsList.tsx             # Active + scheduled + past runs list
    │   └── RunDetailPanel.tsx       # Side panel for a selected run
    ├── context/
    │   ├── ContextList.tsx          # Context items list
    │   └── ContextDetail.tsx        # Detail view for a context item
    └── shared/
        ├── ArtifactInlineCard.tsx   # Compact artifact reference card
        └── PanelEmptyStates.tsx     # Reusable empty state components
```

## Navigation Model

Navigation is entirely state-driven in `App.tsx` — no router library.

```
activeView: 'desk' | 'runs' | 'context'    ← main nav
selectedChatId: string | null               ← opens chat shell over main view
selectedArtifact: Artifact | null           ← opens artifact detail
todaySheetOpen: boolean                     ← slides in Inbox sheet from left
```

The **Inbox** (Today) opens as a `Sheet` (Radix/shadcn) sliding in from the left. It has two panels side-by-side:
- Primary panel (`TodayPanel`) — always 560px wide
- Detail panel (`TodayDetailPanel`) — expands sheet to 75vw when an item is selected

Workspace switching lives in `WorkspaceBar`. The three workspaces (General, Work, Creative Lab) are defined as `WORKSPACES` in `AppShell.tsx`.

## Key Design Decisions

### Visual Hierarchy
- **Workspace bar** (`h-[51px]`) — topmost, spans full width
- **Sidebar** — workspace identity + nav (Desk / Runs / Library) + chat list
- **Main area** — content changes based on `activeView`
- The whole app sits in a rounded card with `bg-muted` outer background and `bg-background` inner

### Inbox Panel
- Background: `bg-sidebar` (light gray matching the sidebar)
- Header: `bg-background` (white) with `h-[52px]` — matches detail panel header height exactly
- Cards grouped into sections (`rounded-xl border overflow-hidden`), items separated by `border-b last:border-b-0`
- Selected card: `bg-muted/40` (same as hover, subtler than a primary tint)
- Sort modes: priority (Due now / Good to know / Other updates) and newest (Today / This week / Earlier)

### InboxCard Meta Row
Follows the same pattern as `ChatMessage` headers:
```
[type icon] agentName    [context icon] contextName    timestamp    • New
```
- Outer gap: `gap-3` (matches ChatMessage)
- Icon + label pairs use `gap-1` internally
- Context icon comes from `getArtifactIcon(artifact.type)`, `Zap` for runs, `Bot` for plain items
- No dot separators — spacing alone creates the rhythm

### ChatInput
`ChatInput` supports two modes via the `compact` prop:
- Full mode: goal picker, attachment button, agent selector
- Compact mode: plain textarea + send, used in detail panels

Important: inside Radix Sheet portals, `scrollHeight` measurements are inflated to the container height. The component works around this by temporarily switching the textarea to `position: fixed` during measurement (in `useLayoutEffect`). Do not remove this.

`ChatInput` also accepts a `focusRef` prop — a `MutableRefObject<(() => void) | null>` that the parent can use to imperatively focus the textarea. Used by the Inbox detail panel when "Something else" is clicked.

### Component Patterns

**Shared header height**: All panel headers use `h-[52px] flex items-center gap-2.5 border-b px-4 shrink-0`. Keep this consistent.

**Grouped list containers**: When multiple items belong to a section, wrap them in `rounded-xl border overflow-hidden` rather than styling each card individually. The container provides the border/radius; cards use `border-b last:border-b-0` for internal dividers.

**Hover/selected states**: Prefer `hover:bg-muted/40` for hover and the same value for selected — subtler reads better than a primary-tinted background inside a bordered container.

**Kebab menus on cards**: Hidden by default (`opacity-0`), revealed on `group-hover:opacity-100`. Wrap the trigger in a `div` with `onClick={e => e.stopPropagation()}` so it doesn't fire the card's own click handler.

**Animation stagger**: Card lists use `transition={{ delay: index * 0.05 }}` via Framer Motion for a gentle entrance cascade.

## Mock Data (`src/data/mock-data.ts`)

All interfaces and mock data live here. Key exports:

| Export | Type | Description |
|---|---|---|
| `MOCK_ARTIFACTS` | `Artifact[]` | 8 artifacts across types |
| `MOCK_CHATS` | `Chat[]` | ~13 chats with message histories |
| `MOCK_INBOX` | `InboxItem[]` | 5 inbox items (questions, completions, errors) |
| `MOCK_RUNS` | `Run[]` | Active + scheduled + past runs |
| `MOCK_CONTEXT` | `ContextItem[]` | Files, links, notes |
| `getArtifactIcon(type)` | `LucideIcon` | Maps artifact type → Lucide icon |
| `getRelativeTime(date)` | `string` | "2h ago", "Yesterday", etc. |

### InboxItem structure
```typescript
interface InboxItem {
  id: string
  type: 'question' | 'completion' | 'error'
  agentName: string
  message: string
  artifactId?: string   // links to MOCK_ARTIFACTS
  runId?: string        // links to MOCK_RUNS
  timestamp: Date
  read: boolean
  quickReplies?: string[]
  uiCard?: InboxUICard  // optional rich card shown in detail panel
}
```

### InboxUICard types
Three discriminated union variants rendered by `InboxUICard.tsx`:
- `email-draft` — subject, recipient, body preview + Review/Edit buttons
- `expense-flags` — list of flagged expense entries
- `reconnect` — service name + Reconnect button

## Styling Conventions

- **Never hardcode colors** — always use Tailwind tokens mapped from CSS variables in `index.css`
- **Sidebar tokens**: `bg-sidebar`, `text-sidebar-foreground`, `bg-sidebar-accent` etc.
- **Panel headers**: always `bg-background` (white) even when the panel body is `bg-sidebar`
- **Icon sizes in meta rows**: `h-3 w-3` with `text-muted-foreground/60`
- **Icon sizes in headers/toolbars**: `h-4 w-4`
- **Text sizes**: `text-xs` for meta/labels, `text-sm` for body content
- **Border radius**: `rounded-xl` for cards and containers, `rounded-lg` for bubbles/chips, `rounded-full` for pills
- **Spacing**: `gap-3` between meta items, `gap-1` within an icon+label pair

## Icon Library

Lucide React exclusively. Import directly: `import { Inbox, Bot, Zap } from 'lucide-react'`

Key icon mappings used in this project:
- Artifact types: `FileText` (doc), `Zap` (app/run), `ImageIcon` (image), `Table` (spreadsheet), `Globe` (site)
- Navigation: `LayoutGrid` (Desk), `Zap` (Runs), `FolderOpen` (Library), `Inbox` (Inbox)
- Actions: `MoreHorizontal` (kebab), `CheckCircle2` (complete), `Sparkles` (not relevant), `Clock` (later)

## What's Been Built

All primary views are implemented:

- ✅ **Desk** — artifact grid with filter chips, artifact detail with conversation panel
- ✅ **Inbox** — sorted/grouped list, detail panel with chat + quick replies + UI cards
- ✅ **Runs** — active/scheduled/past runs, run detail panel
- ✅ **Library (Context)** — context item list + detail
- ✅ **Chats** — chat list in sidebar, full chat view with conversation sidebar
- ✅ **Compose** — full-screen overlay for new chats, mock AI responses with status messages
- ✅ **Workspace bar** — workspace tabs, Inbox button, search palette, compose shortcut
- ✅ **Agentation widget** — Option+A toggles the widget (loaded from CDN)

## Known Quirks

- `scrollHeight` inside Radix Sheet portals is inflated — see ChatInput's `useLayoutEffect` for the fix
- `AnimatePresence` can misbehave with rapid state changes; plain CSS transitions are more reliable for show/hide driven by state (see FilterBar pattern in the overlay prototype)
- Workspace switching resets the chat view — chats are not scoped per workspace in the mock data but the UI treats them as if they were
