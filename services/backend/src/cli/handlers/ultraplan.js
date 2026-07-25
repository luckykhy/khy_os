/**
 * Ultraplan CLI Handler — deep planning with extended AI sessions.
 *
 * Usage:
 *   ultraplan <prompt>   — Start a 30-minute deep planning session
 *   ultraplan status     — Show active/completed sessions
 *   ultraplan list       — List all sessions
 */
'use strict';

let _chalk;
function chalk() {
  if (_chalk) return _chalk;
  const m = require('chalk');
  _chalk = m.default || m;
  return _chalk;
}

/**
 * Handle /ultraplan <prompt> command.
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<boolean>}
 */
async function handleUltraplanCommand(args, options) {
  const c = chalk();

  // Feature gate
  try {
    const { isEnabled } = require('../../services/featureFlags');
    if (!isEnabled('ultraplan')) {
      console.log(c.gray('Ultraplan feature is disabled. Set KHY_FEATURE_ULTRAPLAN=true to enable.'));
      return true;
    }
  } catch { /* no feature flags */ }

  const prompt = args.join(' ').trim();
  if (!prompt) {
    console.log(c.yellow('\n  Usage: ultraplan <your planning request>'));
    console.log(c.gray('  Example: ultraplan Design a microservices architecture for user auth\n'));
    return true;
  }

  const { startSession } = require('../../services/ultraplanService');

  console.log(c.cyan('\n  Starting deep planning session...'));
  console.log(c.gray(`  Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`));
  console.log(c.gray('  Timeout: 30 minutes\n'));

  const session = await startSession(prompt);

  console.log(c.green(`  Session ${c.bold(session.id)} created.`));
  console.log(c.gray('  Planning is running in background.'));
  console.log(c.gray(`  Check status: ${c.cyan('ultraplan status')}\n`));

  // Poll for completion with simple spinner
  let dots = 0;
  const poll = setInterval(() => {
    const { getSession } = require('../../services/ultraplanService');
    const current = getSession(session.id);
    if (!current || current.status === 'completed' || current.status === 'failed') {
      clearInterval(poll);
      _showResult(current, c);
    } else {
      dots = (dots + 1) % 4;
      process.stdout.write(`\r  ${c.cyan('Planning' + '.'.repeat(dots).padEnd(3))}  `);
    }
  }, 2000);

  // Wait for completion (with timeout)
  await new Promise((resolve) => {
    const check = setInterval(() => {
      const { getSession } = require('../../services/ultraplanService');
      const current = getSession(session.id);
      if (!current || current.status !== 'running') {
        clearInterval(check);
        clearInterval(poll);
        resolve();
      }
    }, 1000);
    // Hard timeout
    setTimeout(() => { clearInterval(check); clearInterval(poll); resolve(); }, 31 * 60 * 1000);
  });

  return true;
}

function _showResult(session, c) {
  if (!session) {
    console.log(c.red('\n  Session not found.\n'));
    return;
  }

  console.log('\n');

  if (session.status === 'failed') {
    console.log(c.red(`  Planning failed: ${session.error}\n`));
    return;
  }

  if (session.result) {
    const r = session.result;
    // 会话时长走 ccFormatDuration SSOT(门控 KHY_CC_FORMAT):多分钟/小时会话
    // 显 "5m 0s"/"1h 0m 0s" 而非裸 "300s"/"3600s"。门控关 → 逐字节回退旧 `${toFixed(0)}s`。
    const _durMs = (session.completedAt - session.startedAt);
    const _durLegacy = `${(_durMs / 1000).toFixed(0)}s`;
    const elapsed = require('../ccFormat').ccFormatDurationOr(_durMs, _durLegacy, process.env);

    console.log(c.bold.cyan('  === ULTRAPLAN RESULT ==='));
    console.log(c.gray(`  Session: ${session.id} | Duration: ${elapsed}`));
    console.log(c.gray('  ' + '\u2500'.repeat(50)));

    if (r.title) console.log(c.bold(`\n  ${r.title}`));
    if (r.analysis) console.log(c.white(`\n  Analysis:\n  ${r.analysis.slice(0, 500)}`));
    if (r.steps) console.log(c.green(`\n  Steps:\n  ${r.steps.slice(0, 1000)}`));
    if (r.risks) console.log(c.yellow(`\n  Risks:\n  ${r.risks.slice(0, 300)}`));
    if (r.testing) console.log(c.cyan(`\n  Testing:\n  ${r.testing.slice(0, 300)}`));

    console.log(c.gray('\n  ' + '\u2500'.repeat(50)));
    console.log(c.gray(`  Full plan saved to: ~/.khyquant/ultraplans/${session.id}.json\n`));
  }
}

/**
 * Handle ultraplan status / list command.
 * @returns {Promise<boolean>}
 */
async function handleUltraplanStatus() {
  const c = chalk();
  const { listSessions } = require('../../services/ultraplanService');

  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log(c.gray('\n  No planning sessions found.\n'));
    return true;
  }

  console.log(c.bold('\n  Ultraplan Sessions'));
  console.log(c.gray('  ' + '\u2500'.repeat(60)));

  const _ccFmt = require('../ccFormat');
  for (const s of sessions.slice(0, 10)) {
    const statusColor = s.status === 'completed' ? c.green : s.status === 'running' ? c.cyan : c.red;
    // 时长走 ccFormatDuration SSOT;运行中的 `...` 尾缀在 *Or 外拼接(门控关逐字节回退)。
    const elapsed = s.completedAt
      ? _ccFmt.ccFormatDurationOr(s.completedAt - s.startedAt, `${((s.completedAt - s.startedAt) / 1000).toFixed(0)}s`, process.env)
      : _ccFmt.ccFormatDurationOr(Date.now() - s.startedAt, `${((Date.now() - s.startedAt) / 1000).toFixed(0)}s`, process.env) + '...';

    console.log(`  ${c.gray(s.id)} ${statusColor(s.status.padEnd(10))} ${c.gray(elapsed)} ${s.prompt.slice(0, 40)}`);
  }
  console.log('');
  return true;
}

module.exports = { handleUltraplanCommand, handleUltraplanStatus };
