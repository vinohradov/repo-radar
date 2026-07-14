import { NightlyConfig } from "@repo-radar/shared";
import { settingsRepo } from "./db/repositories.js";
import { runNightlyBatch } from "./pipeline/batch.js";

export function nightlyConfig(): NightlyConfig {
  const raw = settingsRepo.get("nightly");
  if (raw) {
    try {
      return NightlyConfig.parse(JSON.parse(raw));
    } catch {
      /* fall through */
    }
  }
  return { enabled: false, hourUtc: 3 };
}

/**
 * Minute tick: when nightly scans are enabled and the configured UTC hour
 * arrives, kick off one Batch-API run per day.
 */
export function startScheduler(log: (msg: string) => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    const cfg = nightlyConfig();
    if (!cfg.enabled) return;
    const nowUtc = new Date();
    if (nowUtc.getUTCHours() !== cfg.hourUtc) return;
    const today = nowUtc.toISOString().slice(0, 10);
    if (settingsRepo.get("nightlyLastRunDay") === today) return;
    settingsRepo.set("nightlyLastRunDay", today);
    log(`Nightly batch starting (scheduled, ${cfg.hourUtc}:00 UTC)`);
    void runNightlyBatch().then((summary) => log(summary));
  }, 60_000);
  timer.unref();
  return timer;
}
