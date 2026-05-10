/* DeFiScoring – Admin: retention prune (manual trigger)
 *
 *   POST /api/admin/retention/run
 *
 * SIWE-gated alternative to the legacy POST /api/account/retention/run
 * (which uses the X-Admin-Token header). Both invoke the same
 * `runRetentionPrune` logic, but this one writes an audit log row.
 */

import { requireAdmin, auditLog } from "../../lib/admin.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleAdminRetentionRun(request, env, runRetentionPrune) {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const summary = await runRetentionPrune(env);

  await auditLog(env, {
    actor: auth.user, action: "retention.run",
    targetType: "retention", targetId: "global",
    before: null,
    after:  { ok: !!summary.ok, deleted: summary.deleted || {}, cutoffMs: summary.cutoffMs || null },
    request,
  });

  return json({ success: !!summary.ok, summary });
}
