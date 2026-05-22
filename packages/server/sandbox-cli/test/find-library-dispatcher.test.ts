import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands.js";

describe("roomy-agent find dispatcher", () => {
  it("keeps find artifacts as a compatibility alias for find library", async () => {
    const libraryCommand = await COMMANDS["find library"]();
    const artifactsCommand = await COMMANDS["find artifacts"]();

    expect(artifactsCommand.run).toBe(libraryCommand.run);
    expect(artifactsCommand.usage).toBe(libraryCommand.usage);
  });
});
