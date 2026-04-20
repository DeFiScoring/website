---
layout: default
title: Privacy Policy
permalink: /privacy/
description: "How DeFi Scoring handles wallet addresses, server logs, and third-party API data."
---

<style>
  .legal-page { max-width: 820px; margin: 0 auto; }
  .legal-page h1 { font-size: clamp(28px, 3.4vw, 40px); margin: 0 0 8px; }
  .legal-page .legal-meta { color: #6f7aa0; font-size: 13px; margin-bottom: 32px; }
  .legal-page h2 { margin-top: 36px; font-size: 20px; }
  .legal-page p, .legal-page li { color: #c8d2f5; font-size: 15px; line-height: 1.7; }
  .legal-page ul { padding-left: 22px; }
  .legal-page strong { color: #fff; }
  .legal-page a { color: #5b8cff; }
</style>

<div class="legal-page" markdown="1">

# Privacy Policy

<div class="legal-meta">Effective Date: April 20, 2026</div>

At DeFi Scoring we prioritise the privacy of our users. This Privacy Policy outlines the types of information we collect, how we use it, and the steps we take to ensure your data is handled responsibly in the decentralised ecosystem.

## 1. Information We Collect

We aim to collect the minimum amount of data necessary to provide our services.

- **Public blockchain data.** When you use our “Connect Wallet” or “Health Score” features, we process your public wallet address (e.g. `0x…`). This data is already public on the blockchain — we do not “own” it.
- **Usage data.** We use **Cloudflare** to optimise performance and security. Cloudflare may automatically collect metadata such as your IP address, browser type, and time spent on pages to prevent DDoS attacks and improve site speed.
- **Direct communication.** If you contact us via email or GitHub, we collect your email address and the content of your message to respond to your inquiry.

## 2. How We Use Your Information

We use the collected information to:

- Provide and maintain our DeFi scoring metrics.
- Analyse user trends to improve our scoring algorithms.
- Protect our website from malicious activity and bot traffic.
- Comply with legal obligations where applicable.

## 3. Web3 and Blockchain Transparency

Please be aware that **blockchain transactions are public by nature**.

- When you connect a wallet to DeFiScoring.com, you are sharing a public identifier that is visible to everyone on the network.
- We do not have the power to edit or delete information that is recorded on the blockchain (such as your transaction history or token holdings).

## 4. Cookies and Tracking Technologies

We use a privacy-first approach to tracking.

- **Functional cookies** — essential cookies provided by Cloudflare to ensure the security and stability of the site.
- **No marketing trackers** — we do not use third-party marketing cookies (such as Facebook Pixel or Google AdSense) to track your behaviour across other websites.

## 5. Third-Party Service Providers

We rely on trusted third-party providers to power our data:

- **Infrastructure:** Cloudflare (Workers, KV, D1, Pages, Web3 gateways).
- **Data APIs:** Etherscan, DeFiLlama, The Graph, CoinGecko.
- **AI inference:** Cloudflare Workers AI for the on-platform Risk Profiler and AI Auditor. We send the contract source or wallet snapshot relevant to the request — we do not transmit personal identity data.

These services have their own privacy policies and we encourage you to review them.

## 6. Data Retention

- **Wallet addresses.** We may cache your wallet's “Health Score” in our Cloudflare D1 database to improve load times. This data is stored for as long as it is relevant to the service.
- **Server logs.** Cloudflare logs are typically deleted or anonymised within 30 days.
- **Risk Profiler transcripts.** Stored in Cloudflare KV with a 1-hour expiry; the user-provided email address is retained until you request deletion.

## 7. Your Rights (GDPR / CCPA)

Depending on your location, you may have the following rights:

- **Access & portability** — you can request a copy of the data we hold about you (usually just your cached score).
- **Deletion** — you can request that we delete your cached data from our private databases. Note: **we cannot delete data from the blockchain.**
- **Opt-out** — you can stop using the service and disconnect your wallet at any time.

## 8. Security

We implement industry-standard security measures provided by Cloudflare to protect your data. However, no method of transmission over the internet or electronic storage is 100% secure, and we cannot guarantee absolute security.

## 9. Changes to This Policy

We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the “Effective Date.”

## 10. Contact Us

For any privacy-related questions, please reach out:

- **Email:** admin@defiscoring.com
- **GitHub:** [DeFiScoring/website](https://github.com/DeFiScoring/website)

We do not sell user data. Period.

</div>

{% include site-footer.html %}
