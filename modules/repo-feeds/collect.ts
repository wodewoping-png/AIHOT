import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { FEEDS, recentDays } from "./config.ts";
import { normalizeFeed, type FeedItem } from "./normalize.ts";

export async function readRemoteFeeds(days = recentDays()) {
  const items: FeedItem[] = [];
  const files: Array<{ repository: string; path: string; status: "ok" | "missing" | "error"; rows?: number; rejected?: number; error?: string }> = [];
  for (const feed of FEEDS) {
    for (const day of days) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Expected YYYY-MM-DD");
      const path = feed.path(day);
      try {
        const response = await guardedFetch(`https://raw.githubusercontent.com/${feed.repo}/main/${path}`, {
          maxBytes: 32 * 1024 * 1024, timeoutMs: 30000, maxRedirects: 0,
        });
        if (response.status === 404) { files.push({ repository: feed.repo, path, status: "missing" }); continue; }
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        const data = normalizeFeed(response.text(), feed.key, path);
        items.push(...data.items);
        files.push({ repository: feed.repo, path, status: "ok", rows: data.rows, rejected: data.rejected });
      } catch (error) {
        files.push({ repository: feed.repo, path, status: "error", error: String(error).slice(0, 300) });
      }
    }
  }
  return { items, files };
}
