import { createHash } from "node:crypto";
import { normalizeUrl } from "@aihot/backend/lib/url";
import { parseLooseDate } from "@aihot/backend/sources/dates";
import type { MaterialInput } from "@aihot/backend/content/materials";
import { FEEDS, type FeedKey } from "./config.ts";

// RFC 4180: embedded commas/newlines, escaped quotes, BOM and CRLF all occur in the upstream exports.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, "");
  const finish = () => { row.push(field); if (row.some(Boolean)) rows.push(row); row = []; field = ""; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ",") { row.push(field); field = ""; closed = false; }
    else if (c === "\r" || c === "\n") { if (c === "\r" && text[i + 1] === "\n") i++; finish(); }
    else if (c === '"' && field === "" && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error("Malformed CSV quoting"); field += c; }
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  finish();
  const headers = rows.shift()?.map(h => h.trim()) ?? [];
  if (!headers.length || new Set(headers).size !== headers.length) throw new Error("Missing or duplicate CSV headers");
  return rows.map((values, i) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${i + 2}: expected ${headers.length} columns, got ${values.length}`);
    return Object.fromEntries(headers.map((key, j) => [key, values[j]]));
  });
}

export interface FeedItem {
  feed: FeedKey;
  source: { id: string; name: string };
  material: MaterialInput;
  quality: "full" | "abstract" | "unverified" | "empty";
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
const value = (row: Record<string, string>, ...keys: string[]) => keys.map(k => row[k]?.trim()).find(Boolean) ?? "";
const REQUIRED: Record<FeedKey, string[]> = {
  news: ["title", "url", "source_name", "published_at", "content"],
  wechat: ["title", "url", "account_name", "publish_time", "clean_text"],
  literature: ["title", "link", "source", "pub_date", "doi", "abstract"],
};

export function normalizeFeed(text: string, feed: FeedKey, inputPath: string): { items: FeedItem[]; rejected: number; rows: number } {
  const rows = parseCsv(text);
  // Also validate an empty file's header so a changed export format cannot silently look healthy.
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  const headers = firstLine.split(",").map(s => s.replace(/^"|"$/g, "").trim());
  if (REQUIRED[feed].some(k => !headers.includes(k))) throw new Error(`${feed}: export schema changed`);
  const items: FeedItem[] = [];
  let rejected = 0;
  for (const row of rows) {
    const title = value(row, "title"), url = value(row, feed === "literature" ? "link" : "url");
    const canonical = normalizeUrl(url);
    if (!title || !canonical || new URL(url).username || new URL(url).password) { rejected++; continue; }
    const sourceName = value(row, feed === "wechat" ? "account_name" : feed === "news" ? "source_name" : "source");
    if (!sourceName) { rejected++; continue; }
    const u = new URL(canonical);
    // Preserve individual publishers; three aggregate sources would destroy event heat semantics.
    const publisher = feed === "literature" ? `journal:${sourceName}`
      : u.hostname === "mp.weixin.qq.com" ? `wechat:${u.searchParams.get("__biz") || sourceName}`
      : `publisher:${u.hostname}:${sourceName}`;
    const source = { id: `repo-feed-${hash(publisher)}`, name: sourceName };
    const time = value(row, feed === "news" ? "published_at" : feed === "wechat" ? "publish_time" : "pub_date", ...(feed === "literature" ? ["published_str"] : []));
    const publishedAt = parseLooseDate(time);
    const content = value(row, feed === "news" ? "content" : feed === "wechat" ? "clean_text" : "abstract");
    const digest = value(row, "digest");
    // A summary policy wins over an inconsistent upstream 'full' flag. WeChat has no verified-full flag.
    const full = feed === "news" && row.content_status === "full" && !/summary|snippet|excerpt/i.test(row.content_policy ?? "");
    const quality = !content ? "empty" : feed === "literature" ? "abstract" : full ? "full" : "unverified";
    const doiText = value(row, "doi").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
    const doi = /^10\.\d{4,9}\/\S+$/.test(doiText) ? doiText : null;
    const evidence = full ? null : content || digest || null;
    items.push({ feed, source, quality, material: {
      sourceId: source.id, url, title, publishedAt,
      identityKey: feed === "literature" && doi ? `doi:${doi}` : undefined,
      author: value(row, "author", "last_author") || null,
      bodyText: full ? content : null,
      excerpt: evidence,
      // Imported abstracts are evidence, not full papers. Do not refetch a paywalled page on import.
      bodyStatus: full ? "ok" : "unconfirmed",
      via: "repo-feeds",
      raw: { repoFeed: { feed, repository: FEEDS.find(f => f.key === feed)!.repo, path: inputPath,
        doi, materialKind: quality, originalPublishedAt: time, datePrecision: /^\d{4}-\d{2}-\d{2}$/.test(time) ? "day" : "datetime",
        tags: value(row, "tags"), industryPath: value(row, "industry_primary_path"),
        domain: value(row, "domain"), subDomain: value(row, "sub_domain"),
        contentStatus: value(row, "content_status"), contentPolicy: value(row, "content_policy"),
        abstractSource: value(row, "abstract_source") } },
    } });
  }
  return { items, rows: rows.length, rejected };
}
