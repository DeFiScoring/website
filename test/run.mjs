#!/usr/bin/env node
// Runs every worker test suite and exits non-zero if any check fails.
//
// The suites boot the real worker/index.js against a D1 shim backed by
// node:sqlite (test/d1.mjs), running the real migrations/ — so they exercise
// actual SQL, actual routing, and actual signature verification rather than
// mocks of them. Third-party HTTP (Etherscan, CoinGecko, DefiLlama, Snapshot,
// JSON-RPC) is the only thing stubbed.
//
// Requires Node >= 22.5 for node:sqlite.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const SUITES = [
  ["flow",  "SIWE sign-in, sessions, wallet link/unlink/rename"],
  ["flow2", "cookie scope, CSRF guard, signature encodings, EIP-1271, retention"],
  ["score", "portfolio scan, wallet score, price fallbacks, badge"],
  ["dsar",  "wallet-proved account erasure"],
  ["alerts", "webhook delivery signing + SSRF guard, unsupported rule kinds"],
  ["explain", "AI score explanations: prompts from persisted data, caching, failure modes"],
  ["rescore", "scheduled re-scoring: stalest-first selection, freshness gate, score_change loop"],
  ["watchlist", "watched wallets: CRUD, tier caps, isolation, re-score queue membership"],
  ["rwa-provenance", "RWA modules disclose curated-dossier provenance and review dates"],
  ["claims", "public pricing and landing claims match what the code enforces"],
  ["api-keys", "API key issuance, bearer auth, per-tier metering, revocation, isolation"],
  ["sanctions", "OFAC screening: seed floor, KV overlay, feed validation, platform health"],
  ["onchain", "native-balance snapshot endpoint: validation, no RPC proxying, unreadable != empty"],
];

const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error(`These suites need Node >= 22.5 for node:sqlite (running ${process.versions.node}).`);
  process.exit(1);
}

let failed = 0;
for (const [name, desc] of SUITES) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m  ${desc}`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", path.join(here, `${name}.mjs`)], {
      cwd: repoRoot, stdio: "inherit",
    });
    p.on("close", resolve);
  });
  if (code !== 0) failed++;
}

console.log(failed ? `\n\x1b[31m${failed} suite(s) failed\x1b[0m` : "\n\x1b[32mall suites passed\x1b[0m");
process.exit(failed ? 1 : 0);
