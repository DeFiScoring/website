/* DeFiScoring – Telegram delivery via Bot API
 *
 * Required secret (set via Replit Secrets):
 *   TELEGRAM_BOT_TOKEN  — the token from BotFather, format "123456789:ABC..."
 *
 * Users opt in by starting a DM with the bot, then posting the
 * /start <verification_token> command. The /api/alerts/channels endpoint
 * issues the verification token; an inbound webhook (separate, T6 follow-up)
 * matches the start command to the channel and flips is_verified=1.
 *
 * For T6 we ship send() + a helper to build the bot's deep link. The
 * verification webhook can be added in a small follow-up without changing
 * this file.
 */

const API_BASE = (token) => `https://api.telegram.org/bot${token}`;

export function isConfigured(env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

/**
 * send({ chatId, text, parseMode? }) — returns { ok, error?, message_id? }
 *
 * `text` should be already-escaped per the chosen parse mode. The default
 * parse mode is HTML because it's easier to escape correctly than MarkdownV2.
 */
export async function send(env, { chatId, text, parseMode = "HTML" }) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: "telegram_not_configured" };
  if (!chatId || !text) return { ok: false, error: "missing_chat_id_or_text" };

  const res = await fetch(`${API_BASE(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: `telegram_send_failed: ${res.status} ${t.slice(0, 200)}` };
  }
  const data = await res.json();
  if (!data.ok) return { ok: false, error: `telegram_api_error: ${data.description || "unknown"}` };
  return { ok: true, message_id: data.result.message_id };
}

/**
 * Get bot info for verifying the token at startup and for building a deep
 * link the user can click to open a DM with the bot.
 */
export async function getMe(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const res = await fetch(`${API_BASE(env.TELEGRAM_BOT_TOKEN)}/getMe`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.ok ? data.result : null;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
