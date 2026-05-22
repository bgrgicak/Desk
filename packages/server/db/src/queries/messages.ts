// Barrel for the messages queries. The actual implementations live in
// the three sibling files below; this file exists to keep the
// `queries.messages.*` import surface stable for the ~50 call sites
// across the server.
//
//   messages-internal.ts  helpers, SQL constants, row mappers, types
//   messages-reads.ts     listByChat, listCrossChat, findById, etc.
//   messages-writes.ts    insert, updateMessage, recoverOrphanedRuns, etc.

export type { MessageListView, PaginatedMessages } from "./messages-internal.js";
export {
  findAnchorForThreadChat,
  findById,
  listAgentContextByChat,
  listByChat,
  listCrossChat,
  type CrossChatListOptions,
} from "./messages-reads.js";
export {
  claimPending,
  finalizeExecution,
  insert,
  recoverOrphanedRuns,
  retargetAttachmentPaths,
  setThreadChatId,
  startTaskRun,
  updateMessage,
  updateMessageIfState,
} from "./messages-writes.js";
export {
  decorateMessageWithTaskStatus,
  decorateMessagesWithTaskStatus,
  findTasksAffectedByChat,
} from "./messages-task-status.js";
