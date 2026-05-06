import { describe, it, expect } from "vitest";
import {
  estimateStringTokens,
  estimateMessagesTokens,
  transcriptExceedsBudget,
} from "../src/tokenize.js";

describe("estimateStringTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateStringTokens("")).toBe(0);
  });

  it("returns 1 for any non-empty short string", () => {
    expect(estimateStringTokens("a")).toBe(1);
    expect(estimateStringTokens("abc")).toBe(1);
    expect(estimateStringTokens("abcd")).toBe(1);
  });

  it("uses ceil(chars/4) for longer strings", () => {
    expect(estimateStringTokens("a".repeat(8))).toBe(2);
    expect(estimateStringTokens("a".repeat(9))).toBe(3);
    expect(estimateStringTokens("a".repeat(40))).toBe(10);
  });

  it("falls within 5% of a 4-chars-per-token assumption for typical English", () => {
    const sample = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const expected = sample.length / 4;
    const got = estimateStringTokens(sample);
    const pct = Math.abs(got - expected) / expected;
    expect(pct).toBeLessThan(0.05);
  });
});

describe("estimateMessagesTokens", () => {
  it("includes per-message overhead so empty messages still cost tokens", () => {
    const tokens = estimateMessagesTokens([
      { text: "", role: "user" },
      { text: "", role: "agent" },
    ]);
    // 0 body + 4 overhead per message × 2 messages = 8.
    expect(tokens).toBe(8);
  });

  it("sums body + overhead across messages", () => {
    const tokens = estimateMessagesTokens([
      { text: "a".repeat(40), role: "user" },     // 10 + 4 = 14
      { text: "a".repeat(40), role: "agent" },    // 10 + 4 = 14
    ]);
    expect(tokens).toBe(28);
  });

  it("tolerates messages with missing text and role fields", () => {
    const tokens = estimateMessagesTokens([{}]);
    expect(tokens).toBe(4);
  });
});

describe("transcriptExceedsBudget", () => {
  const window = 200_000;

  it("returns false when transcript is well under the budget", () => {
    const messages = [{ text: "hello there", role: "user" }];
    expect(transcriptExceedsBudget(messages, window)).toBe(false);
  });

  it("returns true when transcript meets or exceeds the default 60% threshold", () => {
    // 60% of 200k = 120k tokens ≈ 480k chars.
    const text = "a".repeat(481_000);
    const messages = [{ text, role: "user" }];
    expect(transcriptExceedsBudget(messages, window)).toBe(true);
  });

  it("respects an overridden fraction", () => {
    // 30% of 200k = 60k tokens ≈ 240k chars.
    const text = "a".repeat(241_000);
    const messages = [{ text, role: "user" }];
    expect(transcriptExceedsBudget(messages, window, 0.3)).toBe(true);
    expect(transcriptExceedsBudget(messages, window, 0.6)).toBe(false);
  });

  it("returns false when the window is zero or negative", () => {
    expect(transcriptExceedsBudget([{ text: "x" }], 0)).toBe(false);
    expect(transcriptExceedsBudget([{ text: "x" }], -1)).toBe(false);
  });
});
