import type { WorkspaceInfo } from "@/components/layout/WorkspaceBar";
import type { ServerWorkspace } from "../types";

/**
 * Client-side palette used to give workspaces a stable tab color until the
 * server grows a `color`/`bg` field.
 */
const BG_PALETTE = [
  "#fef3c7",
  "#dbeafe",
  "#fce7f3",
  "#d1fae5",
  "#ede9fe",
  "#ffedd5",
  "#fee2e2",
  "#ccfbf1",
];

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Map a server Workspace to the client-side WorkspaceInfo the existing
 * WorkspaceBar component expects. Shape is preserved (emoji/bg/description/…)
 * so no component render changes are needed.
 */
export function toWorkspaceInfo(w: ServerWorkspace): WorkspaceInfo {
  const emoji = w.icon && w.icon.length > 0 ? w.icon : "🏷️";
  const bg = BG_PALETTE[hashCode(w.id) % BG_PALETTE.length];
  return {
    id: w.id,
    name: w.name,
    emoji,
    bg,
    description: w.description,
    unreadCount: 0,
  };
}
