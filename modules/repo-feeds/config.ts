// Reuse the three existing collectors. These are daily exports, never weekly rollups.
export const FEEDS = [
  { key: "news", repo: "wodewoping-png/news-spider", path: (day: string) => `data/articles-${day}.csv` },
  { key: "wechat", repo: "wodewoping-png/wechat-daily-news-csv", path: (day: string) => `csv/${day}.csv` },
  { key: "literature", repo: "wodewoping-png/literature-rss-spider", path: (day: string) => `output/news_with_abstract_${day}.csv` },
] as const;
export type FeedKey = typeof FEEDS[number]["key"];

export function recentDays(now = new Date(), count = 3): string[] {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(now);
  const start = Date.parse(`${day}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(start - i * 86400000).toISOString().slice(0, 10));
}
