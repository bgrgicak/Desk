import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

interface FeedItem {
  title: string;
  link: string;
  guid: string;
  description: string;
  pubDate?: string;
}

export interface RssFeedOptions {
  siteUrl?: string;
  contentRoot?: string;
  now?: Date;
}

const DEFAULT_SITE_URL = "https://roomy.ai";
const DOC_DIRS = ["docs", "packages/server/docs"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "notes", "plans"]);

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeSiteUrl(siteUrl?: string): string {
  const raw = siteUrl ?? process.env.ROOMY_PUBLIC_URL ?? process.env.PUBLIC_URL ?? DEFAULT_SITE_URL;
  return raw.replace(/\/+$/, "") || DEFAULT_SITE_URL;
}

function docsUrl(siteUrl: string, relPath: string): string {
  const withoutExt = relPath.replace(/\.md$/i, "");
  return `${siteUrl}/${withoutExt.split(sep).map(encodeURIComponent).join("/")}`;
}

function titleFromMarkdown(markdown: string, relPath: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return relPath
    .replace(/\.md$/i, "")
    .split(sep)
    .pop()
    ?.replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase()) ?? "Documentation";
}

function descriptionFromMarkdown(markdown: string): string {
  const paragraph = markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith("#") && !block.startsWith("<!--"));

  return (paragraph ?? "Roomy documentation")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280) || "Roomy documentation";
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...await collectMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function resolveDefaultContentRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Source layout: packages/server/api/src/routes/rss.ts -> repo root.
  // Dist layout still lands inside packages/server/api/dist/routes, where
  // the fallback root simply has no docs and the feed remains valid.
  return resolve(here, "../../../../..");
}

async function buildDocItems(contentRoot: string, siteUrl: string): Promise<FeedItem[]> {
  const items: FeedItem[] = [];
  for (const docDir of DOC_DIRS) {
    const baseDir = join(contentRoot, docDir);
    const markdownFiles = await collectMarkdownFiles(baseDir);
    for (const file of markdownFiles) {
      const relPath = relative(contentRoot, file);
      const markdown = await readFile(file, "utf8");
      const s = await stat(file);
      const link = docsUrl(siteUrl, relPath);
      items.push({
        title: titleFromMarkdown(markdown, relPath),
        link,
        guid: link,
        description: descriptionFromMarkdown(markdown),
        pubDate: s.mtime.toUTCString(),
      });
    }
  }

  return items
    .sort((a, b) => Date.parse(b.pubDate ?? "") - Date.parse(a.pubDate ?? ""))
    .slice(0, 25);
}

export async function buildRssFeed(options: RssFeedOptions = {}): Promise<string> {
  const siteUrl = normalizeSiteUrl(options.siteUrl);
  const contentRoot = options.contentRoot ?? resolveDefaultContentRoot();
  const items = await buildDocItems(contentRoot, siteUrl);
  const now = options.now ?? new Date();

  const itemXml = items.map((item) => `
    <item>
      <title>${xmlEscape(item.title)}</title>
      <link>${xmlEscape(item.link)}</link>
      <guid isPermaLink="true">${xmlEscape(item.guid)}</guid>
      <description>${xmlEscape(item.description)}</description>${item.pubDate ? `
      <pubDate>${xmlEscape(item.pubDate)}</pubDate>` : ""}
    </item>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Roomy</title>
    <link>${xmlEscape(siteUrl)}</link>
    <description>Roomy product and documentation updates.</description>
    <language>en</language>
    <lastBuildDate>${xmlEscape(now.toUTCString())}</lastBuildDate>
    <ttl>60</ttl>${itemXml}
  </channel>
</rss>
`;
}

export async function sendRssFeed(res: ServerResponse, options: RssFeedOptions = {}): Promise<void> {
  const xml = await buildRssFeed(options);
  res.writeHead(200, {
    "Content-Type": "application/rss+xml; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  });
  res.end(xml);
}
