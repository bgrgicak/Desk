import type { WorkspaceInfo } from "@/components/layout/WorkspaceBar";
import type { ServerWorkspace } from "../types";

/**
 * Client-side palette used as a fallback for workspaces with no stored
 * color (empty string). Once a user picks a color in the Customize modal
 * it is persisted server-side and overrides this palette.
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

export function toWorkspaceInfo(w: ServerWorkspace): WorkspaceInfo {
  const emoji = w.icon && w.icon.length > 0 ? w.icon : "🏷️";
  const bg =
    w.color && w.color.length > 0
      ? w.color
      : BG_PALETTE[hashCode(w.id) % BG_PALETTE.length];
  return {
    id: w.id,
    name: w.name,
    emoji,
    bg,
    description: w.description,
    unreadCount: 0,
  };
}
