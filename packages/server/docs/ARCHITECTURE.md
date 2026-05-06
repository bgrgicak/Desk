# Desk Server Architecture Outline

## Objective

Create a developer-ready Desk server architecture with three planning horizons:

* **Now**: detailed, implementation-oriented architecture
* **Next**: rough expansion plan
* **Later**: ordered list only, no deep detail

## Proposed key server components

### 1. API Gateway / Server API

External entrypoint for clients.

* Authenticated client access
* Chat/session APIs
* File APIs
* Agent/run APIs for immediate, scheduled, and recurring executions
* Tool execution endpoints
* Stream sandbox responses to connected clients during active sessions; persist final output to SQL on completion, or just persist to SQL if the client is disconnected

### 2. Auth & Identity

* User authentication
* Session/token issuance
* Agent identity as the primary logical runtime actor
* User ownership of agents as the root authority model
* System/service identity for scheduler, workers, and connectors
* Separation between agent storage identity on the host and agent execution identity inside sandboxes
* Agent-scoped execution context passed into downstream services
* Agents have limited tool access; they cannot invoke tools outside their assigned surface
* Each agent can have its own tool allowlist, enforced per-agent rather than globally

### 2.1 Desk App Iframe Boundary

Agent-authored Desk apps are treated as untrusted static frontends. The parent SPA renders them in iframes with scripts enabled but without `allow-same-origin`, giving app JavaScript an opaque browser origin instead of first-party access to Desk session storage, local storage, cookies, or parent DOM.

The server authenticates app HTML entrypoints with per-app sessions and injects `window.desk` into those HTML responses. Non-HTML build assets are served as unprivileged subresources because opaque sandbox origins do not send the app-session cookie for module-script loads. Any privileged Desk operation must go through the parent-mediated `window.desk` postMessage bridge, where the parent validates the source iframe, bridge key, app scope, and declared capability before making the host API call.

### 3. Control Plane / Orchestrator

Central coordinator.

* Resolve agent type/configuration
* Start, stop, and reuse sandboxes
* Route prompt runs and direct tool calls
* Prepare sandbox state before each run, including controller-managed dynamic mount setup and teardown coordination
* Mint the per-sandbox Tool API session token bound to the agent's identity, and inject it into the sandbox as the environment variable consumed by the in-sandbox runtime; also inject any other scoped credentials and runtime context
* Enforce policy decisions
* Record run metadata

### 4. Agent Registry & Configuration

Source of truth for agent definitions.

* Agent types
* System prompts
* Tool allowlists
* Data access scopes
* Runtime image selection
* Policies and limits

### 5. Sandbox Runtime Manager

Execution infrastructure around container sandboxes (Docker or nerdctl/containerd, abstracted behind `runtime/src/engine.ts`).

* Container lifecycle
* Warm sandbox reuse
* Resource limits
* Isolation policies
* Health checks
* Per-run vs shared runtime strategy
* Coordinates mounting and unmounting of approved workspace, chat, and external paths before and after runs, working with File Manager and the controller-managed projection logic

### 6. In-Sandbox Agent Runtime

Software that runs inside the sandbox.

* Reasoning loop
* Tool invocation loop
* Local execution helpers
* Streaming partial output
* Temporary runtime state
* Agent identity and scoped credentials accompany every host-bound tool call; the Tool API session token is injected into the sandbox as an environment variable, so the host Tool API can resolve the caller and apply the allowlist check
* Desk-managed OpenCode skills are generated on the host under `${DESK_HOME}/Desk/.skills/<skill-name>/SKILL.md` and mounted read-only at `~/.config/opencode/skills/` inside the sandbox. The base system prompt keeps short behavior rules and tells agents to load `desk-cli*` reference skills or `desk-goal-*` goal skills only when needed.
* The sandbox image includes platform-pinned browser/display tooling for visual work: Playwright `1.60.0-alpha-1777669338000`, Firefox installed through Playwright into `/opt/playwright-browsers`, `@playwright/mcp` `0.0.73`, and Xvfb on `DISPLAY=:99` at `1920x1080x24`. The Playwright version is pinned to the MCP server's declared dependency so browser revisions stay aligned. OpenCode gets the Playwright MCP server from managed config at `/etc/opencode/opencode.json`, so every workspace can inspect rendered pages and take screenshots without `.deskrc` setup. The measured uncompressed image-size delta for browser tooling was +262,534,030 bytes, about +250 MiB (`desk/sandbox:v1` 613,897,093 bytes vs baseline 351,363,063 bytes on 2026-05-06).
* The sandbox image also includes broad text/document conversion tools: `pandoc` for DOCX, ODT, RTF, HTML, EPUB, LaTeX, and similar source formats, plus `poppler-utils`/`pdftotext` for text PDFs. Agents access them through `desk-agent file to-markdown`, which provides one Markdown/text conversion interface. The measured image-size delta for adding these converters was +39,381,874 bytes, about +37.6 MiB (`desk/sandbox:v1` 653,278,967 bytes vs 613,897,093 bytes on 2026-05-06). OCR and LibreOffice are intentionally excluded from the default image because they add substantially more weight.
* Browser and document tooling follow the sandbox image partition rule: bake in tools needed by most workspaces, expensive to install on demand, or version-sensitive enough to need platform pinning. Firefox is the default browser because it keeps the image smaller than Chromium; CDP-specific Chromium workflows, OCR, and full LibreOffice compatibility remain workspace-installed via `.deskrc` when needed.

### 7. Tool Layer

Unified capability surface for agents.

* In-sandbox tools (bash, file ops, local code) run freely within the sandbox; no per-call allowlist check
* Host-mediated tools — the host Tool API authenticates the caller via the Tool API session token presented by the sandbox, resolves the bound agent identity, and checks the requested tool against that agent's allowlist from Agent Registry & Configuration
* Host-initiated sandbox queries — the control plane can exec read-only commands inside a warm sandbox (e.g. `opencode models` for model discovery) via the runtime's `execInSandbox` primitive; the sandbox is the source of truth for provider/model availability and other runtime-scoped configuration. See `GET /tools/models`.
* External-service tools
* Tool schemas, permissions, timeouts, audit rules

### 8. File Manager

Critical boundary for file access.

* Resolve file IDs to physical paths
* Permission checks based on user-defined grants for each agent
* Read/write enforcement
* Controlled exposure into sandboxes
* Attachment resolution for chat/project context
* Mediate access to user-owned Desk storage and workspace-attached external directories
* Prepare for later controlled sharing using Linux mounts and filesystem permissions

### 9. Physical File Storage

Detailed now-phase design.

#### 9.1 Purpose

Physical File Storage is the durable host-side storage substrate for Desk. It stores agent operational data outside sandbox container filesystems, so sandbox restarts or rebuilds do not destroy state.

#### 9.2 Storage identity model

* Each real Desk user is assigned a real host Linux user account
* That account has a standard home directory at a path such as `/home/user-123/`
* The user account must be capable of interactive login
* That home directory is the primary durable storage root for that user’s Desk data
* Agents do not execute as those host Linux users; execution still occurs inside isolated sandboxes
* Host user storage identity and sandbox execution identity must remain separate
* This model is intended to remain compatible with the long-term agentic OS direction

#### 9.3 What is stored here

The user home directory stores Desk-managed data such as:

* Workspace-owned files and attachments
* Chat-owned attachments and related durable artifacts
* Notes, scratch files, and user-level Desk data
* Imported or synced material assigned to the user’s workspaces
* User-granted external directories from the same home tree, such as `~/Projects/NAME` or broader paths like `~/`, when explicitly attached to a workspace
* Later, controlled shared data and richer OS-level integrations

#### 9.4 What is not the source of truth here

The filesystem is the storage substrate, but not the only Desk source of truth.

* SQLite remains the authoritative metadata layer for user-to-home mapping, workspace and chat structure, file registry, ownership, grants, and audit metadata
* SQLite is the sole database; it also serves as the context/session store and supports any required sync patterns
* Linux ownership and permissions enforce low-level boundaries but do not replace Desk metadata

#### 9.5 Recommended directory layout

Example host layout:

```text
/home/user-123/
  Desk/
    workspaces/
      ws_abc/
        files/
        chats/
          chat_001/
            attachments/
          chat_002/
            attachments/
    apps/
    inbox/
    calendar/
    cache/
  Projects/
    project-a/
    project-b/
  Documents/
  Downloads/
```

Example sandbox persistent storage layout:

```text
/home/desk/sandboxes/
  sandbox_001/
    home/
    cache/
    services/
    state/
```

Guidelines:

* The real user home directory is the durable root, not an app-owned pseudo-home under another parent
* Desk-managed data should live under a clearly defined subtree such as `~/Desk/` to avoid colliding with unrelated user files
* Durable Desk-owned storage should be organized by user-owned workspace and chat context, not by agent
* A workspace may also be granted access to selected user directories outside `~/Desk/`, such as `~/Projects/NAME`
* Broader home-directory attachment, such as `~/`, is a later capability and not part of the now phase
* These external directories remain user-owned paths; Desk should treat them as attached or shared workspace sources rather than relocating them into `~/Desk/`
* Outputs are primarily stored in SQLite rather than as durable files by default
* Stable files and attachments should have IDs or stable names that map cleanly from SQLite
* Persistent sandbox storage is a separate subsystem from user-owned durable storage

#### 9.6 Linux account strategy

* Create one real host Linux user per Desk user
* Use a controlled naming scheme such as `user-123` or another stable system-compatible username
* The account must support normal login because it is part of the long-term OS foundation
* Use the account as the durable storage owner and future OS identity boundary
* Avoid using this account directly as the process user for containerized agent execution in the now phase

#### 9.7 Sandbox access model

* Sandboxes do not use the host user account directly
* Each sandbox has persistent sandbox storage outside the user home, acting as the sandbox's long-lived home/environment
* Selected workspace/chat paths and any user-granted external workspace directories are dynamically mounted into the sandbox when needed
* Projection should be explicit and policy-driven based on workspace, chat, and file selection
* Read-only should be the default where writes are not needed
* Workspaces should include a dedicated writable area named `desktop/`, where the agent can create files when write access is intended

#### 9.8 File projection approach

The preferred now-phase model is:

* Stable persistent sandbox volume for the sandbox home/environment
* Stable mount root inside the sandbox for workspace and chat attachments
* Dynamically mount and unmount selected paths from the user’s Desk storage tree and approved external workspace directories as runs require them
* Keep projection and mount bookkeeping outside the sandbox as part of File Manager and runtime orchestration
* Preserve the distinction between Desk-managed storage, workspace-attached user directories, and persistent sandbox storage
* Avoid container restarts when changing which files are available to an active warm sandbox

#### 9.9 Ownership and permission model

At the host filesystem level:

* The user home directory is owned by the corresponding Linux user
* Desk-managed files under `~/Desk/` inherit that user-owned storage boundary
* External directories such as `~/Projects/NAME` remain ordinary user-owned filesystem paths even when attached to a workspace
* Broad access should be denied by default outside explicit Desk policy or future sharing mechanisms

At the Desk policy level:

* The user defines what each agent may access within the user-owned data tree, including any workspace-attached external directories
* Desk persists those grants in SQLite
* File Manager and orchestration enforce the allowed projections into the sandbox
* Agents are execution actors, not the durable storage owners

#### 9.10 Lifecycle

Create:

* Create Linux user
* Create home directory
* Create the initial `~/Desk/` subtree and standard subdirectories
* Create persistent sandbox storage roots outside the user home
* Register mappings and metadata in SQLite

Use:

* Resolve allowed workspace/chat/file paths through Desk policy
* Resolve any workspace-attached external directories granted by the user
* Dynamically mount selected user-owned paths into the sandbox as runs require them Persist:
* Persist structured message outputs to SQLite
* Persist files created in writable workspace areas when the run is allowed to modify workspace data
* Keep long-lived environment state in persistent sandbox storage Cleanup:
* Support retention and cleanup for cache, stale attachments, and sandbox state according to policy Delete/deprovision:
* Disable the user account according to system policy
* Archive or remove Desk-managed data according to retention policy

#### 9.11 File classes to distinguish in metadata

SQLite should distinguish at least:

* Attachment files
* Workspace files
* Notes/memory artifacts
* Sandbox persistent state references
* Temporary/cache files

This matters for retention, UI presentation, cleanup, and later sharing rules.

#### 9.12 Audit and traceability

Desk should be able to answer:

* Which user storage path contains a file
* Which run created or modified it
* Whether it originated as a user attachment, agent output, or imported project file

Therefore filesystem paths should be linked to stable logical file records in SQLite.

#### 9.13 Now / Next / Later stance for this component

Now:

* Per-user real Linux account
* Per-user home directory at `/home/<user>/`
* Desk-managed subtree under the user home
* Persistent sandbox storage outside the user home
* Dynamic mount/unmount of workspace and chat paths into warm sandboxes
* SQLite-backed registry and grants
* No general cross-user or cross-agent sharing

Next:

* File watcher/reconciler for out-of-band file changes
* Better cleanup and retention workers
* Broader user-home attachment controls

Later:

* Controlled sharing using Linux mounts and chmod/chown-based permission management
* Richer conflict/versioning model for shared edits
* Deeper convergence toward an agentic OS model

### 10. Context Store

Stored in SQLite.

* Chat/session documents and context records
* Project/group context
* Chat → file links
* Project → file links
* Workspace links to attached external user directories
* Agent runtime context records
* Sync-friendly state model built on SQLite

### 11. Relational Metadata & Permission Store

Stored in SQLite.

* File registry
* User-defined permissions and grants for agent access
* User ownership of agents and top-level authority records
* Workspace, chat, and message ownership records
* Records for workspace-attached external directories and their policies
* Run metadata
* Scheduler metadata
* Durable relational records

### 12. File Access Projection Layer

**Mount Plan (produced by File Manager and consumed by Controller):**

* source_path (host)

* target_path (sandbox)

* mode (read-only / writable)

* category (workspace / chat / external / desktop)

* Stable shared mount path into sandbox

* Dynamic mount/unmount of selected paths from the user home tree into warm sandboxes

* Support projection of both Desk-managed paths and workspace-attached external directories

* Separate persistent sandbox storage from dynamically mounted user-owned data

* Bind-mount oriented projection model

* Keep host storage identity separate from sandbox runtime identity

* Mount lifecycle is controller-managed as part of pre-run sandbox setup

* Recompute the desired mount set before each run

* Track active run usage so mounted paths are removed only when no active runs still depend on them

* Treat mounted paths as part of the sandbox’s accessible surface even if tools are the primary access mechanism

* Treat stale mount leakage and mount-state drift as real operational risks that require cleanup and reconciliation

* Later, if leakage or mount complexity becomes a serious problem, support stricter sandbox partitioning such as separate warm sandboxes for specific workspace/agent combinations

### 13. File Watcher / Reconciler

* Detect move/rename/delete on filesystem
* Repair or update file registry
* Maintain consistency between disk and metadata

### 14. Task & Run Manager

* Agent-owned tasks, chats, run requests, and run instances
* Queueing
* Cancellation
* State transitions
* Retry metadata
* Run grouping rules

### 15. Scheduler

* Scheduled tasks
* Recurring jobs
* Deferred/background runs
* Trigger dispatch to control plane

### 16. Connector Platform

* Email
* Calendar
* File/data providers
* Third-party APIs
* Credential brokering and scoped access

### 17. Sync Layer

* Multi-client sync
* Offline-friendly replication model
* Event propagation to clients

### 18. Observability & Audit

* Structured logs
* Run traces
* Tool-call audit trail
* Metrics
* Failure capture
* Security-relevant events

### 19. Security & Policy Enforcement

Cross-cutting but explicit.

* Authorization checks
* User-defined permission levels for each agent over data and tools
* Credential scoping
* Sandbox restrictions
* Mount restrictions
* Network policy
* Resource quotas
* Secrets handling
* Enforcement that agents act only within grants derived from their owning user
* Clear separation between host filesystem permissions and sandbox execution permissions

### 20. Learning / Improvement Pipeline

Outside hot path.

* Collect outcomes, failures, corrections
* Analyze agent performance
* Suggest improvements to prompts/tools/sub-agents
* Version reviewed updates

### 21. Background Jobs / Maintenance

* Cleanup
* Retention
* Reconciliation
* Reindexing
* Sync repair
* Learning jobs

## Suggested grouping for the final architecture document

### Core runtime

* API Gateway / Server API
* Auth & Identity
* Control Plane / Orchestrator
* Agent Registry & Configuration
* Sandbox Runtime Manager
* In-Sandbox Agent Runtime
* Tool Layer

### Data and file system

* File Manager
* Physical File Storage
* Context Store
* Relational Metadata & Permission Store
* File Access Projection Layer
* File Watcher / Reconciler
* Sync Layer

### Work orchestration

* Task & Run Manager
* Scheduler
* Background Jobs / Maintenance

### Integrations and governance

* Connector Platform
* Observability & Audit
* Security & Policy Enforcement
* Learning / Improvement Pipeline

## Candidate “Now / Next / Later” split

### Now (detailed)

* API Gateway / Server API
* Auth & Identity
* Control Plane / Orchestrator
* Agent Registry & Configuration
* Sandbox Runtime Manager
* In-Sandbox Agent Runtime
* Tool Layer
* File Manager
* Physical File Storage
* Context Store
* Relational Metadata & Permission Store
* File Access Projection Layer
* Task & Run Manager
* Scheduler
* Connector Platform
* Observability & Audit
* Security & Policy Enforcement

### Next (rough overview)

* File Watcher / Reconciler
* Sync Layer
* Background Jobs / Maintenance
* Learning / Improvement Pipeline

### Later (list only)

* Conflict/versioning system for shared file edits
* Controlled sharing across workspaces, agents, and user-attached directories
* Stricter sandbox partitioning for specific workspace/agent combinations when needed to reduce leakage risk
* Cross-session memory processing
* Agent-to-agent collaboration primitives
* Worktree/validation environments
* Distributed/multi-machine execution
* Advanced policy engine
* Native app support requirements on server side
* Proactive tool/skill recommendation services

## Open decisions to settle component by component

* One warm sandbox per agent type vs per-run isolation earlier
* Whether API Gateway and Control Plane are one service now
* Whether File Manager is a standalone service now or a module inside the API/control plane
* How much of connectors run inside the main server vs separate workers
* Whether scheduler dispatches directly or only through task/run manager
