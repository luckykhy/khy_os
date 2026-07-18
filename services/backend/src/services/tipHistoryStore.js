'use strict';

/**
 * tipHistoryStore.js — 启动轮换提示的持久化壳。**非纯叶子**（读写 tips_state.json）。
 * 对齐 CC 的 numStartups + tipsHistory（CC 存于 global config；khy 存于数据家自有小状态文件）：
 *   - numStartups：启动会话计数。本进程只 +1 一次，即便横幅因 /clear 重绘多次调用本函数。
 *   - tipsHistory：{ tipId: 上次显示时的 numStartups }。
 *
 * 选择逻辑委托纯叶子 cli/tipScheduler（SSOT）。fail-soft：任何读写失败降级为不显示提示，
 * 绝不抛、绝不阻断启动。门控 KHY_STARTUP_TIPS 由叶子负责；壳在门控关时短路返回 null。
 */

const STATE_FILE = 'tips_state.json';

// 进程级：确保 numStartups 每进程只自增一次（横幅可能因 /clear 多次重绘）。
let _bumpedThisProcess = false;

function _statePath() {
  try {
    // eslint-disable-next-line global-require
    const { getAppHome } = require('../utils/dataHome');
    // eslint-disable-next-line global-require
    const path = require('path');
    const home = getAppHome();
    if (!home) return '';
    // 注意：**不能**用 getAppDataDir('tips_state.json')——它对**完整路径**调 _ensureDir，
    // 会把文件名当目录创建（EISDIR，同刀58 search_engines.json 教训）。此处取 home 目录
    // 后 join 文件名，保证 tips_state.json 是**文件**而非目录。
    return path.join(home, STATE_FILE);
  } catch {
    return '';
  }
}

function _load(p) {
  try {
    // eslint-disable-next-line global-require
    const fs = require('fs');
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (raw && typeof raw === 'object') {
        const numStartups = Number.isFinite(Number(raw.numStartups)) ? Number(raw.numStartups) : 0;
        const tipsHistory =
          raw.tipsHistory && typeof raw.tipsHistory === 'object' ? raw.tipsHistory : {};
        return { numStartups, tipsHistory };
      }
    }
  } catch {
    /* 读失败 → 保守默认（首次启动语义） */
  }
  return { numStartups: 0, tipsHistory: {} };
}

function _save(p, state) {
  try {
    if (!p) return;
    // eslint-disable-next-line global-require
    const fs = require('fs');
    // eslint-disable-next-line global-require
    const path = require('path');
    const dir = path.dirname(p);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state), 'utf8');
  } catch {
    /* 持久化尽力而为——写失败不影响本次显示 */
  }
}

/**
 * 自增本进程启动计数（仅一次）+ 选一条最久未显示的相关提示，记录其 lastShown 并持久。
 * @param {Object} [env] 缺省 process.env
 * @returns {{id:string, text:string}|null}
 */
function bumpStartupAndSelectTip(env) {
  try {
    // eslint-disable-next-line global-require
    const leaf = require('./tipScheduler');
    const e = env || process.env || {};
    if (!leaf.tipsEnabled(e)) return null;

    const p = _statePath();
    const state = _load(p);

    if (!_bumpedThisProcess) {
      state.numStartups = (Number(state.numStartups) || 0) + 1;
      _bumpedThisProcess = true;
      _save(p, state);
    }

    const tip = leaf.selectStartupTip(
      {
        tips: leaf.TIPS,
        history: state.tipsHistory,
        numStartups: state.numStartups,
        ctx: { numStartups: state.numStartups },
      },
      e,
    );
    if (!tip || !tip.id || !tip.text) return null;

    // 记录本次显示：tipsHistory[id] = 当前 numStartups（对齐 CC recordTipShown）。
    // 使同一会话内二次调用（/clear 重绘）时该条进入 0-会话冷却，浮现另一条。
    if (state.tipsHistory[tip.id] !== state.numStartups) {
      state.tipsHistory[tip.id] = state.numStartups;
      _save(p, state);
    }
    return { id: tip.id, text: tip.text };
  } catch {
    return null;
  }
}

// 测试辅助：重置进程级 bump 标志（不触碰磁盘）。
function _resetProcessFlagForTest() {
  _bumpedThisProcess = false;
}

module.exports = { bumpStartupAndSelectTip, _resetProcessFlagForTest };
