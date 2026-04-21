import { describe, it, expect } from "vitest";
import {
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  InternalError,
} from "@desk/shared";
import { errorToStatus } from "../src/errors.js";

describe("errorToStatus", () => {
  it("maps NotFoundError to 404", () => {
    expect(errorToStatus(new NotFoundError("test"))).toBe(404);
  });

  it("maps UnauthorizedError to 401", () => {
    expect(errorToStatus(new UnauthorizedError("test"))).toBe(401);
  });

  it("maps ForbiddenError to 403", () => {
    expect(errorToStatus(new ForbiddenError("test"))).toBe(403);
  });

  it("maps ValidationError to 400", () => {
    expect(errorToStatus(new ValidationError("test"))).toBe(400);
  });

  it("maps ConflictError to 409", () => {
    expect(errorToStatus(new ConflictError("test"))).toBe(409);
  });

  it("maps InternalError to 500", () => {
    expect(errorToStatus(new InternalError("test"))).toBe(500);
  });
});
