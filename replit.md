# DeFi Scoring (on Snowlake Jekyll base)

## Overview

DeFi Scoring (defiscoring.com) is a Jekyll-based static site providing on-chain credit scoring (300–850), portfolio risk heatmaps, real-time alerts, and an AI-powered risk profiler. The project aims to offer comprehensive DeFi risk assessment. Initial support covers Ethereum, Arbitrum, and Polygon. The project leverages a Jekyll static site for the frontend and Cloudflare Workers for the backend infrastructure.

## User Preferences

I prefer iterative development, focusing on delivering core features and refining them. When making changes, prioritize security and privacy, especially regarding user data and wallet information. I value clear and concise explanations for any complex technical decisions or architectural patterns. Before implementing major architectural changes or integrating new third-party services, please ask for confirmation.

## System Architecture

The project uses Jekyll 4.3.x for static site generation, with a frontend built using Vanilla JS, Chart.js v4, and Bootstrap 5 (selectively). UI/UX maintains a dark aesthetic with a specific palette (`#0a0a0a` background, cyan `#00f5ff`, purple `#a855f7`, gold `#facc15`) for a consistent glass + neon look across dashboards and components.

**Key Technical Implementations:**

-   **Wallet Integration:** EIP-6963 multi-wallet discovery with a custom vanilla JS modal (`wallet-modal.js`) for a lightweight, dependency-free solution.
-   **Data Persistence:** Cloudflare D1 (`HEALTH_DB`) for `health_scores` and `watchlists`, with `localStorage` providing a graceful offline fallback.
-   **Authentication:** Address-keyed identity (wallet = identity) for MVP, with plans for SIWE (Sign-In-With-Ethereum) for production.
-   **Backend:** Primarily Cloudflare Workers for APIs, with future plans to utilize Workers AI (LLM), KV (cache), and R2 (assets). A single unified worker handles all API routes.
-   **Market Intelligence Hub:** Anonymized, opt-in telemetry for an admin dashboard. Wallet addresses are SHA256-hashed and re-keyed with HMAC-SHA256 using `INTEL_SALT` for privacy.

**Core Features:**

-   **Dashboard:** Provides an overview of scores, portfolio value, positions, alerts, and 12-month trends.
-   **My Score:** Detailed breakdown of the user's credit score.
-   **Portfolio Heatmap:** Visual representation of portfolio risk.
-   **Risk Profiler:** Allows users to set target profiles and receive AI-powered recommendations.
-   **Alerts:** Rule builder for custom alerts and a view of recent triggers.

## External Dependencies

-   **Static Site Generator:** Jekyll (Ruby Gems: `jekyll`, `jekyll-feed`, `jekyll-paginate-v2`, `jekyll-archives`, `kramdown-parser-gfm`, `rouge`, `webrick`).
-   **Frontend Libraries:** Chart.js v4 (CDN), Bootstrap 5.
-   **Data Sources/APIs:**
    -   CoinGecko Pro/free API (for price data).
    -   Alchemy (Tier-1 provider for on-chain data).
    -   Moralis (Tier-2 fallback for on-chain data).
    -   Etherscan v2 (Multichain fallback for on-chain data).
-   **Cloudflare Services:**
    -   Cloudflare D1 (database).
    -   Cloudflare Workers (backend API).
    -   Cloudflare Pages (static site hosting).
    -   Cloudflare KV (cache, planned).
    -   Cloudflare R2 (assets, planned).
    -   Cloudflare Workers AI (LLM, planned).
-   **Development/Deployment Tools:**
    -   Bundler (Ruby package manager).
    -   npm (Node.js package manager).
    -   Wrangler (Cloudflare Workers CLI).
-   **GitHub:** Used for issue reporting via `GITHUB_TOKEN`.

## Worker Module Layout (T1+T2+T3 — May 2026)

The monolithic `worker/index.js` was kept intact for backward compat, but new
work goes into a modular layout under `worker/lib/` and `worker/handlers/`:

-   `worker/lib/chains.js` — single-source-of-truth registry for the 11 EVM
    chains (ethereum, optimism, arbitrum, base, polygon, bnb, avalanche,
    gnosis, linea, scroll, zksync). Adding a chain here flows through every
    other module with no further edits.
-   `worker/lib/cache.js` — KV wrapper (reuses `DEFI_CACHE` binding) with
    in-memory fallback so modules work in `wrangler dev` without extra config.
-   `worker/lib/prices.js` — CoinGecko Pro/free with batched native-price
    calls (one HTTP per portfolio scan, not 11) and SHA-256-truncated cache
    keys.
-   `worker/lib/providers.js` — unified `getNativeBalance`,
    `getErc20Balances`, `getFirstTxTimestamp`, `getTransactionCount` with a
    3-tier fallback: Alchemy → Moralis → Etherscan v2 multichain. Caps at
    100 ERC-20s/chain (Alchemy/Moralis) or 50 candidates/chain (Etherscan
    tokentx) to bound CPU on dust-airdropped wallets.
-   `worker/handlers/portfolio.js` — `GET /api/portfolio?wallet=&fiat=
    &chains=&tier=`. Parallel per-chain scan; per-chain failures isolated
    (returned as `{ error }` on the chain row, never bubble out as a 500).
    Returns BOTH a new shape (`address`, `fiat`, `portfolioFiat`,
    `activeChains`, `chains[]`) AND the legacy shape (`wallet`,
    `total_value_usd`, `positions[]`) so the existing `dashboard.js` keeps
    working unchanged. Fixes the long-standing $0-portfolio bug.
-   Route is rate-limited at 30 req/min/IP + 10 req/min/address (using the
    existing `rateLimit()` and `rateLimitByAddress()` helpers in `index.js`).

Optional Cloudflare Worker secrets that upgrade `/api/portfolio` when set
(falls back to Etherscan v2 + free CoinGecko if absent):
`ALCHEMY_KEY`, `MORALIS_KEY`, `COINGECKO_KEY`. Set with
`wrangler secret put <NAME>`.

## Worker Module Layout (T4 — May 2026)

T4 added DeFi position reading and NFT collection reading in the same modular
pattern. Both endpoints share the provider layer with T3 and isolate per-chain
failures (one chain timing out never produces a 500).

-   `worker/lib/defi-protocols.js` — per-chain registry of Aave V3 Pool
    addresses, Compound V3 (Comet) market addresses, the Uniswap V3
    NonfungiblePositionManager, and yield-bearing ERC-20s
    (stETH/wstETH/rETH/sfrxETH/cbETH/swETH/mETH/sDAI). Adding a protocol or
    chain only requires editing this file.
-   `worker/lib/defi.js` — readers for Aave V3 (`getUserAccountData` decodes
    collateral, debt, healthFactor in 8-decimal base units), Compound V3
    (`balanceOf` + `borrowBalanceOf` on each market), and Uni V3 LP NFT count
    (`balanceOf` on the position manager). Plus `classifyYieldTokens()` which
    re-tags ERC-20s already returned by the portfolio scan as DeFi positions
    (no extra RPC calls).
-   `worker/lib/nft.js` — collection fetcher with 3-tier fallback: Alchemy
    (`getContractsForOwner`) → Moralis (`/nft/collections`) → Reservoir
    (keyless `/users/.../collections/v3`, supports 9 EVM chains). Capped at
    50 collections/chain, cached 5 min.
-   `worker/lib/providers.js` — extended with `ethCall(chain, env, to, data)`
    (Alchemy → Etherscan v2 fallback) plus ABI helpers `abiPadAddr`,
    `abiHexWord`, `abiEncodeSingleAddr`.
-   `worker/handlers/defi.js` — `GET /api/defi?wallet=&chains=&fiat=&tier=`.
    Aggregates totalCollateralUsd, totalDebtUsd, totalNetUsd, and
    healthSummary (lowest HF + risk band: liquidatable/risky/caution/safe).
-   `worker/handlers/nfts.js` — `GET /api/nfts?wallet=&chains=&tier=`.
    Aggregates totalCollections, totalNfts, totalFloorEth.
-   Both routes wired in `worker/index.js` with the same rate-limiter
    posture as `/api/portfolio` (30 req/min/IP + 10 req/min/address).

Optional secrets that upgrade T4 endpoints when set (none required):
`ALCHEMY_KEY` (faster eth_call + best NFT metadata), `MORALIS_KEY`
(NFT fallback), `RESERVOIR_KEY` (higher rate limit on NFT free tier).