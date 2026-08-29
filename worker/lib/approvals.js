/* DeFiScoring – ERC-20 approval log scanner
 *
 * Feeds the `approval_change` alert evaluator. Scans Approval events granted
 * BY the wallet (topic1 = owner) over a block range, so the cron can ask
 * "what did this wallet approve since the last tick?" for one getLogs call
 * per chain instead of enumerating allowances token by token.
 *
 * Deliberately event-based rather than state-based: we report approvals
 * *granted in the range*, not the wallet's full standing allowance set.
 * The evaluator diffs against its previous snapshot, so re-delivered ranges
 * de-duplicate, and the cron's block cursor (see fetchNewApprovals) makes
 * the normal case "new events only".
 */

import { etherscanCall } from './providers.js';

// keccak256("Approval(address,address,uint256)")
export const APPROVAL_TOPIC =
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

// Anything at or above 2^255 is treated as an unlimited allowance. Wallets
// sign these as "max uint256", but some UIs shave a few low bits, so an
// exact-max check would miss real unlimited grants.
const UNLIMITED_FLOOR = 1n << 255n;

/**
 * Scan one chain for ERC-20 approvals granted by `wallet` in [fromBlock, toBlock].
 *
 * Returns { ok, approvals } — ok:false means the scan itself failed (the
 * caller should keep its cursor and retry), while ok:true with an empty list
 * is a real "nothing new". The two must not be conflated: treating a failed
 * scan as "no new approvals" would silently advance past events.
 */
export async function scanApprovalLogs(chain, env, wallet, fromBlock, toBlock) {
  const topic1 = '0x' + '0'.repeat(24) + wallet.toLowerCase().slice(2);
  try {
    const r = await etherscanCall(chain, env, {
      module: 'logs', action: 'getLogs',
      fromBlock, toBlock,
      topic0: APPROVAL_TOPIC, topic1, topic0_1_opr: 'and',
    });
    if (!Array.isArray(r)) return { ok: false, approvals: [] };
    const out = [];
    for (const log of r) {
      const topics = log.topics || [];
      // ERC-721 Approval shares the signature but indexes the tokenId as a
      // fourth topic; ERC-20 has exactly three topics with the amount in data.
      if (topics.length !== 3) continue;
      if (String(topics[0] || '').toLowerCase() !== APPROVAL_TOPIC) continue;
      let amount = 0n;
      try { amount = BigInt(log.data || '0x0'); } catch { continue; }
      // A zero-amount Approval is a revocation — good news, not an alert.
      if (amount === 0n) continue;
      const unlimited = amount >= UNLIMITED_FLOOR;
      out.push({
        chain: chain.id,
        token: String(log.address || '').toLowerCase(),
        spender: ('0x' + String(topics[2] || '').slice(-40)).toLowerCase(),
        unlimited,
        // The evaluator surfaces high+medium by default and drops 'low';
        // any non-zero grant to a spender is at least worth mentioning.
        risk: unlimited ? 'high' : 'medium',
        blockNumber: Number(log.blockNumber) || null,
      });
    }
    return { ok: true, approvals: out };
  } catch (e) {
    return { ok: false, approvals: [], error: String((e && e.message) || e) };
  }
}
