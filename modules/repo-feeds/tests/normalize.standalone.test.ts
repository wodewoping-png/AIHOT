import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, normalizeFeed } from "../normalize.ts";
import { recentDays } from "../config.ts";

const csv = (row: Record<string, string>) => Object.keys(row).join(",") + "\n" + Object.values(row).map(v => '"' + v.replaceAll('"', '""') + '"').join(",");
const news = { title: '标题 "新材料"', url: "https://example.com/a?utm_source=x", source_name: "媒体 A", published_at: "2026-10-12 09:00:00", content: "第一段,正文\n第二段", content_status: "full", content_policy: "" };

test("CSV preserves quoted commas, line breaks, BOM, CRLF and escaped quotes", () => {
  assert.deepEqual(parseCsv("\uFEFFa,b\r\n\"x,\"\"y\"\"\",\"line1\nline2\"\r\n"), [{ a: 'x,"y"', b: "line1\nline2" }]);
  assert.throws(() => parseCsv('a,b\n"unfinished'), /Unclosed/);
  assert.throws(() => parseCsv('a,b\nx,y,z'), /columns/);
});
test("news body, timezone, original source and quality survive mapping", () => {
  const [item] = normalizeFeed(csv(news), "news", "test.csv").items;
  assert.equal(item.material.bodyText, news.content);
  assert.equal(item.material.publishedAt?.toISOString(), "2026-10-12T01:00:00.000Z");
  assert.equal(item.source.name, "媒体 A");
  assert.equal(item.quality, "full");
  const [summary] = normalizeFeed(csv({ ...news, content_policy: "public_rss_summary" }), "news", "test.csv").items;
  assert.equal(summary.material.bodyText, null);
  assert.equal(summary.material.excerpt, news.content);
  assert.equal(summary.material.bodyStatus, "unconfirmed");
});
test("literature deduplicates normalized DOI without claiming an abstract is full text", () => {
  const row = { title: "Paper", link: "https://journal.example/a", source: "Journal", pub_date: "2026-10-12 00:00:00+00:00", doi: "https://doi.org/10.1234/ABC", abstract: "An abstract" };
  const [a] = normalizeFeed(csv(row), "literature", "a.csv").items;
  const [b] = normalizeFeed(csv({ ...row, link: "https://doi.org/10.1234/abc", doi: "10.1234/abc" }), "literature", "b.csv").items;
  assert.equal(a.material.identityKey, b.material.identityKey);
  assert.equal(a.material.identityKey, "doi:10.1234/abc");
  assert.equal(a.material.bodyText, null);
  assert.equal(a.material.excerpt, "An abstract");
  assert.equal(a.quality, "abstract");
});
test("WeChat accounts remain separate and exported text remains unverified", () => {
  const row = { title: "新闻", url: "https://mp.weixin.qq.com/s?__biz=AAA&mid=1&idx=1&sn=abc", account_name: "公众号 A", publish_time: "2026-10-12T10:00:00+08:00", clean_text: "已有文本" };
  const [a] = normalizeFeed(csv(row), "wechat", "a.csv").items;
  const [b] = normalizeFeed(csv({ ...row, account_name: "公众号 B", url: row.url.replace("AAA", "BBB") }), "wechat", "b.csv").items;
  assert.notEqual(a.source.id, b.source.id);
  assert.equal(a.material.bodyText, null);
  assert.equal(a.material.excerpt, row.clean_text);
});
test("bad URLs are rejected and missing dates are not replaced with collection dates", () => {
  assert.equal(normalizeFeed(csv({ ...news, url: "javascript:alert(1)" }), "news", "x.csv").rejected, 1);
  const [a] = normalizeFeed(csv({ ...news, published_at: "", crawled_at: "2026-10-13" }), "news", "x.csv").items;
  assert.equal(a.material.publishedAt, null);
  assert.throws(() => normalizeFeed("title,url\nx,https://example.com", "news", "x.csv"), /schema changed/);
});
test("lookback uses Beijing calendar dates across UTC midnight", () => {
  assert.deepEqual(recentDays(new Date("2026-10-12T17:00:00Z")), ["2026-10-13", "2026-10-12", "2026-10-11"]);
});
