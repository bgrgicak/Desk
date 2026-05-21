// Shared shape used by the sidebar, top bar, and settings modal. The
// nav-rail render path that this file used to contain has been removed in
// favour of `TopBar` + `RoomSidebar`; the type stays here so existing
// imports across the app don't need to be retargeted.

export interface WorkspaceInfo {
  id: string
  name: string
  emoji: string
  bg: string
  description: string
  unreadCount: number
}
