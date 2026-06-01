export const homeDayItemSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["task", "chat"] },
    id: { type: "string" },
    title: { type: "string" },
    preview: { type: "string" },
    status: { type: "string", enum: ["needs_input", "active", "done"] },
    statusLabel: { type: "string" },
    updatedAt: { type: "string", format: "date-time" },
    href: { type: "string" },
    room: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        color: { type: "string" },
        icon: { type: "string" },
      },
      required: ["id", "name", "color", "icon"],
    },
    chat: {
      type: "object",
      properties: {
        id: { type: "string" },
        unread: { type: "boolean" },
        running: { type: "boolean" },
        failed: { type: "boolean" },
        latestFailedMessageId: { type: ["string", "null"] },
      },
      required: ["id", "unread", "running", "failed", "latestFailedMessageId"],
    },
    task: { type: "object" },
  },
  required: ["kind", "id", "title", "preview", "status", "statusLabel", "updatedAt", "href", "room"],
};
