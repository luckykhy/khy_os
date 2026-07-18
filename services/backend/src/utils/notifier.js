/**
 * WeChat Push Notification via ServerChan (Server酱)
 *
 * API: POST https://sctapi.ftqq.com/{sendKey}.send
 * Body: { title, desp }   (desp = Markdown body)
 * Success: response.data.code === 0
 *
 * This module is strictly non-blocking: every public function catches
 * its own errors so callers can fire-and-forget without try-catch.
 */

const axios = require('axios');

const SERVERCHAN_BASE = 'https://sctapi.ftqq.com';

/**
 * Push a trading signal to the user's WeChat via ServerChan.
 *
 * @param {string} sendKey  - User's ServerChan SendKey
 * @param {object} signal   - Signal record (from Signal.create())
 * @returns {Promise<boolean>} true on success, false on failure
 */
async function sendWeChatNotification(sendKey, signal) {
  if (!sendKey) return false;

  const directionMap = { BUY: '买入', SELL: '卖出', HOLD: '持有' };
  const direction = directionMap[signal.signal] || signal.signal;

  const title = `New Trading Signal — ${direction} ${signal.symbol}`;

  const lines = [
    `## ${title}`,
    '',
    '| Item | Value |',
    '| :--- | :---- |',
    `| Symbol | ${signal.symbol} |`,
    `| Direction | **${direction}** (${signal.signal}) |`,
  ];

  if (signal.price != null) {
    lines.push(`| Price | ${signal.price} |`);
  }
  if (signal.confidence != null) {
    lines.push(`| Confidence | ${(signal.confidence * 100).toFixed(1)}% |`);
  }

  lines.push(`| Source | ${signal.source || 'external'} |`);
  lines.push(`| Time | ${new Date().toISOString()} |`);

  const desp = lines.join('\n');

  try {
    const url = `${SERVERCHAN_BASE}/${sendKey}.send`;
    const resp = await axios.post(url, { title, desp }, { timeout: 10000 });

    if (resp.data?.code === 0) {
      console.log(`[Notifier] WeChat push OK: ${title}`);
      return true;
    }

    console.error(`[Notifier] ServerChan returned error:`, resp.data);
    return false;
  } catch (err) {
    console.error(`[Notifier] WeChat push failed for "${title}":`, err.message);
    return false;
  }
}

module.exports = { sendWeChatNotification };
