'use strict';

/**
 * acceptance.js — 验收器，验证成本分三级，按级别决定什么时候花什么代价。
 *
 * 三级的存在理由是「代价差三个数量级」：
 *   一级 grep 源码判模块在不在   秒级    每一块都过，几乎免费
 *   二级 打开产物实际点一遍     分钟级  多数问题都在这一层暴露，这是主力
 *   三级 跑完整测试套件         十分钟+ 只在收尾跑一次
 *
 * **禁止每一块都跑第三级**，这条是硬约束而不是建议，所以由 AcceptancePolicy 用代码
 * 拦：三级必须声明 scope='wrapup'，且整个流程内只放行 maxTier3Runs 次（默认 1）。
 * 按块申请三级会被直接拒绝并说明原因，而不是「跑了但很慢」—— 那样的话约束等于没有。
 *
 * 另两条设计约束：
 *   - 二级没有注入 runner 时如实报 ok:false（reason 写清「没有交互执行器」），
 *     绝不因为「跑不了」就当作通过。验收器谎报比不验收更糟。
 *   - 三级走 spawnWithIdleTimeout 的滑动空闲超时（红线 3），不设固定时长硬 kill：
 *     完整套件本来就有十分钟以上的量级，固定超时一定误杀。
 *
 * @module services/auditTrajectory/acceptance
 */

const fs = require('fs');
const path = require('path');

/** 级别常量（外部只认这三个数字）。 */
const TIER = { GREP: 1, INTERACT: 2, SUITE: 3 };

/** 三级的默认空闲上限：套件里单步十分钟不出声就该怀疑挂了。 */
const DEFAULT_SUITE_IDLE_MS = 600000;

/** 二级单步的默认空闲上限。 */
const DEFAULT_STEP_IDLE_MS = 60000;

// ── 一级：grep 源码判模块在不在（秒级，每块都过） ──

/**
 * 一级验收：只回答「这个模块/符号在不在源码里」。
 *
 * 刻意不 spawn 外部 grep：读文件 + 正则在本地就够快（毫秒级），还省掉跨平台
 * grep 参数差异。一级的产出必须是可核查的 —— 命中要带文件与行号，缺失要点名
 * 缺的是哪个 pattern。
 *
 * @param {object} args
 * @param {string} args.root 搜索根目录
 * @param {Array<object>} args.checks [{ name, files:[相对路径], patterns:[string|RegExp], anyOf? }]
 * @returns {{tier:number, ok:boolean, results:Array, elapsedMs:number, status:string}}
 */
function tier1Grep(args = {}) {
  const started = Date.now();
  const root = String(args.root || process.cwd());
  const checks = Array.isArray(args.checks) ? args.checks : [];
  const results = [];

  for (const c of checks) {
    const name = String((c && c.name) || '(未命名)');
    const files = Array.isArray(c && c.files) ? c.files : [];
    const patterns = Array.isArray(c && c.patterns) ? c.patterns : [];
    const hits = [];
    const missingFiles = [];
    const matched = new Set();

    for (const rel of files) {
      const abs = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
      let text = '';
      try {
        text = fs.readFileSync(abs, 'utf-8');
      } catch {
        missingFiles.push(rel);
        continue;
      }
      const lines = text.split('\n');
      for (const p of patterns) {
        const re = p instanceof RegExp ? p : new RegExp(String(p));
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matched.add(String(p));
            hits.push({ file: rel, line: i + 1, pattern: String(p), text: lines[i].trim().slice(0, 120) });
            break; // 每个 pattern 每个文件只留第一处命中，一级的目的是「在不在」而非统计
          }
        }
      }
    }

    const missingPatterns = patterns.map((p) => String(p)).filter((p) => !matched.has(p));
    const ok = c && c.anyOf ? matched.size > 0 : missingPatterns.length === 0 && missingFiles.length === 0;
    results.push({
      name,
      ok,
      hits,
      missingFiles,
      missingPatterns,
      reason: ok
        ? ''
        : missingFiles.length > 0
          ? '读不到文件：' + missingFiles.join('、')
          : '源码里找不到：' + missingPatterns.join('、'),
    });
  }

  const failed = results.filter((r) => !r.ok);
  return {
    tier: TIER.GREP,
    ok: failed.length === 0,
    results,
    elapsedMs: Date.now() - started,
    status:
      '一级验收 grep 源码：' +
      (results.length - failed.length) +
      ' / ' +
      results.length +
      ' 块在位' +
      (failed.length > 0 ? '，缺：' + failed.map((f) => f.name).join('、') : ''),
  };
}

// ── 二级：打开产物实际点一遍（分钟级，主力层） ──

/**
 * 二级验收：真的把产物打开、真的点一遍，判「可不可用」。
 *
 * runner 由调用方注入（浏览器驱动、ComputerUse、或任何 async 函数），签名：
 *   async runner(step, ctx) => { ok, evidence?, screenshot?, note? }
 * 这样验收器本身不绑定任何 GUI 栈，也方便单测。
 *
 * 没给 runner 时**不假装通过**：返回 ok:false + ran:false，reason 写明缺执行器。
 * 二级是发现问题最多的一层，静默跳过等于把问题一路留到交付。
 *
 * @param {object} args
 * @param {string} [args.artifact] 产物入口（页面路径 / URL / 可执行）
 * @param {Array<object>} args.steps [{ name, action, expect }]
 * @param {function} [args.runner]
 * @param {number} [args.stepIdleMs]
 * @returns {Promise<object>} { tier, ok, ran, steps, screenshots, elapsedMs, status }
 */
async function tier2Interact(args = {}) {
  const started = Date.now();
  const steps = Array.isArray(args.steps) ? args.steps : [];
  const artifact = String(args.artifact || '');

  if (typeof args.runner !== 'function') {
    return {
      tier: TIER.INTERACT,
      ok: false,
      ran: false,
      steps: [],
      screenshots: [],
      elapsedMs: Date.now() - started,
      reason: '二级验收需要交互执行器（runner），当前没有注入，无法判定产物可不可用',
      status: '二级验收实际点一遍：未执行（缺交互执行器），' + steps.length + ' 步待验',
    };
  }
  if (steps.length === 0) {
    return {
      tier: TIER.INTERACT,
      ok: false,
      ran: false,
      steps: [],
      screenshots: [],
      elapsedMs: Date.now() - started,
      reason: '二级验收没有给出任何交互步骤，等于什么都没验',
      status: '二级验收实际点一遍：未执行（没有步骤）',
    };
  }

  const out = [];
  const screenshots = [];
  const idleMs = Number.isFinite(args.stepIdleMs) ? args.stepIdleMs : DEFAULT_STEP_IDLE_MS;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const name = String((step && step.name) || 'step#' + (i + 1));
    let r = null;
    let err = null;
    try {
      // 单步用滑动空闲上限兜住（红线 3）：runner 卡住不出声才超时，正常慢不算超时。
      r = await _withIdle(() => args.runner(step, { artifact, index: i, total: steps.length }), idleMs, name);
    } catch (e) {
      err = (e && e.message) || String(e);
    }
    const ok = !!(r && r.ok) && !err;
    const shot = r && (r.screenshot || r.shot);
    if (shot && _existsNonEmpty(shot)) {
      screenshots.push(shot);
    }
    out.push({
      name,
      ok,
      evidence: (r && r.evidence) || '',
      screenshot: shot && _existsNonEmpty(shot) ? shot : '',
      note: (r && r.note) || '',
      error: err || (r && r.error) || '',
    });
    if (!ok && args.stopOnFail !== false) {
      break; // 第一步就打不开，后面的点击都没意义
    }
  }

  const failed = out.filter((s) => !s.ok);
  return {
    tier: TIER.INTERACT,
    ok: failed.length === 0 && out.length > 0,
    ran: true,
    steps: out,
    screenshots,
    elapsedMs: Date.now() - started,
    reason: failed.length > 0 ? '「' + failed[0].name + '」这步没过：' + (failed[0].error || failed[0].evidence || '无更多信息') : '',
    status:
      '二级验收实际点一遍：' +
      (out.length - failed.length) +
      ' / ' +
      steps.length +
      ' 步可用' +
      (screenshots.length > 0 ? '，留下 ' + screenshots.length + ' 张截图' : ''),
  };
}

function _existsNonEmpty(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** 给注入的 runner 加一层空闲上限：runner 自己不报活时按整步计时。 */
function _withIdle(fn, idleMs, label) {
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    return Promise.resolve().then(fn);
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(Object.assign(new Error('交互步骤「' + label + '」' + idleMs + 'ms 无进展，判为卡死'), { idleTimeout: true }));
      }
    }, idleMs);
    Promise.resolve()
      .then(fn)
      .then(
        (v) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve(v);
          }
        },
        (e) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            reject(e);
          }
        }
      );
  });
}

// ── 三级：跑完整测试套件（十分钟以上，只在收尾跑一次） ──

class Tier3RefusedError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'Tier3RefusedError';
    Object.assign(this, detail);
  }
}

/**
 * 三级放行策略。把「禁止每一块都跑第三级」写成代码而不是注释。
 *
 * 拒绝有两种：scope 不是 wrapup（按块申请，直接拒），以及收尾额度已用完
 * （默认只给一次）。两种都带 code，便于上层区分是「用错时机」还是「已经跑过」。
 */
class AcceptancePolicy {
  constructor(opts = {}) {
    this.allowTier3Scope = String(opts.allowTier3Scope || 'wrapup');
    this.maxTier3Runs = Number.isInteger(opts.maxTier3Runs) ? opts.maxTier3Runs : 1;
    this.tier3Runs = 0;
    this.refusals = [];
  }

  /**
   * 申请跑三级。
   * @param {object} req { scope, blockId }
   * @returns {{allowed:boolean, code?:string, reason?:string}}
   */
  requestTier3(req = {}) {
    const scope = String(req.scope || 'block');
    const blockId = String(req.blockId || '');
    if (scope !== this.allowTier3Scope) {
      const d = {
        allowed: false,
        code: 'TIER3_PER_BLOCK_FORBIDDEN',
        reason:
          '拒绝三级验收：scope=' +
          scope +
          (blockId ? '（块 ' + blockId + '）' : '') +
          '，完整套件十分钟以上，只允许在收尾跑一次。这一块请用一级 grep 加二级实际点一遍',
      };
      this.refusals.push(d);
      return d;
    }
    if (this.tier3Runs >= this.maxTier3Runs) {
      const d = {
        allowed: false,
        code: 'TIER3_BUDGET_EXHAUSTED',
        reason: '拒绝三级验收：收尾额度 ' + this.maxTier3Runs + ' 次已用完（已跑 ' + this.tier3Runs + ' 次）',
      };
      this.refusals.push(d);
      return d;
    }
    this.tier3Runs += 1;
    return { allowed: true, run: this.tier3Runs };
  }

  /** 策略执行情况，面向人阅读。 */
  report() {
    return {
      tier3Runs: this.tier3Runs,
      maxTier3Runs: this.maxTier3Runs,
      refusals: this.refusals.slice(),
      status:
        '三级验收额度：已用 ' +
        this.tier3Runs +
        ' / ' +
        this.maxTier3Runs +
        '，按块申请被拒 ' +
        this.refusals.filter((r) => r.code === 'TIER3_PER_BLOCK_FORBIDDEN').length +
        ' 次',
    };
  }
}

/**
 * 三级验收：跑完整测试套件。滑动空闲超时，不设固定时长硬 kill（红线 3）。
 *
 * @param {object} args
 * @param {object} args.policy AcceptancePolicy 实例（必给，三级不允许无策略直跑）
 * @param {string} [args.scope] 必须是 'wrapup' 才放行
 * @param {string} [args.blockId] 申请方，被拒时写进原因
 * @param {string} [args.command] 默认 npm
 * @param {Array<string>} [args.args] 默认 ['test']
 * @param {string} [args.cwd]
 * @param {number} [args.idleMs] 默认 600000（十分钟无输出才判卡死）
 * @param {function} [args.spawnImpl] 注入用（单测不真跑套件）
 * @returns {Promise<object>}
 */
async function tier3FullSuite(args = {}) {
  const policy = args.policy;
  if (!policy || typeof policy.requestTier3 !== 'function') {
    throw new Tier3RefusedError('三级验收必须带放行策略（AcceptancePolicy），不允许无策略直跑完整套件', {
      code: 'TIER3_NO_POLICY',
    });
  }
  const gate = policy.requestTier3({ scope: args.scope, blockId: args.blockId });
  if (!gate.allowed) {
    return {
      tier: TIER.SUITE,
      ok: false,
      ran: false,
      refused: true,
      code: gate.code,
      reason: gate.reason,
      status: gate.reason,
    };
  }

  const started = Date.now();
  const command = String(args.command || 'npm');
  const argv = Array.isArray(args.args) ? args.args.map(String) : ['test'];
  const idleMs = Number.isFinite(args.idleMs) ? args.idleMs : DEFAULT_SUITE_IDLE_MS;
  const spawnImpl = typeof args.spawnImpl === 'function' ? args.spawnImpl : require('../../../../utils/spawnWithIdleTimeout').spawnWithIdleTimeout;

  try {
    const r = await spawnImpl(command, argv, {
      idleMs,
      label: '完整测试套件',
      spawnOpts: { cwd: args.cwd || process.cwd(), shell: process.platform === 'win32' },
      outputEncoding: 'utf-8',
    });
    const code = Number(r && r.code);
    return {
      tier: TIER.SUITE,
      ok: code === 0,
      ran: true,
      exitCode: code,
      stdout: (r && r.stdout) || '',
      stderr: (r && r.stderr) || '',
      elapsedMs: Date.now() - started,
      status: '三级验收完整套件：' + command + ' ' + argv.join(' ') + ' 退出码 ' + code + '，耗时 ' + Math.round((Date.now() - started) / 1000) + 's',
    };
  } catch (err) {
    return {
      tier: TIER.SUITE,
      ok: false,
      ran: true,
      idleTimeout: !!(err && err.idleTimeout),
      error: (err && err.message) || String(err),
      elapsedMs: Date.now() - started,
      status:
        '三级验收完整套件：失败（' +
        (err && err.idleTimeout ? Math.round(idleMs / 1000) + 's 无输出，判为卡死' : (err && err.message) || String(err)) +
        '）',
    };
  }
}

// ── 阶梯 ──

/**
 * 按阶梯跑验收：一级必跑，一级不过就短路（模块都不在，点它没意义），
 * 二级有步骤就跑，三级只在 scope='wrapup' 且策略放行时跑。
 *
 * 这个函数就是「禁止每一块都跑第三级」的落地形态：每块调用时传 scope='block'，
 * 三级根本不会进入；收尾时单独调一次 scope='wrapup'。
 *
 * @param {object} args { scope, blockId, root, checks, interact, suite, policy }
 * @returns {Promise<object>} { ok, scope, tiers, skipped, status }
 */
async function runLadder(args = {}) {
  const scope = String(args.scope || 'block');
  const policy = args.policy || new AcceptancePolicy();
  const tiers = [];
  const skipped = [];

  const t1 = tier1Grep({ root: args.root, checks: args.checks || [] });
  tiers.push(t1);
  if (!t1.ok) {
    skipped.push({ tier: TIER.INTERACT, reason: '一级没过，先把缺的模块补上再点' });
    skipped.push({ tier: TIER.SUITE, reason: '一级没过，跑完整套件是浪费十分钟' });
    return {
      ok: false,
      scope,
      tiers,
      skipped,
      policy: policy.report(),
      status: '验收阶梯止于一级：' + t1.status,
    };
  }

  if (args.interact) {
    const t2 = await tier2Interact(args.interact);
    tiers.push(t2);
    if (!t2.ok) {
      skipped.push({ tier: TIER.SUITE, reason: '二级发现产物不可用，先修再跑套件' });
      return { ok: false, scope, tiers, skipped, policy: policy.report(), status: '验收阶梯止于二级：' + t2.status };
    }
  } else {
    skipped.push({ tier: TIER.INTERACT, reason: '本次未提供交互步骤' });
  }

  if (scope !== 'wrapup') {
    skipped.push({ tier: TIER.SUITE, reason: '按块验收不跑三级（完整套件十分钟以上，只在收尾跑一次）' });
    return {
      ok: true,
      scope,
      tiers,
      skipped,
      policy: policy.report(),
      status: '验收通过（一级' + (args.interact ? ' + 二级' : '') + '），三级留到收尾',
    };
  }

  if (!args.suite) {
    skipped.push({ tier: TIER.SUITE, reason: '收尾但未给出套件命令' });
    return { ok: true, scope, tiers, skipped, policy: policy.report(), status: '收尾验收：一二级通过，未给三级命令' };
  }

  const t3 = await tier3FullSuite({ ...args.suite, policy, scope, blockId: args.blockId });
  tiers.push(t3);
  return {
    ok: t3.ok,
    scope,
    tiers,
    skipped,
    policy: policy.report(),
    status: '收尾验收：' + t3.status,
  };
}

module.exports = {
  TIER,
  DEFAULT_SUITE_IDLE_MS,
  DEFAULT_STEP_IDLE_MS,
  tier1Grep,
  tier2Interact,
  tier3FullSuite,
  runLadder,
  AcceptancePolicy,
  Tier3RefusedError,
};
