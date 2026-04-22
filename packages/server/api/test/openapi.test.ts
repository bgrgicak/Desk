import { describe, it, expect } from "vitest";
import { generateOpenApiSpec } from "../src/openapi.js";

describe("OpenAPI spec", () => {
  const spec = generateOpenApiSpec();

  it("has version 3.1.0", () => {
    expect(spec.openapi).toBe("3.1.0");
  });

  it("declares all v1 routes", () => {
    const expectedPaths = [
      "/auth/login",
      "/auth/logout",
      "/me",
      "/me/password",
      "/me/providers",
      "/workspaces",
      "/workspaces/{id}",
      "/workspaces/{id}/agents",
      "/workspaces/{id}/agents/{agentId}",
      "/workspaces/{id}/default-agent",
      "/agents",
      "/agents/{id}",
      "/chats",
      "/chats/{id}",
      "/chats/{id}/messages",
      "/chats/{id}/artifacts",
      "/library",
      "/library/meta",
      "/library/download",
      "/runs",
      "/runs/{id}",
      "/runs/{id}/logs",
      "/runs/{id}/cancel",
      "/scheduled-jobs",
      "/scheduled-jobs/{id}",
      "/tools/models",
      "/search",
      "/ws",
      "/openapi.json",
      "/internal/runs/fire",
      "/internal/messages/fire",
    ];

    for (const p of expectedPaths) {
      expect(spec.paths).toHaveProperty(p);
    }
  });

  it("has bearer auth security scheme", () => {
    expect(spec.components.securitySchemes).toHaveProperty("bearerAuth");
  });

  it("login and openapi.json have empty security (no auth)", () => {
    const login = spec.paths["/auth/login"] as Record<string, { security?: unknown[] }>;
    expect(login.post.security).toEqual([]);

    const openapi = spec.paths["/openapi.json"] as Record<string, { security?: unknown[] }>;
    expect(openapi.get.security).toEqual([]);
  });
});
