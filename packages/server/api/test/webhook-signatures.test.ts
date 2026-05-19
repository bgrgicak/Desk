import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../src/webhooks/signatures.js";

function hmacHex(body: string | Buffer, secret: string, algorithm: "sha256" | "sha1" | "sha512" = "sha256"): string {
  return createHmac(algorithm, secret).update(body).digest("hex");
}

describe("verifyWebhookSignature", () => {
  const body = '{"event":"push","ref":"refs/heads/main"}';
  const secret = "deadbeefcafe";
  const NOW = 1_715_000_000_000;
  const now = () => NOW;

  it("accepts a correct hex signature with a fresh timestamp", () => {
    const sig = hmacHex(body, secret);
    expect(
      verifyWebhookSignature({
        body,
        signatureHeader: sig,
        secret,
        timestamp: String(Math.floor(NOW / 1000)),
        now,
      }).ok,
    ).toBe(true);
  });

  it("accepts the GitHub 'sha256=' prefix on hex signatures", () => {
    const sig = "sha256=" + hmacHex(body, secret);
    expect(
      verifyWebhookSignature({
        body,
        signatureHeader: sig,
        secret,
        timestamp: String(Math.floor(NOW / 1000)),
        now,
      }).ok,
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = hmacHex(body, secret);
    const r = verifyWebhookSignature({
      body: body + "x",
      signatureHeader: sig,
      secret,
      timestamp: String(Math.floor(NOW / 1000)),
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad-signature");
  });

  it("rejects when the timestamp is past the replay window", () => {
    const sig = hmacHex(body, secret);
    const old = Math.floor((NOW - 10 * 60 * 1000) / 1000); // 10 min old, default window is 5 min
    const r = verifyWebhookSignature({
      body,
      signatureHeader: sig,
      secret,
      timestamp: String(old),
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("replay-too-old");
  });

  it("rejects when the timestamp is missing", () => {
    const sig = hmacHex(body, secret);
    const r = verifyWebhookSignature({
      body,
      signatureHeader: sig,
      secret,
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing-timestamp");
  });

  it("skips the timestamp check when replayWindowMs=0 (for providers without timestamps)", () => {
    const sig = hmacHex(body, secret);
    expect(
      verifyWebhookSignature({
        body,
        signatureHeader: sig,
        secret,
        replayWindowMs: 0,
        now,
      }).ok,
    ).toBe(true);
  });

  it("accepts a base64 signature too", () => {
    const sig = createHmac("sha256", secret).update(body).digest("base64");
    expect(
      verifyWebhookSignature({
        body,
        signatureHeader: sig,
        secret,
        timestamp: String(Math.floor(NOW / 1000)),
        now,
      }).ok,
    ).toBe(true);
  });

  it("supports sha1 + sha512 for upstreams that need them", () => {
    const sigSha1 = "sha1=" + hmacHex(body, secret, "sha1");
    expect(
      verifyWebhookSignature({
        body,
        signatureHeader: sigSha1,
        secret,
        algorithm: "sha1",
        timestamp: String(Math.floor(NOW / 1000)),
        now,
      }).ok,
    ).toBe(true);

    const sigSha512 = "sha512=" + hmacHex(body, secret, "sha512");
    expect(
      verifyWebhookSignature({
        body,
        signatureHeader: sigSha512,
        secret,
        algorithm: "sha512",
        timestamp: String(Math.floor(NOW / 1000)),
        now,
      }).ok,
    ).toBe(true);
  });

  it("rejects timestamp='0' (epoch) when the replay window is enforced", () => {
    const sig = hmacHex(body, secret);
    const r = verifyWebhookSignature({
      body,
      signatureHeader: sig,
      secret,
      timestamp: "0",
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("replay-too-old");
  });

  it("rejects a prefix that doesn't match the requested algorithm", () => {
    const sig = "sha512=" + hmacHex(body, secret, "sha256"); // wrong-prefix replay
    const r = verifyWebhookSignature({
      body,
      signatureHeader: sig,
      secret,
      algorithm: "sha256",
      timestamp: String(Math.floor(NOW / 1000)),
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad-signature");
  });

  it("rejects an unparseable signature header", () => {
    const r = verifyWebhookSignature({
      body,
      signatureHeader: "!!!!notavalidsig!!!!",
      secret,
      replayWindowMs: 0,
      now,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad-signature");
  });
});
