import { DeskError } from "@agent-desk/shared";

/** Maps DeskError codes to HTTP status codes. */
export function errorToStatus(err: DeskError): number {
  switch (err.code) {
    case "NOT_FOUND": return 404;
    case "UNAUTHORIZED": return 401;
    case "FORBIDDEN": return 403;
    case "VALIDATION": return 400;
    case "CONFLICT": return 409;
    default: return 500;
  }
}
