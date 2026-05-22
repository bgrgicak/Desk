import { RoomyError } from "@roomy-ai/shared";

/** Maps RoomyError codes to HTTP status codes. */
export function errorToStatus(err: RoomyError): number {
  switch (err.code) {
    case "NOT_FOUND": return 404;
    case "UNAUTHORIZED": return 401;
    case "FORBIDDEN": return 403;
    case "VALIDATION": return 400;
    case "CONFLICT": return 409;
    case "VAULT_LOCKED": return 423;
    case "RUNTIME_UNAVAILABLE": return 503;
    default: return 500;
  }
}
