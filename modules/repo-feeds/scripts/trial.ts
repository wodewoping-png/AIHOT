// Dry run by default. --apply explicitly imports into DATABASE_URL; no model is called by this tool.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { normalizeFeed, type FeedItem } from "../normalize.ts";
import { FEEDS, recentDays, type FeedKey } from "../config.ts";
import { identityKeyFor, decideTimeline } from "@aihot/backend/content/materials";

const { values } = parseArgs({ options: {
  file: { type: "string", multiple: true }, days: { type: "string", default: "3" },
  out: { type: "string", default: ".data/repo-feeds-trial" },
  apply: { type: "boolean", default: false }, mode: { type: "string", default: "isolated" },
} });
if (!["isolated", "editorial"].includes(values.mode)) throw new Error("--mode must be isolated or editorial");
const count = Number(values.days);
if (!Number.isInteger(count) || count < 1 || count > 14) throw new Error("--days must be 1..14");
const items: FeedItem[] = [];
const files: unknown[] = [];
let failed = false;
if (values.file?.length) {
  for (const entry of values.file) {
    const at = entry.indexOf("="), key = entry.slice(0, at) as FeedKey, file = entry.slice(at + 1);
    if (at < 1 || !FEEDS.some(f => f.key === key)) throw new Error("--file expects news|wechat|literature=/path/to/daily.csv");
    const result = normalizeFeed(await readFile(file, "utf8"), key, path.basename(file));
    items.push(...result.items);
    files.push({ feed: key, file: path.basename(file), rows: result.rows, rejected: result.rejected });
  }
} else {
  const { readRemoteFeeds } = await import("../collect.ts");
  const batch = await readRemoteFeeds(recentDays(new Date(), count));
  items.push(...batch.items); files.push(...batch.files);
  failed = batch.files.some(f => f.status === "error") || FEEDS.some(f => !batch.files.some(x => x.repository === f.repo && x.status === "ok"));
}

const now = new Date();
const seen = new Set<string>();
const records = items.map(item => {
  const key = identityKeyFor(item.material), duplicate = seen.has(key);
  seen.add(key);
  const timeline = decideTimeline(item.material.publishedAt, now);
  return { feed: item.feed, source: item.source.name, sourceId: item.source.id, title: item.material.title,
    url: item.material.url, publishedAt: item.material.publishedAt?.toISOString() ?? null,
    quality: item.quality, chars: (item.material.bodyText ?? item.material.excerpt ?? "").length,
    duplicate, archiveReason: timeline.backfillReason, provenance: item.material.raw,
  };
});
const summary = FEEDS.map(feed => {
  const rows = records.filter(r => r.feed === feed.key);
  return { feed: feed.key, rows: rows.length, sources: new Set(rows.map(r => r.sourceId)).size,
    duplicates: rows.filter(r => r.duplicate).length, full: rows.filter(r => r.quality === "full").length,
    abstract: rows.filter(r => r.quality === "abstract").length,
    unverified: rows.filter(r => r.quality === "unverified").length, empty: rows.filter(r => r.quality === "empty").length,
    unknownDate: rows.filter(r => !r.publishedAt).length, archive: rows.filter(r => r.archiveReason).length };
});
let imported: unknown = null;
if (values.apply) {
  if (failed) throw new Error("A feed could not be read; review the dry run before importing");
  const { importItems } = await import("../import.ts");
  const { stopBoss } = await import("@aihot/backend/jobs/queue");
  const { closeDb } = await import("@aihot/backend/db");
  try { imported = await importItems(items, values.mode as "isolated" | "editorial"); }
  finally { await stopBoss(); await closeDb(); }
}
const report = { generatedAt: now.toISOString(), stage: values.apply ? "database-import" : "normalization-preview",
  aiEvaluated: false, files, rows: records.length, unique: seen.size, summary, imported, records };
await mkdir(values.out, { recursive: true });
await writeFile(path.join(values.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
// Use textContent for every external value. The report never embeds source HTML or full article text.
const embedded = JSON.stringify(report).replace(/</g, "\\u003c");
await writeFile(path.join(values.out, "preview.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>三源接入试验</title>
<style>body{font:15px system-ui;margin:0;background:#101827;color:#e8edf5}main{max-width:1200px;margin:auto;padding:36px}h1{font-size:30px}p{color:#bac8db;line-height:1.8}.stats{display:flex;gap:12px;flex-wrap:wrap}.stat,article{background:#192639;border:1px solid #33435a;border-radius:12px;padding:18px}.stat{flex:1;min-width:210px}.stat b{font-size:26px}input,select{background:#192639;color:white;border:1px solid #52627a;border-radius:6px;padding:12px;margin:20px 10px 20px 0}input{width:45%}article{margin-bottom:12px}article a{color:#9fdaff;text-decoration:none;font-size:17px}small{display:block;color:#adbbce;margin-top:10px}.note{border-left:3px solid #ffca7a;padding-left:14px}</style>
<main><h1>三源接入试验</h1><p class="note">真实 CSV 的字段映射与去重预览。尚未运行 AI 评分、事件归组或日报；此页不代表 AIHOT 正式站点。只列标题、来源与原文链接，文献摘要不冒充全文。</p><p id="totals"></p><div class="stats" id="stats"></div><select id="feed"><option value="">全部来源项目</option><option>news</option><option>wechat</option><option>literature</option></select><input id="q" placeholder="搜索标题、媒体、公众号或期刊"><p id="count"></p><section id="items"></section></main>
<script>const data=${embedded};const el=id=>document.getElementById(id);el('totals').textContent='输入 '+data.rows+' 条 / URL 或 DOI 去重后 '+data.unique+' 条 / 生成于 '+data.generatedAt;
for(const s of data.summary){const d=document.createElement('div');d.className='stat';const title=document.createElement('b');title.textContent=s.rows+' 条';d.append(title);const p=document.createElement('p');p.textContent=s.feed+' · '+s.sources+' 个独立来源 · 全文 '+s.full+' · 摘要 '+s.abstract+' · 未验证文本 '+s.unverified+' · 无文本 '+s.empty;d.append(p);el('stats').append(d)}
function render(){const q=el('q').value.toLowerCase(),f=el('feed').value;const rows=data.records.filter(r=>(!f||r.feed===f)&&(r.title+' '+r.source).toLowerCase().includes(q));el('count').textContent='匹配 '+rows.length+' 条（最多展示前 200 条）';el('items').replaceChildren();for(const r of rows.slice(0,200)){const a=document.createElement('article'),link=document.createElement('a'),m=document.createElement('small');link.textContent=r.title;link.href=r.url;link.target='_blank';link.rel='noopener noreferrer';m.textContent=r.source+' · '+(r.publishedAt||'日期未知')+' · '+r.quality+' · '+r.chars+' 字符'+(r.duplicate?' · 重复':'')+(r.archiveReason?' · 历史/日期待确认':'');a.append(link,m);el('items').append(a)}}el('q').oninput=render;el('feed').onchange=render;render();</script></html>`);
console.log(JSON.stringify({ files, summary, rows: records.length, unique: seen.size, imported, out: values.out }, null, 2));
if (failed) process.exitCode = 1;
