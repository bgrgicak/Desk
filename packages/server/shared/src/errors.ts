export class DeskError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "DeskError";
    this.code = code;
  }
}

export class NotFoundError extends DeskError {
  constructor(message: string, cause?: unknown) {
    super("NOT_FOUND", message, cause);
  }
}

export class UnauthorizedError extends DeskError {
  constructor(message: string, cause?: unknown) {
    super("UNAUTHORIZED", message, cause);
  }
}

export class ForbiddenError extends DeskError {
  constructor(message: string, cause?: unknown) {
    super("FORBIDDEN", message, cause);
  }
}

export class ValidationError extends DeskError {
  constructor(message: string, cause?: unknown) {
    super("VALIDATION", message, cause);
  }
}

export class ConflictError extends DeskError {
  constructor(message: string, cause?: unknown) {
    super("CONFLICT", message, cause);
  }
}

export class InternalError extends DeskError {
  constructor(message: string, cause?: unknown) {
    super("INTERNAL", message, cause);
  }
}
