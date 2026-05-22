export class RoomyError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RoomyError";
    this.code = code;
  }
}

export class NotFoundError extends RoomyError {
  constructor(message: string, cause?: unknown) {
    super("NOT_FOUND", message, cause);
  }
}

export class UnauthorizedError extends RoomyError {
  constructor(message: string, cause?: unknown) {
    super("UNAUTHORIZED", message, cause);
  }
}

export class ForbiddenError extends RoomyError {
  constructor(message: string, cause?: unknown) {
    super("FORBIDDEN", message, cause);
  }
}

export class ValidationError extends RoomyError {
  constructor(message: string, cause?: unknown) {
    super("VALIDATION", message, cause);
  }
}

export class ConflictError extends RoomyError {
  constructor(message: string, cause?: unknown) {
    super("CONFLICT", message, cause);
  }
}

export class InternalError extends RoomyError {
  constructor(message: string, cause?: unknown) {
    super("INTERNAL", message, cause);
  }
}

/**
 * Returned when a per-user secrets vault is locked. Maps to HTTP 423
 * (Locked); the client is expected to prompt the user for the master
 * password and call POST /vault/unlock before retrying.
 */
export class VaultLockedError extends RoomyError {
  constructor(message = "Vault is locked", cause?: unknown) {
    super("VAULT_LOCKED", message, cause);
  }
}
