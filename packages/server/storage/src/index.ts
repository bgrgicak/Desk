export {
  ensureLayout,
  ensureWorkspaceLayout,
  renameWorkspaceDir,
  trashWorkspaceDir,
  chatAttachmentsDir,
  chatsDir,
  resolveDeskHome,
  resolveHostPath,
  tmpDir,
  trashDir,
  workspaceRootPath,
  workspacesRoot,
} from "./layout.js";
export {
  uploadArtifact,
  readFile,
  downloadFile,
  statFile,
  moveFile,
  deleteFile,
  overwriteFile,
  pinLibraryFileToChat,
  trashChatDirectories,
  resolveForSandbox,
  validateLibrarySubpath,
} from "./files.js";
export type { StorageContext, UploadArtifactInput, FileRef } from "./files.js";
export {
  listLibrary,
  createLibraryFolder,
  createLibraryLink,
  moveLibraryEntry,
  deleteLibraryEntry,
  loadGitignoreFrame,
  isGitIgnored,
} from "./library.js";
export type { LibraryContext, FolderRef, CreateLinkInput, IgnoreFrame } from "./library.js";
export { reconcileArtifactRefs } from "./reconcile.js";
export {
  snapshotNote,
  listNoteHistory,
  noteHistoryDir,
  notesDir,
  materializeNote,
  deleteMaterializedNote,
} from "./noteHistory.js";
export type { NoteVersion } from "./noteHistory.js";
export { enforceLogRetention } from "./logRetention.js";
