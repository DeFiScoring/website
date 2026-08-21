/* DeFiScoring – Scheduled wallet re-scoring
 *
 * Runs on its own cron (every 15 minutes), separate from the 5-minute alert
 * scan on purpose: a full multi-chain score costs ~30-45 subrequests, which
 * is most of a Workers invocation's budget — sharing a tick with alert
 * evaluation and deliveries would starve one or the other. A dedicated
 * invocation re-scores exactly ONE wallet per run with the whole budget.
 *
 * Why it exists: scores were only ever computed when a user pressed scan.
 * For anyone else, the trend chart never gained points and score_change
 * rules could not fire — the cron compared the last manual scan to itself
 * forever. This closes that loop for wallets that have active alert rules:
 * up to 96 wallets/day refresh at the 15-minute cadence, stalest first,
 * degrading gracefully (staleness grows, nothing breaks) beyond that.
 *
 * The rescore goes through handleWalletScore itself — same compute, same
 * honest-score gate, same persistence (which already refuses to write
 * unscored results) — so a scheduled scan can never diverge from what the
 * user would have seen pressing the button.
 */

import { handleWalletScore } from "./wallet-score.js";

const DEFAULT_MIN_AGE_HOURS = 20; // just under daily, so a 24h cadence never skips

export async function runScheduledRescore(env, ctx) {
  if (!env.HEALTH_DB) return { ok: false, error: "db_unavailable" };

  const minAgeMs = (Number(env.RESCORE_MIN_AGE_HOURS) || DEFAULT_MIN_AGE_HOURS) * 3600 * 1000;

  // Stalest wallet with at least one active rule. SQLite sorts NULL first on
  // ASC, so never-scored wallets win, then the oldest scan.
  const row = await env.HEALTH_DB.prepare(
    `SELECT r.wallet_address AS wallet,
            (SELECT MAX(h.computed_at) FROM health_scores h
              WHERE h.wallet = r.wallet_address) AS last_scored_at
     FROM alert_rules r
     WHERE r.is_active = 1
     GROUP BY r.wallet_address
     ORDER BY last_scored_at ASC
     LIMIT 1`
  ).first();

  if (!row) return { ok: true, skipped: "no_watched_wallets" };
  if (row.last_scored_at != null && Date.now() - row.last_scored_at < minAgeMs) {
    return { ok: true, skipped: "all_fresh", wallet: row.wallet };
  }

  // Same path as a user-initiated scan: compute, honest-score gate, persist.
  try {
    const res = await handleWalletScore(
      new Request(`https://internal/api/wallet-score?wallet=${row.wallet}`), env,
    );
    const body = await res.json();
    if (!body.success) {
      console.warn(`[rescore] ${row.wallet} failed:`, body.error);
      return { ok: false, wallet: row.wallet, error: body.error };
    }
    return {
      ok: true, wallet: row.wallet,
      scored: body.scored !== false,
      score: body.score ?? null,
    };
  } catch (e) {
    console.warn(`[rescore] ${row.wallet} threw:`, e.message);
    return { ok: false, wallet: row.wallet, error: String(e.message || e) };
  }
}
