export type RouteView = "desk" | "runs" | "context";

export function isRouteView(v: string | undefined): v is RouteView {
  return v === "desk" || v === "runs" || v === "context";
}

export interface NavQuery {
  chat?: string | null;
  artifact?: string | null;
  item?: string | null;
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
  const s = sp.toString();
  return `/w/${wsId}/${view}${s ? "?" + s : ""}`;
}
