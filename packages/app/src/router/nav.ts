export type RouteView = "pinned" | "tasks" | "context";

export function isRouteView(v: string | undefined): v is RouteView {
  return v === "pinned" || v === "tasks" || v === "context";
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
  const s = sp.toString();
  return `/w/${wsId}/${view}${s ? "?" + s : ""}`;
}
