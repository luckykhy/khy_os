'use strict';

/**
 * characterizationSnapshot.js — 行为特征快照 / 差分小 helper(falsePositiveFixGuard 的副脑)。
 *
 * 背景(goal 2026-06-25):
 *   防「小模型误判 bug 改坏正确代码」的另一面是 **characterization(行为特征化)**:把改动前后
 *   **可观测的验证行为**拍成指纹,再差分。若 bugfix 改动的文件**没有任何测试覆盖**,而**非测试
 *   验证步骤**(syntax / lint / typecheck / build)的可观测结果却悄悄变了,这是一种"测试看不见"
 *   的静默行为漂移 —— 正是误判 bug 把正确代码改坏时会留下的痕迹。
 *
 *   本 helper **不自己跑任何命令**:它复用 bugfixRegressionGate._runVerificationSnapshot 已经
 *   产出的 baseline / current 快照(步骤级 { name, pass, summary }),只做确定性的指纹与差分。
 *   产物 `silentChanges` 交给 falsePositiveFixGuard.finalize 作为一条**软**理由(强档仅提示,
 *   低档可参与硬拦)。被测试覆盖的改动视为有回归保护,不计静默。
 *
 * 纯叶子:零 IO、确定性、fail-soft。
 *
 * env:
 *   KHY_FPF_CHARACTERIZATION = off|on   (默认 on;off 则 diffBehavior 恒返回空)
 *
 * 用法:
 *   const base = captureBaseline({ changedFiles, verificationSnapshot: gateBaseline });
 *   const cur  = captureBaseline({ changedFiles, verificationSnapshot: gateCurrent });
 *   const { silentChanges } = diffBehavior(base, cur, { coveredFiles });
 */

// 测试类步骤(其结果变化由回归门 / 复现门覆盖,不算"静默")。
const _TEST_STEP = new Set(['test']);

function isEnabled(env = process.env) {
  const v = env && env.KHY_FPF_CHARACTERIZATION;
  return v !== 'off' && v !== '0' && v !== 'false';
}

/** 依赖无关的确定性字符串指纹(FNV-1a 32-bit),用于比较步骤可观测输出是否变化。 */
function _fp(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function _isTestStep(name) {
  return _TEST_STEP.has(String(name || '').trim().toLowerCase());
}

/**
 * 把一份验证快照拍成行为特征:每个步骤的 { pass, fp(summary) }。
 * @param {object} input
 * @param {Array}  input.changedFiles         本次改动文件
 * @param {object} input.verificationSnapshot  _runVerificationSnapshot 产物({ steps:[{name,pass,...}] })
 * @returns {{ files:Array, steps:object }}
 */
function captureBaseline(input = {}) {
  const out = { files: [], steps: {} };
  try {
    out.files = Array.isArray(input.changedFiles) ? input.changedFiles.filter(f => typeof f === 'string' && f) : [];
    const snap = input.verificationSnapshot || {};
    const steps = Array.isArray(snap.steps) ? snap.steps : [];
    for (const st of steps) {
      const name = String(st && st.name || '').trim().toLowerCase();
      if (!name) continue;
      // summary / output 任一可观测文本作指纹源(确定性;不含时间戳)。
      const obs = st.summary != null ? st.summary : (st.output != null ? st.output : '');
      out.steps[name] = { pass: st.pass !== false, fp: _fp(obs) };
    }
  } catch { /* fail-soft */ }
  return out;
}

/**
 * 差分两份行为特征。仅在改动文件**未被测试覆盖**时,把**非测试步骤**的可观测变化记为静默漂移。
 * @param {object} baseline captureBaseline 产物
 * @param {object} current  captureBaseline 产物
 * @param {object} opts
 * @param {Array}  opts.coveredFiles 被测试覆盖的改动文件(其改动有回归保护)
 * @returns {{ silentChanges:Array, coveredChanges:Array }}
 */
function diffBehavior(baseline, current, opts = {}, env = process.env) {
  const result = { silentChanges: [], coveredChanges: [] };
  try {
    if (!isEnabled(env) || !baseline || !current) return result;

    const changed = Array.isArray(baseline.files) ? baseline.files : [];
    const covered = new Set(Array.isArray(opts.coveredFiles) ? opts.coveredFiles : []);
    // 全部改动文件都被测试覆盖 → 有回归保护,任何步骤变化都不算"静默"。
    const allCovered = changed.length > 0 && changed.every(f => covered.has(f));

    const names = new Set([...Object.keys(baseline.steps || {}), ...Object.keys(current.steps || {})]);
    for (const name of names) {
      const b = baseline.steps[name];
      const c = current.steps[name];
      if (!b || !c) continue; // 步骤集变化(可用性差异)不在此判定
      const changedStep = b.pass !== c.pass || b.fp !== c.fp;
      if (!changedStep) continue;
      const entry = { step: name, from: b.pass ? 'pass' : 'fail', to: c.pass ? 'pass' : 'fail' };
      if (_isTestStep(name) || allCovered) {
        result.coveredChanges.push(entry); // 测试步骤 / 全覆盖:有保护
      } else {
        result.silentChanges.push(entry);  // 非测试步骤 + 存在未覆盖改动:静默漂移
      }
    }
  } catch { /* fail-soft */ }
  return result;
}

module.exports = {
  isEnabled,
  captureBaseline,
  diffBehavior,
  _DEFAULTS: { _fp },
};
