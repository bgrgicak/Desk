import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { MAX_MESSAGE_BYTES, ValidationError } from "@roomy-ai/shared";
import { readRawBody } from "../src/http/io.js";

describe("readRawBody", () => {
  it("rejects bodies larger than the default buffered-body limit", async () => {
    const req = Readable.from(Buffer.alloc(MAX_MESSAGE_BYTES + 1, "x")) as unknown as Parameters<typeof readRawBody>[0];

    await expect(readRawBody(req)).rejects.toThrow(ValidationError);
  });
});
