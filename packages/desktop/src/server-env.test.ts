import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildServerEnvConfig, DEFAULT_SANDBOX_IMAGE } from "./server-env.js";

const OPTS = {
  roomyHome: "/tmp/roomy-test",
  secretKey: "test-secret",
  appDist: "/tmp/app-dist",
  port: 35138,
};

describe("buildServerEnvConfig", () => {
  let savedImage: string | undefined;

  beforeEach(() => {
    savedImage = process.env.ROOMY_SANDBOX_IMAGE;
    delete process.env.ROOMY_SANDBOX_IMAGE;
  });

  afterEach(() => {
    if (savedImage === undefined) delete process.env.ROOMY_SANDBOX_IMAGE;
    else process.env.ROOMY_SANDBOX_IMAGE = savedImage;
  });

  it("sets ROOMY_SANDBOX_IMAGE to the published registry image by default", () => {
    const env = buildServerEnvConfig(OPTS);
    expect(env.ROOMY_SANDBOX_IMAGE).toBe(DEFAULT_SANDBOX_IMAGE);
  });

  it("respects a custom ROOMY_SANDBOX_IMAGE override", () => {
    process.env.ROOMY_SANDBOX_IMAGE = "my-registry/custom-sandbox:v2";
    const env = buildServerEnvConfig(OPTS);
    expect(env.ROOMY_SANDBOX_IMAGE).toBe("my-registry/custom-sandbox:v2");
  });

  it("sets ROOMY_HOME, PORT, ROOMY_SERVE_APP, ROOMY_APP_DIST, ROOMY_SECRET_KEY", () => {
    const env = buildServerEnvConfig(OPTS);
    expect(env.ROOMY_HOME).toBe(OPTS.roomyHome);
    expect(env.PORT).toBe(String(OPTS.port));
    expect(env.ROOMY_SERVE_APP).toBe("1");
    expect(env.ROOMY_APP_DIST).toBe(OPTS.appDist);
    expect(env.ROOMY_SECRET_KEY).toBe(OPTS.secretKey);
  });
});
