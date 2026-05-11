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
      "/me/providers/local",
      "/me/providers/local/{kind}",
      "/workspaces",
      "/workspaces/{id}",
      "/workspaces/{id}/agents",
      "/workspaces/{id}/agents/{agentId}",
      "/agents",
      "/agents/{id}",
      "/chats",
      "/chats/{id}",
      "/chats/{id}/messages",
      "/chats/{id}/messages/{messageId}",
      "/chats/{id}/messages/{messageId}/logs",
      "/chats/{id}/attachments",
      "/messages",
      "/library",
      "/library/meta",
      "/library/download",
      "/library/content",
      "/tools/models",
      "/search",
      "/ws",
      "/openapi.json",
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

  it("documents nullable chat goals where the API accepts clearing them", () => {
    const chat = spec.paths["/chats/{id}"] as Record<string, { requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> } }>;
    const patchGoal = chat.patch.requestBody?.content?.["application/json"].schema?.properties?.goal;
    expect(patchGoal).toMatchObject({ type: ["string", "null"] });

    const messages = spec.paths["/chats/{id}/messages"] as Record<string, { requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> } }>;
    const messageGoal = messages.post.requestBody?.content?.["application/json"].schema?.properties?.goal;
    expect(messageGoal).toMatchObject({ type: ["string", "null"] });
  });
});
