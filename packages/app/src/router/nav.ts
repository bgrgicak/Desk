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
  const s = sp.toString();
  return `/w/${wsId}/${view}${s ? "?" + s : ""}`;
}
