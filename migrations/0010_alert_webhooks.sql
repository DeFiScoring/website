-- DeFiScoring – Webhook alert channels
-- ---------------------------------------------------------------------------
-- alert_channels already permits kind='webhook' (see 0007_alerts.sql), but the
-- API rejected it and the cron delivery loop had no branch for it, so a webhook
-- channel could never be created or delivered to. This migration adds the one
-- column the delivery path needs: a per-channel signing secret.
--
-- The secret is minted at channel creation, returned to the caller exactly
-- once, and used to compute the HMAC-SHA256 signature header on every POST so
-- the receiving endpoint can verify the payload really came from us. It has to
-- be stored in plaintext (unlike a password) because we need the original bytes
-- to recompute the MAC on each send — the same constraint Stripe/GitHub webhook
-- secrets have. It is never returned by any read endpoint after creation.
-- ---------------------------------------------------------------------------

ALTER TABLE alert_channels ADD COLUMN secret TEXT;
