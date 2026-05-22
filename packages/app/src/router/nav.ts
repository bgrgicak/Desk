export type RouteView = "pinned" | "tasks" | "context";

export function isRouteView(v: string | undefined): v is RouteView {
  return v === "pinned" || v === "tasks" || v === "context";
}

/** URL path segments that should resolve to a canonical {@link RouteView}.
 *  `library` is the user-facing name for the Library view (stored
 *  internally as `context`); `settings` is an alias that opens the
 *  Tasks view with the settings modal pre-selected (handled by the
 *  shell). Bookmarks and deep links to either path land on the
 *  matching canonical view instead of silently falling back to
 *  `tasks`. */
const ROUTE_VIEW_ALIASES: Record<string, RouteView> = {
  library: "context",
};

/** Resolve a URL path segment (raw `:view` param) to its canonical
 *  {@link RouteView}. Returns `null` for unknown segments so the
 *  caller can fall back to its own default. */
export function resolveRouteView(v: string | undefined): RouteView | null {
  if (!v) return null;
  if (isRouteView(v)) return v;
  return ROUTE_VIEW_ALIASES[v] ?? null;
}

// ── Settings + Account URL state ─────────────────────────────────────────────
//
// Two modals make up the settings surface:
//  - Workspace Settings ("?settings=…") — workspace, connections, preferences
//  - My Account ("?account=…")          — account, models, notifications, preferences
//
// The query value is dot-separated so a single param can carry both the
// section and any sub-focus (e.g. connections.new.claude). Anything
// unrecognized parses back to `null` and the modal stays closed.

export type WorkspaceSettingsSectionId =
  | "workspace"
  | "connections"
  | "preferences";

export type AccountSettingsSectionId =
  | "account"
  | "models"
  | "notifications"
  | "preferences";

export type ConnectionsFocus =
  | { mode: "picker" }
  | { mode: "new"; kind: string }
  | { mode: "edit"; id: string }
  | null;

export type ModelsFocus =
  | { mode: "new" }
  | { mode: "edit"; id: string }
  | null;

export interface WorkspaceSettingsState {
  section: WorkspaceSettingsSectionId;
  connectionsFocus: ConnectionsFocus;
}

export interface AccountSettingsState {
  section: AccountSettingsSectionId;
  modelsFocus: ModelsFocus;
}

const WORKSPACE_SECTIONS: ReadonlySet<string> = new Set([
  "workspace",
  "connections",
  "preferences",
]);
const ACCOUNT_SECTIONS: ReadonlySet<string> = new Set([
  "account",
  "models",
  "notifications",
  "preferences",
]);

export function parseWorkspaceSettings(
  raw: string | null,
): WorkspaceSettingsState | null {
  if (!raw) return null;
  const parts = raw.split(".");
  const section = parts[0];
  if (!WORKSPACE_SECTIONS.has(section)) return null;
  if (section !== "connections") {
    return {
      section: section as WorkspaceSettingsSectionId,
      connectionsFocus: null,
    };
  }
  // connections.* sub-states
  const sub = parts[1];
  if (!sub) {
    return { section: "connections", connectionsFocus: null };
  }
  if (sub === "picker") {
    return { section: "connections", connectionsFocus: { mode: "picker" } };
  }
  if (sub === "new" && parts[2]) {
    return {
      section: "connections",
      connectionsFocus: { mode: "new", kind: parts[2] },
    };
  }
  if (sub === "edit" && parts[2]) {
    // Connection ids may legitimately contain dots; rejoin the tail.
    const id = parts.slice(2).join(".");
    return {
      section: "connections",
      connectionsFocus: { mode: "edit", id },
    };
  }
  return { section: "connections", connectionsFocus: null };
}

export function parseAccountSettings(
  raw: string | null,
): AccountSettingsState | null {
  if (!raw) return null;
  const parts = raw.split(".");
  const section = parts[0];
  if (!ACCOUNT_SECTIONS.has(section)) return null;
  if (section !== "models") {
    return {
      section: section as AccountSettingsSectionId,
      modelsFocus: null,
    };
  }
  const sub = parts[1];
  if (!sub) return { section: "models", modelsFocus: null };
  if (sub === "new") return { section: "models", modelsFocus: { mode: "new" } };
  if (sub === "edit" && parts[2]) {
    const id = parts.slice(2).join(".");
    return { section: "models", modelsFocus: { mode: "edit", id } };
  }
  return { section: "models", modelsFocus: null };
}

export function encodeWorkspaceSettings(state: WorkspaceSettingsState): string {
  if (state.section !== "connections") return state.section;
  const focus = state.connectionsFocus;
  if (!focus) return "connections";
  if (focus.mode === "picker") return "connections.picker";
  if (focus.mode === "new") return `connections.new.${focus.kind}`;
  return `connections.edit.${focus.id}`;
}

export function encodeAccountSettings(state: AccountSettingsState): string {
  if (state.section !== "models") return state.section;
  const focus = state.modelsFocus;
  if (!focus) return "models";
  if (focus.mode === "new") return "models.new";
  return `models.edit.${focus.id}`;
}

export interface NavQuery {
  chat?: string | null;
  artifact?: string | null;
  item?: string | null;
  /** Current Library folder (workspace-relative path). Null/absent means root. */
  folder?: string | null;
  /** Message id to scroll to inside the selected chat. Cleared when the
   * user navigates within the chat normally. */
  message?: string | null;
  artifactParams?: string | null;
  /** Encoded as `chatId:messageId`. When present with chat=new, the first
   * sent message creates a thread anchored at this message instead of a
   * new standalone chat. */
  startThread?: string | null;
  /** Selected task id on the Tasks view — opens its chat in the
   * docked right sidebar (mirrors `item` for the Library detail). */
  task?: string | null;
  /** Workspace Settings modal state, dot-encoded. Pass null/empty to close. */
  settings?: string | null;
  /** My Account modal state, dot-encoded. Pass null/empty to close. */
  account?: string | null;
}

export const NEW_CHAT_ID = "new";

export function buildPath(
  wsId: string,
  view: RouteView,
  q: NavQuery = {},
): string {
  const sp = new URLSearchParams();
  if (q.chat) sp.set("chat", q.chat);
  if (q.artifact) sp.set("artifact", q.artifact);
  if (q.item) sp.set("item", q.item);
  if (q.folder) sp.set("folder", q.folder);
  if (q.message) sp.set("message", q.message);
  if (q.artifactParams) sp.set("artifactParams", q.artifactParams);
  if (q.startThread) sp.set("startThread", q.startThread);
  if (q.task) sp.set("task", q.task);
  if (q.settings) sp.set("settings", q.settings);
  if (q.account) sp.set("account", q.account);
  const s = sp.toString();
  return `/w/${wsId}/${view}${s ? "?" + s : ""}`;
}

/** Merge `patch` into the current URL's query string, preserving the
 *  pathname and any other params. `null`/empty values are removed. */
export function mergeSearch(
  search: string,
  patch: Record<string, string | null | undefined>,
): string {
  const sp = new URLSearchParams(search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") sp.delete(k);
    else sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
