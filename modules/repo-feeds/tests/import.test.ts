import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { importItems } from "../import.ts";
import { normalizeFeed } from "../normalize.ts";
import { tag } from "../../../tests/setup.ts";

after(async () => { await stopBoss(); await closeDb(); });
test("repeat imports are idempotent, revised evidence updates, paused and manual settings survive", async () => {
  const id = tag();
  const text = `title,url,source_name,published_at,content,content_status\nNews,https://example.org/${id},Feed ${id},2026-10-12,original text,full`;
  const batch = normalizeFeed(text, "news", "test.csv").items;
  const first = await importItems(batch);
  assert.equal(first.created, 1);
  const second = await importItems(batch);
  assert.equal(second.created, 0); assert.equal(second.unchanged, 1);
  const revised = normalizeFeed(text.replace("original text", "corrected text"), "news", "test.csv").items;
  assert.equal((await importItems(revised)).revised, 1);
  const [article] = await sql`SELECT body_text, revision FROM articles WHERE source_id = ${batch[0].source.id}`;
  assert.equal(article.body_text, "corrected text"); assert.equal(article.revision, 2);
  await sql`UPDATE sources SET enabled = false, tier = 'T1' WHERE id = ${batch[0].source.id}`;
  assert.equal((await importItems(revised, "editorial")).paused, 1);
  const [source] = await sql`SELECT tier, participation_mode, site_fulltext FROM sources WHERE id = ${batch[0].source.id}`;
  assert.equal(source.tier, "T1"); assert.equal(source.participation_mode, "isolated"); assert.equal(source.site_fulltext, false);
});

test("a new editorial feed enters the normal analysis queue with body evidence", async () => {
  const id = tag();
  const batch = normalizeFeed(`title,url,source_name,published_at,content,content_status\nNews,https://example.org/${id},Feed ${id},2026-10-12,evidence,full`, "news", "test.csv").items;
  assert.equal((await importItems(batch, "editorial")).created, 1);
  const [row] = await sql`SELECT a.id, a.body_text, a.processing_queued_at, s.site_fulltext FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.source_id = ${batch[0].source.id}`;
  assert.equal(row.body_text, "evidence"); assert.ok(row.processing_queued_at); assert.equal(row.site_fulltext, false);
  const [job] = await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'content.analyze' AND data->>'articleId' = ${row.id}`;
  assert.equal(job.n, 1);
});

test("cross-feed URL duplicates preserve both discoveries and DOI duplicates create one paper", async () => {
  const id = tag();
  const news = normalizeFeed(`title,url,source_name,published_at,content,content_status\nNews,https://example.org/${id}?utm_source=a,News ${id},2026-10-12,evidence,full`, "news", "n.csv").items;
  const wechat = normalizeFeed(`title,url,account_name,publish_time,clean_text\nNews,http://www.example.org/${id},Account ${id},2026-10-12,other evidence`, "wechat", "w.csv").items;
  assert.equal((await importItems([...news, ...wechat])).created, 1);
  const [discoveries] = await sql`SELECT count(*)::int AS n FROM article_discoveries WHERE article_id = (SELECT id FROM articles WHERE source_id = ${news[0].source.id})`;
  assert.equal(discoveries.n, 2);
  const paper = `title,link,source,pub_date,doi,abstract\nPaper,https://journal.example/${id},Journal ${id},2026-10-12,10.1234/${id},abstract only`;
  const one = normalizeFeed(paper, "literature", "one.csv").items;
  const two = normalizeFeed(paper.replace(`https://journal.example/${id}`, `https://doi.org/10.1234/${id}`), "literature", "two.csv").items;
  assert.equal((await importItems([...one, ...two])).created, 1);
  const [stored] = await sql`SELECT body_text, excerpt FROM articles WHERE source_id = ${one[0].source.id}`;
  assert.equal(stored.body_text, null); assert.equal(stored.excerpt, "abstract only");
});
