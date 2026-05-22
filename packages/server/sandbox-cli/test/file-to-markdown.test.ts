import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { run } from "../src/commands/file-to-markdown.js";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

describe("roomy-agent file to-markdown", () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execFileMock.mockReset();
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  it("converts PDFs with pdftotext", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, "PDF text\n", "");
    });

    await run(["report.pdf"]);

    expect(execFileMock).toHaveBeenCalledWith(
      "pdftotext",
      ["-layout", "report.pdf", "-"],
      expect.objectContaining({ encoding: "utf8" }),
      expect.any(Function),
    );
  });

  it("converts document formats with pandoc markdown output", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, "# Report\n", "");
    });

    await run(["report.docx"]);

    expect(execFileMock).toHaveBeenCalledWith(
      "pandoc",
      ["--from", "docx", "--to", "gfm", "--wrap=none", "report.docx"],
      expect.objectContaining({ encoding: "utf8" }),
      expect.any(Function),
    );
  });

  it("normalizes reStructuredText with pandoc", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, "# Title\n", "");
    });

    await run(["notes.rst"]);

    expect(execFileMock).toHaveBeenCalledWith(
      "pandoc",
      ["--from", "rst", "--to", "gfm", "--wrap=none", "notes.rst"],
      expect.objectContaining({ encoding: "utf8" }),
      expect.any(Function),
    );
  });

  it("writes to --output when provided", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "roomy-file-to-markdown-"));
    const output = path.join(dir, "report.md");
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(null, "Converted text\n", "");
    });

    await run(["--output", output, "report.odt"]);

    await expect(readFile(output, "utf8")).resolves.toBe("Converted text\n");
  });

  it("passes through plain text and markdown without external tools", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "roomy-file-to-markdown-"));
    const input = path.join(dir, "notes.md");
    await writeFile(input, "Already readable\n", "utf8");

    await run([input]);

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported binary formats", async () => {
    await expect(run(["image.png"])).rejects.toThrow(/Unsupported file extension/);
  });
});
