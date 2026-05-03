#!/usr/bin/env bash
# setup-worker-secrets.sh
# ---------------------------------------------------------------
# Pushes every required secret to the Cloudflare Worker for the
# defiscoring.com project. See SECRETS.md for the full registry.
#
# USAGE
#   # Production (default — uses the top-level "name" in wrangler.jsonc):
#   ./scripts/setup-worker-secrets.sh prod
#
#   # Staging (requires a wrangler.jsonc env block named "staging"):
#   ./scripts/setup-worker-secrets.sh staging
#
#   # List what's already set (no values shown):
#   ./scripts/setup-worker-secrets.sh list
#
# Each `wrangler secret put NAME` call prompts you to paste the value
# (it is read from stdin and never echoed). Values flow only to
# Cloudflare's encrypted secret store; nothing is logged or committed.
# ---------------------------------------------------------------

set -euo pipefail

MODE="${1:-prod}"

ENV_FLAG=""
if [ "$MODE" = "staging" ]; then
  ENV_FLAG="--env staging"
elif [ "$MODE" = "prod" ] || [ "$MODE" = "production" ]; then
  ENV_FLAG=""
elif [ "$MODE" = "list" ]; then
  npx wrangler secret list
  exit 0
else
  echo "Usage: $0 [prod|staging|list]" >&2
  exit 1
fi

# ---- Required for ANY deployment (the Worker 503s without these) ----
REQUIRED_SECRETS=(
  SESSION_HMAC_KEY            # HMAC for ds_session cookie
  IP_HASH_PEPPER              # HMAC pepper for rate-limit keys
  INTEL_SALT                  # HMAC pepper for /api/intel hashed_wallet
  ADMIN_TOKEN                 # bearer for /api/intel/* and retention
  ETHERSCAN_API_KEY           # native balances + tx history
)

# ---- Required for billing (/api/billing/*, /api/webhooks/stripe) ----
BILLING_SECRETS=(
  STRIPE_SECRET_KEY           # sk_live_* / sk_test_*
  STRIPE_WEBHOOK_SECRET       # whsec_*
  STRIPE_PUBLISHABLE_KEY      # pk_*  (returned by /api/billing/config)
  STRIPE_PRICE_ID_PRO         # price_*
  STRIPE_PRICE_ID_PLUS        # price_*
)

# ---- Required for /api/report-issue ----
REPORTING_SECRETS=(
  GITHUB_TOKEN                # classic PAT, repo scope
)

# ---- Required for alerts delivery ----
ALERT_SECRETS=(
  GOOGLE_SA_EMAIL             # *@*.iam.gserviceaccount.com
  GOOGLE_SA_PRIVATE_KEY       # PEM PKCS#8, paste literally with newlines
  GMAIL_SENDER                # alerts@defiscoring.com
  TELEGRAM_BOT_TOKEN          # botid:hash
)

# ---- Required for /api/turnstile/verify ----
TURNSTILE_SECRETS=(
  TURNSTILE_SECRET            # server-side
  TURNSTILE_SITE_KEY          # public, but rotated via Worker endpoint
)

# ---- Optional — improves quality but Worker degrades gracefully ----
OPTIONAL_SECRETS=(
  ALCHEMY_KEY                 # Tier 1 token discovery + RPC
  MORALIS_KEY                 # Tier 2 token-balance fallback
  RESERVOIR_KEY               # NFT metadata
  COINGECKO_KEY               # CG Pro tier
  WC_PROJECT_ID               # WalletConnect Cloud
  OFAC_LIST_URL               # OFAC SDN snapshot URL
  ETH_RPC_URL                 # Ethereum RPC fallback
)

put_one() {
  local name="$1"
  echo
  echo "→ $name  (paste value, then Ctrl-D on a new line)"
  npx wrangler secret put "$name" $ENV_FLAG
}

put_group() {
  local label="$1"; shift
  echo
  echo "==================================================="
  echo "  $label"
  echo "==================================================="
  for s in "$@"; do
    put_one "$s"
  done
}

echo "Cloudflare Worker secrets — target: $MODE"
echo "Wrangler will prompt for each value; nothing is logged or committed."
echo
read -rp "Continue? [y/N] " ans
[ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "Aborted."; exit 1; }

put_group "REQUIRED (Worker won't boot without these)" "${REQUIRED_SECRETS[@]}"
put_group "BILLING (Stripe)"                          "${BILLING_SECRETS[@]}"
put_group "REPORTING (GitHub issues)"                 "${REPORTING_SECRETS[@]}"
put_group "ALERTS (Gmail + Telegram)"                 "${ALERT_SECRETS[@]}"
put_group "TURNSTILE (anti-bot)"                      "${TURNSTILE_SECRETS[@]}"
put_group "OPTIONAL (graceful degradation)"           "${OPTIONAL_SECRETS[@]}"

echo
echo "Done. Verify with:  npx wrangler secret list $ENV_FLAG"
