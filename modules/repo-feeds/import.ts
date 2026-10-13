import { sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { ensureQueue, QUEUES } from "@aihot/backend/jobs/queue";
import type { FeedItem } from "./normalize.ts";

export async function importItems(items: FeedItem[], mode: "isolated" | "editorial" = "isolated") {
  const stats = { received: items.length, created: 0, revised: 0, unchanged: 0, paused: 0 };
  // Queue declarations live outside the material transaction; the jobs themselves commit with it.
  if (mode === "editorial") await ensureQueue(QUEUES.analyze);
  for (const item of items) {
    const outcome = await sql.begin(async tx => {
      await tx`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, tags,
                                  enabled, site_fulltext, syndicate_fulltext)
        VALUES (${item.source.id}, ${item.source.name}, 'external', '{}'::jsonb, 'T2', ${mode}, 60,
                ${["repo-feeds", `repo:${item.feed}`]}, true, false, false)
        ON CONFLICT (id) DO NOTHING`;
      // Existing source settings, including pauses, tier, mode and full-text permissions, belong to the operator.
      const [source] = await tx<{ enabled: boolean; participation_mode: string }[]>`
        SELECT enabled, participation_mode FROM sources WHERE id = ${item.source.id} FOR UPDATE`;
      if (!source?.enabled) return "paused" as const;
      const result = await upsertMaterial(item.material, tx);
      if (source.participation_mode === "editorial" && (result.created || result.revised || result.processingNeeded)) {
        await queueProcessing(result.articleId, { db: tx });
      }
      await tx`UPDATE sources SET last_fetch_at = now(), last_ok_at = now() WHERE id = ${item.source.id}`;
      return result.created ? "created" as const : result.revised ? "revised" as const : "unchanged" as const;
    });
    stats[outcome]++;
  }
  return stats;
}
