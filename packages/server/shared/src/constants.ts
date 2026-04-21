export const ID_PREFIXES = {
  user: "usr_",
  agent: "agt_",
  workspace: "wks_",
  chat: "cht_",
  message: "msg_",
  file: "fil_",
  run: "run_",
  scheduledJob: "job_",
  note: "note_",
  runEvent: "rev_",
  sandboxSession: "sbs_",
} as const;

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 128 * 1024;
export const DEFAULT_LIBRARY_PAGE_SIZE = 50;

export const RUN_STATES = ["pending", "running", "succeeded", "failed", "cancelled"] as const;
export const FILE_CLASSES = ["artifact", "workspace", "note", "cache", "library"] as const;
export const MESSAGE_ROLES = ["user", "agent", "system", "tool"] as const;
export const SCHEDULED_JOB_KINDS = ["once", "recurring", "ai_note"] as const;
export const RUN_EVENT_KINDS = ["stdout", "stderr", "event"] as const;
