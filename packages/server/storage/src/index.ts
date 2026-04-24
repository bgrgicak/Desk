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
  trashChatDirectories,
  resolveForSandbox,
  validateLibrarySubpath,
} from "./files.js";
export type { StorageContext, UploadArtifactInput, FileRef } from "./files.js";
export {
  listLibrary,
  createLibraryFolder,
  moveLibraryEntry,
  deleteLibraryEntry,
} from "./library.js";
export type { LibraryContext, FolderRef } from "./library.js";
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
