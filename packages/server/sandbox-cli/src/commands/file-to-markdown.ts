import { execFile } from "node:child_process";
import { extname } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { CliError, parseFlags } from "../errors.js";

export const usage =
  "roomy-agent file to-markdown [--output <path>] <workspace-relative-path>";

export const help = `\
roomy-agent file to-markdown — convert a document into agent-readable Markdown/text.

Required:
  <workspace-relative-path>    Document to convert.

Optional:
  --output <path>              Write converted text to this path. Defaults to stdout.

Supported:
  PDF via pdftotext: .pdf
  Pandoc formats: .docx, .odt, .rtf, .html, .htm, .epub, .tex, .rst
  Already-readable text: .md, .markdown, .txt, .csv, .tsv, .json, .xml, .yaml, .yml

Examples:
  roomy-agent file to-markdown report.pdf
  roomy-agent file to-markdown --output report.md report.docx

Exit codes:
  0 on success — converted text on stdout or written to --output.
  Non-zero on failure — JSON {code, message} on stderr.`;

const plainTextExtensions = new Set([
  ".csv",
  ".json",
  ".markdown",
  ".md",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const pandocInputs = new Map<string, string>([
  [".docx", "docx"],
  [".epub", "epub"],
  [".htm", "html"],
  [".html", "html"],
  [".odt", "odt"],
  [".rtf", "rtf"],
  [".rst", "rst"],
  [".tex", "latex"],
]);

export async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(help + "\n");
    return;
  }

  const { flags, positionals } = parseFlags(argv);
  const outputPath = flags["output"];
  const inputPath = positionals.join(" ");

  if (!inputPath) {
    throw new CliError("INVALID_ARGS", "Missing input path. Usage:\n" + usage);
  }
  if (outputPath !== undefined && (typeof outputPath !== "string" || !outputPath)) {
    throw new CliError("INVALID_ARGS", "Missing value for --output <path>. Usage:\n" + usage);
  }

  const markdown = await convertToMarkdown(inputPath);
  if (typeof outputPath === "string") {
    await writeFile(outputPath, markdown, "utf8");
    return;
  }
  process.stdout.write(markdown);
}

async function convertToMarkdown(inputPath: string): Promise<string> {
  const ext = extname(inputPath).toLowerCase();

  if (plainTextExtensions.has(ext)) {
    return await readFile(inputPath, "utf8");
  }

  if (ext === ".pdf") {
    return await execFileUtf8("pdftotext", ["-layout", inputPath, "-"], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
  }

  const pandocFrom = pandocInputs.get(ext);
  if (pandocFrom) {
    return await execFileUtf8(
      "pandoc",
      ["--from", pandocFrom, "--to", "gfm", "--wrap=none", inputPath],
      { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
    );
  }

  throw new CliError(
    "UNSUPPORTED_FILE",
    `Unsupported file extension '${ext || "(none)"}'. Convert PDFs, DOCX, ODT, RTF, HTML, EPUB, LaTeX, reStructuredText, or plain text files.`,
  );
}

function execFileUtf8(
  command: string,
  args: string[],
  options: { encoding: "utf8"; maxBuffer: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      if (stderr) {
        process.stderr.write(stderr);
      }
      resolve(stdout);
    });
  });
}
