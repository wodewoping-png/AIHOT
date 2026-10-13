import type { ServerModule } from "@aihot/backend/modules";
import { readRemoteFeeds } from "./collect.ts";
import { importItems } from "./import.ts";
import { FEEDS } from "./config.ts";

export function importMode(): "isolated" | "editorial" {
  const mode = process.env.REPO_FEEDS_MODE || "isolated";
  if (mode !== "isolated" && mode !== "editorial") throw new Error("REPO_FEEDS_MODE must be isolated or editorial");
  return mode;
}

export const REPO_FEEDS: ServerModule = {
  name: "repo-feeds",
  schedules: [{
    name: "repo-feeds.collect", cron: "17 * * * *",
    when: () => process.env.COLLECT_ENABLED === "true" && process.env.REPO_FEEDS_ENABLED === "true",
    run: async () => {
      const mode = importMode();
      const batch = await readRemoteFeeds();
      const imported = await importItems(batch.items, mode);
      // Missing today's file can mean a late upload. No available file for an entire feed is a failure.
      const unavailable = FEEDS.filter(f => !batch.files.some(x => x.repository === f.repo && x.status === "ok"));
      const errors = batch.files.filter(f => f.status === "error");
      if (unavailable.length || errors.length) throw new Error(JSON.stringify({ imported, files: batch.files, unavailable: unavailable.map(f => f.key) }));
      return { imported, files: batch.files };
    },
  }],
};
