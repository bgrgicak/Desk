import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server.js";

describe("server", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  it("GET / returns 200 hello world", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("hello world");
  });

  it("GET /unknown returns 404", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("POST / returns 404", async () => {
    const res = await fetch(`${baseUrl}/`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
