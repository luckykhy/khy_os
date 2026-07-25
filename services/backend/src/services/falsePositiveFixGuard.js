'use strict';

/**
 * falsePositiveFixGuard.js — 防「小模型误判 bug、把本来正确的代码改成错误的」。
 *
 * 背景(goal 2026-06-25):
 *   弱模型在多轮工具循环里有一类高危失败:**幻想出一个并不存在的 bug**,然后"修复"它,
 *   把原本正确的代码改坏。既有的回归门(bugfixRegressionGate / devCourseMonitor)只在
 *   **已有某个测试变红**时才抓得住——若被改坏的是**没有任何测试覆盖**的正确代码,所有现门
 *   静默放行。最强的前置防线是 **复现先行(reproduce-before-fix)**:声称修 bug 之前,必须先
 *   有一个能复现该 bug 的**失败测试(红)**;因为代码若本来正确,根本写不出对它失败的测试。
 *
 *   本模块把这条纪律落成确定性、零 IO 的纯叶子守卫,沿用 devCourseMonitor 的非侵入哲学:
 *
 *     · 复现先行(前半)  —— bugfix 意图下编辑了非测试源码,却从未观察到任何红色复现:
 *                           `phantomSuspected` = 很可能在"修"一个并不存在的 bug。
 *     · 红→绿确认         —— 同一测试先红后绿:`reproObserved` = 真修了一个真 bug(放行 + 触发沉淀)。
 *     · 加固覆盖门         —— bugfix 改了**无兄弟测试覆盖**的源码且未复现:改动无回归保护。
 *     · 行为特征漂移       —— characterizationSnapshot 在未覆盖文件上检出的静默行为变化。
 *
 *   **分档执行**:档位由调用方传入 `tier`('low' | 'high' | …)。
 *     · 低档(弱模型)   → `finalize` 可返回 `verdict:'block', passed:false`,经 harness 并入
 *                          regressionGateReport(passed:false)→ deliveryGate 硬拦交付。
 *     · 高档(强模型)   → 恒 `verdict:'caution', passed:true`,只产 `[SYSTEM]` 上下文参考提示,
 *                          可采用/改写/忽略,**绝不阻断**。
 *
 *   保守判定:只在 bugfix 意图 **且** 真改了非测试源码时才 engage;问答 / 纯功能 / 只读轮零产出。
 *   "什么算红色复现"取**宽松**口径(green===false 即算),这会让 phantom 更难成立 —— 守卫宁可
 *   少拦也不误伤正确的修复。`KHY_FPF_FAIL_OPEN=1` 则任何档位都不阻断(仅提示)。
 *
 * 纯叶子:零 IO、确定性、状态由调用方(loop)持有的普通对象承载,任何 throw 都 fail-soft。
 *
 * env:
 *   KHY_FALSE_POSITIVE_FIX_GUARD = off|on   主闸(默认 on)
 *   KHY_FPF_LOW_TIER_ONLY        = on|off   仅低档可硬拦(默认 on;off 则高档命中也可 block)
 *   KHY_FPF_REQUIRE_RED_REPRO    = on|off   复现先行门(默认 on)
 *   KHY_FPF_UNCOVERED_BLOCKS     = on|off   加固覆盖门(默认 on)
 *   KHY_FPF_FAIL_OPEN            = on|off   任何档位都不阻断、仅提示(默认 off)
 *   KHY_FPF_AUTO_DEPOSIT_REPRO   = on|off   RED→GREEN 时给出复现测试沉淀描述符(默认 on)
 *
 * 用法(loop / harness 接缝):
 *   const st = createState();
 *   st.bugfixIntent = looksLikeBugfixTask(userMessage);
 *   // 每轮工具结果后:
 *   recordIteration(st, { toolResults, testFindings, changedFiles }, env);
 *   const a = assess(st, env);                  // 强档:命中产 [SYSTEM] 提示
 *   if (a.caution && a.directive) inject(a.directive);
 *   // 收尾(harness):
 *   const v = finalize(st, { tier, changedFiles, current, baseline, knownFiles, silentBehaviorChanges }, env);
 *   if (v.verdict === 'block') { regressionGateReport.passed = false; … }
 *   if (v.deposit.shouldDeposit) { … harness 侧 IO 落复现测试 … }
 */

// bugfix / feature 意图模式与 bugfixRegressionGate 保持一致(单源同义)。
const BUGFIX_INTENT_PATTERN = /(修复|bug|fix(?:ing|ed)?|hotfix|回归|regression|故障|错误|报错|异常|崩溃|crash|fails?|failing|broken|defect|issue)/i;

// 编辑类工具(归一化名):写文件 / 改文件 / 多处编辑 / 打补丁。与 devCourseMonitor 对齐。
const _EDIT_RE = /^(write|writefile|edit|editfile|createfile|multiedit|applypatch|patch|scaffoldfiles)$/;

// 测试文件判定(跨语言保守口径)。
const _TEST_FILE_RE = [
  /(^|[\\/])tests?[\\/]/i,
  /(^|[\\/])__tests__[\\/]/i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|[\\/])test_[^\\/]+\.py$/i,
  /(^|[\\/])[^\\/]+_test\.(py|go)$/i,
];

// 收敛到 utils/normalizeToolName 单一真源(逐字节委托,调用点不变)
const _norm = require('../utils/normalizeToolName');

function isEnabled(env = process.env) {
  const v = env && env.KHY_FALSE_POSITIVE_FIX_GUARD;
  return v !== 'off' && v !== '0' && v !== 'false';
}

/** 通用「默认开」闸:仅 off/0/false 关闭。 */
function _flagOn(env, key, def = true) {
  const v = env && env[key];
  if (v === undefined || v === null || v === '') return def;
  return v !== 'off' && v !== '0' && v !== 'false' && v !== 'no';
}

/** bugfix 意图识别(与 bugfixRegressionGate.looksLikeBugfixTask 同义)。 */
function looksLikeBugfixTask(userMessage = '') {
  return BUGFIX_INTENT_PATTERN.test(String(userMessage || ''));
}

/** 是否测试文件。 */
function isTestFile(p) {
  const s = String(p || '');
  if (!s) return false;
  return _TEST_FILE_RE.some(re => re.test(s));
}

function _basename(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** basename 去掉常见扩展名后的「词干」,用于兄弟测试匹配。 */
function _stem(p) {
  let b = _basename(p);
  b = b.replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, '');
  b = b.replace(/\.[cm]?[jt]sx?$/i, '');
  b = b.replace(/\.py$/i, '');
  b = b.replace(/\.go$/i, '');
  b = b.replace(/_test$/i, '');
  return b;
}

/**
 * 在已知文件列表里为某个非测试源码文件寻找「兄弟测试」。纯名字启发式:
 * `bar.js` ↔ `bar.test.js` / `bar.spec.ts` / `test_bar.py` / `bar_test.go`,
 * 或任意 tests/ 下 basename 含该词干的测试文件。漏判只弱化守卫(可接受 fail-soft)。
 */
function _hasSiblingTest(srcFile, knownFiles) {
  const stem = _stem(srcFile);
  if (!stem) return false;
  const lowStem = stem.toLowerCase();
  for (const kf of knownFiles) {
    if (!isTestFile(kf)) continue;
    const base = _basename(kf).toLowerCase();
    if (
      base.startsWith(`${lowStem}.test.`) ||
      base.startsWith(`${lowStem}.spec.`) ||
      base === `test_${lowStem}.py` ||
      base === `${lowStem}_test.go` ||
      base === `${lowStem}_test.py` ||
      base.includes(lowStem)
    ) {
      return true;
    }
  }
  return false;
}

/** 从 changedFiles(或 toolResults 派生)算出无兄弟测试覆盖的非测试源码集合。 */
function _computeUncovered(changedFiles, knownFiles) {
  const known = Array.isArray(knownFiles) ? knownFiles : [];
  // 无法获知项目文件清单时,不在覆盖维度上阻断(fail-open)。
  if (known.length === 0) return [];
  const out = [];
  for (const f of (Array.isArray(changedFiles) ? changedFiles : [])) {
    if (!f || isTestFile(f)) continue;
    if (!_hasSiblingTest(f, known)) out.push(f);
  }
  return out;
}

function _extractPath(params) {
  if (!params || typeof params !== 'object') return null;
  const p = params.path || params.file_path || params.filePath || params.filename || params.file || params.target;
  return typeof p === 'string' && p ? p : null;
}

/** 一次复现的稳定签名:framework|command|sorted(redFailures)。供调用方算 hash 命名沉淀文件。 */
function _reproSignature(entry) {
  const fws = String(entry.framework || 'test');
  const cmd = String(entry.command || '');
  const fails = Array.isArray(entry.redFailures) ? [...entry.redFailures].map(String).sort() : [];
  return `${fws}|${cmd}|${fails.join('\n')}`;
}

/** 新建一份误判守卫状态(每个任务/loop 一份)。 */
function createState() {
  return {
    iteration: 0,
    bugfixIntent: false,
    firstSrcEditIteration: null, // 首次 bugfix 意图下编辑非测试源码的轮次
    srcEditsCount: 0,
    editedSrcFiles: new Set(),   // 改过的非测试源码
    editedTestFiles: new Set(),  // 改过的测试文件
    reproByKey: new Map(),       // framework|command -> { framework, command, redAt, greenAt, redFailures }
    sawAnyRed: false,            // 是否观察到过任何红色复现
    reproRedAt: null,            // 最早一次红色复现的轮次
    announced: new Set(),        // assess 的 episode 去重(条件解除后重新武装)
    cautions: [],                // 已浮出过的告诫(供 summarize)
  };
}

/**
 * 折叠一轮工具结果与测试发现进守卫状态。纯累积、绝不抛。
 * @param {object} state              createState() 产物
 * @param {object} input
 * @param {Array}  input.toolResults  本轮工具结果 [{ tool, params, result, ... }]
 * @param {Array}  input.testFindings 本轮 keyFindings.detectTestOutcome 产物
 * @param {Array}  input.changedFiles 本轮(或累计)写工具改动的文件路径(可选;缺省由 toolResults 派生)
 */
function recordIteration(state, input = {}, env = process.env) {
  if (!state) return;
  try {
    state.iteration += 1;
    const toolResults = Array.isArray(input.toolResults) ? input.toolResults : [];
    const testFindings = Array.isArray(input.testFindings) ? input.testFindings : [];

    // 1) 收集本轮编辑的文件(优先用调用方给的 changedFiles,否则从 toolResults 派生)。
    const edited = [];
    if (Array.isArray(input.changedFiles) && input.changedFiles.length) {
      for (const f of input.changedFiles) if (typeof f === 'string' && f) edited.push(f);
    } else {
      for (const tr of toolResults) {
        if (!tr) continue;
        if (tr.result && tr.result.success === false) continue; // 失败的写不算改动
        if (!_EDIT_RE.test(_norm(tr.tool))) continue;
        const f = _extractPath(tr.params);
        if (f) edited.push(f);
      }
    }
    for (const f of edited) {
      if (isTestFile(f)) {
        state.editedTestFiles.add(f);
      } else {
        const fresh = !state.editedSrcFiles.has(f);
        state.editedSrcFiles.add(f);
        if (state.bugfixIntent && fresh) {
          state.srcEditsCount += 1;
          if (state.firstSrcEditIteration == null) state.firstSrcEditIteration = state.iteration;
        }
      }
    }

    // 2) 折叠测试发现:per (framework|command) 记录先红后绿。
    for (const t of testFindings) {
      if (!t || t.kind !== 'test') continue;
      const fw = String(t.framework || 'test');
      const cmd = String(t.command || '');
      const key = `${fw}|${cmd}`;
      let e = state.reproByKey.get(key);
      if (!e) { e = { framework: fw, command: cmd, redAt: null, greenAt: null, redFailures: [] }; state.reproByKey.set(key, e); }
      // 宽松红判定:green===false 即算复现(让 phantom 更难成立 → 宁可少拦)。
      const isRed = t.green === false;
      const isGreen = t.green === true;
      if (isRed && e.redAt == null) {
        e.redAt = state.iteration;
        e.redFailures = Array.isArray(t.failures) ? t.failures.slice(0, 8) : [];
        state.sawAnyRed = true;
        state.reproRedAt = state.reproRedAt == null ? state.iteration : Math.min(state.reproRedAt, state.iteration);
      } else if (isRed && (!e.redFailures || !e.redFailures.length) && Array.isArray(t.failures) && t.failures.length) {
        e.redFailures = t.failures.slice(0, 8); // 补全失败样本名
      }
      if (isGreen && e.redAt != null && e.greenAt == null && state.iteration >= e.redAt) {
        e.greenAt = state.iteration; // 同一复现先红后绿 = 真修
      }
    }
  } catch { /* 守卫纯累积,绝不反噬 loop */ }
}

/** 是否观察到「真修」:某复现先红后绿。 */
function _reproObserved(state) {
  for (const e of state.reproByKey.values()) {
    if (e.redAt != null && e.greenAt != null && e.greenAt >= e.redAt) return true;
  }
  return false;
}

/** 取一条已确认的「先红后绿」复现条目(供沉淀)。 */
function _confirmedReproEntry(state) {
  let best = null;
  for (const e of state.reproByKey.values()) {
    if (e.redAt != null && e.greenAt != null && e.greenAt >= e.redAt) {
      if (!best || e.greenAt < best.greenAt) best = e;
    }
  }
  return best;
}

/**
 * 评估当前轨迹是否疑似「在修一个并不存在的 bug」。返回本次新出现的告诫 + 合成的 [SYSTEM] 提示。
 * 主要用于**强档**的非绑定提醒(低档的硬拦在 finalize 收口)。episode 去重 + 重新武装。
 * @returns {{ caution:boolean, signals:Array, directive:string|null }}
 */
function assess(state, env = process.env) {
  if (!state || !isEnabled(env) || !state.bugfixIntent) {
    return { caution: false, signals: [], directive: null };
  }
  let candidates = [];
  try {
    const requireRepro = _flagOn(env, 'KHY_FPF_REQUIRE_RED_REPRO', true);
    const editedSrc = state.firstSrcEditIteration != null;
    const reproObserved = _reproObserved(state);

    // 复现先行:改了源码"修 bug",却从未见过任何红色复现,也没有先红后绿 —— 很可能在修一个幻想的 bug。
    if (requireRepro && editedSrc && !state.sawAnyRed && !reproObserved) {
      candidates.push({
        key: 'phantom-no-repro',
        type: 'phantom-no-repro',
        detail: '已为"修复 bug"改动了非测试源码,但全程没有任何能复现该 bug 的失败(红)测试。'
          + '若代码本来就是正确的,通常写不出对它失败的测试 —— 建议先写一个能复现该 bug 的失败测试'
          + '(让它先变红),确认 bug 真实存在后再修改,避免把本来正确的代码改坏',
      });
    }
  } catch { return { caution: false, signals: [], directive: null }; }

  // episode 去重 + 重新武装。
  const activeKeys = new Set(candidates.map(c => c.key));
  for (const k of [...state.announced]) if (!activeKeys.has(k)) state.announced.delete(k);
  const fresh = candidates.filter(c => !state.announced.has(c.key));
  for (const c of fresh) state.announced.add(c.key);
  if (!fresh.length) return { caution: false, signals: [], directive: null };

  const directive = buildFalsePositiveHint(fresh);
  for (const c of fresh) state.cautions.push({ type: c.type, detail: c.detail, at: state.iteration });
  return { caution: true, signals: fresh, directive };
}

/** 把告诫合成一段「上下文参考」式提示(可采用 / 改写 / 忽略)。 */
function buildFalsePositiveHint(signals) {
  if (!Array.isArray(signals) || !signals.length) return null;
  const lines = signals.map((s, i) => `${i + 1}. ${s.detail}`);
  return `[SYSTEM: 复现先行提示(防 bug 误判 · 仅供参考,可采用/改写/忽略):\n${lines.join('\n')}\n`
    + `—— 若你确信 bug 真实存在且已有复现,可忽略此提示并继续;否则建议先复现(让测试变红)再修。]`;
}

/**
 * 收尾裁决。低档可硬拦,强档恒提示。零 IO:沉淀只返回描述符,由调用方落盘。
 * @param {object} state
 * @param {object} ctx
 * @param {string} ctx.tier                  'low' | 'high' | …(由调用方按模型档位解析)
 * @param {Array}  ctx.changedFiles          本任务累计改动的文件路径
 * @param {Array}  ctx.knownFiles            项目已知文件清单(用于覆盖判定;缺省则不在覆盖维度阻断)
 * @param {Array}  ctx.silentBehaviorChanges characterizationSnapshot 在未覆盖文件上检出的静默行为变化(可选)
 * @returns {{ verdict:'pass'|'block'|'caution', passed:boolean, blocked:boolean, reasons:Array,
 *            reproObserved:boolean, phantomSuspected:boolean, uncoveredFiles:Array,
 *            silentBehaviorChanges:Array, deposit:object, summary:string, recommendations:Array }}
 */
function finalize(state, ctx = {}, env = process.env) {
  const empty = {
    verdict: 'pass', passed: true, blocked: false, reasons: [],
    reproObserved: false, phantomSuspected: false, uncoveredFiles: [],
    silentBehaviorChanges: [], deposit: { shouldDeposit: false },
    summary: 'False-positive-fix guard skipped.', recommendations: [],
  };
  try {
    if (!state || !isEnabled(env) || !state.bugfixIntent) return empty;

    const requireRepro = _flagOn(env, 'KHY_FPF_REQUIRE_RED_REPRO', true);
    const uncoveredBlocks = _flagOn(env, 'KHY_FPF_UNCOVERED_BLOCKS', true);
    const lowTierOnly = _flagOn(env, 'KHY_FPF_LOW_TIER_ONLY', true);
    const failOpen = _flagOn(env, 'KHY_FPF_FAIL_OPEN', false);
    const autoDeposit = _flagOn(env, 'KHY_FPF_AUTO_DEPOSIT_REPRO', true);

    const tier = String(ctx.tier || '').trim().toLowerCase();
    const editedSrc = state.firstSrcEditIteration != null;
    const reproObserved = _reproObserved(state);

    // 没有真改过非测试源码 → 无可误判的对象,直接放行。
    if (!editedSrc) return { ...empty, reproObserved };

    const reasons = [];

    // 1) 复现先行:改源码"修 bug"却从无任何红复现、也无先红后绿。
    const phantomSuspected = !!(requireRepro && !state.sawAnyRed && !reproObserved);
    if (phantomSuspected) {
      reasons.push({
        code: 'phantom-no-repro',
        detail: '声称修复 bug 并改动了源码,但全程没有任何能复现该 bug 的失败(红)测试 —— 该 bug 可能并不存在,改动有把正确代码改坏的风险',
      });
    }

    // 2) 加固覆盖门:bugfix 改了无兄弟测试覆盖的源码,且未通过复现保护。
    //    真 RED→GREEN 复现本身即提供了覆盖,故 reproObserved 时不计未覆盖。
    let uncoveredFiles = [];
    if (uncoveredBlocks && !reproObserved) {
      uncoveredFiles = _computeUncovered(ctx.changedFiles, ctx.knownFiles).filter(f => state.editedSrcFiles.has(f));
      if (uncoveredFiles.length) {
        reasons.push({
          code: 'uncovered-bugfix-edit',
          detail: `bugfix 改动了无测试覆盖的源码(${uncoveredFiles.slice(0, 3).join(', ')}${uncoveredFiles.length > 3 ? ' …' : ''}),`
            + '一旦改坏没有任何回归测试会发现 —— 建议为受影响代码补一个复现/特征测试',
        });
      }
    }

    // 3) 行为特征漂移:未覆盖文件上的静默行为变化。
    //    优先用调用方预算的 ctx.silentBehaviorChanges;若未提供但给了回归门 baseline/current
    //    快照,则就地用 characterizationSnapshot 差分——**复用本守卫的 _computeUncovered 作
    //    coveredFiles 的单一真源**(不另造覆盖判定,防漂移)。gate KHY_FPF_CHARACTERIZATION
    //    关 / 无快照 / 抛错 → silentBehaviorChanges 恒 [] → 逐字节回退。fail-soft。
    let silentBehaviorChanges = Array.isArray(ctx.silentBehaviorChanges) ? ctx.silentBehaviorChanges : [];
    if (!silentBehaviorChanges.length && ctx.baseline && ctx.current) {
      try {
        const cs = require('./characterizationSnapshot');
        if (cs.isEnabled(env)) {
          const changed = Array.isArray(ctx.changedFiles) ? ctx.changedFiles : [];
          const uncov = new Set(_computeUncovered(changed, ctx.knownFiles));
          const coveredFiles = changed.filter(f => !uncov.has(f));
          const base = cs.captureBaseline({ changedFiles: changed, verificationSnapshot: ctx.baseline });
          const cur = cs.captureBaseline({ changedFiles: changed, verificationSnapshot: ctx.current });
          const diff = cs.diffBehavior(base, cur, { coveredFiles }, env);
          silentBehaviorChanges = Array.isArray(diff.silentChanges) ? diff.silentChanges : [];
        }
      } catch { /* fail-soft:特征化绝不破坏收口裁决 */ }
    }
    if (!reproObserved && silentBehaviorChanges.length) {
      reasons.push({
        code: 'silent-behavior-change',
        detail: `检测到未被测试覆盖的可观测行为发生了静默变化(${silentBehaviorChanges.length} 处),`
          + '若非有意更改,可能是误判 bug 导致的回归',
      });
    }

    // 裁决:无理由 → pass;有理由 → 低档(或关闭 lowTierOnly)可 block,否则仅 caution;failOpen 一律不阻断。
    let verdict = 'pass';
    let blocked = false;
    if (reasons.length) {
      const canBlock = !failOpen && (tier === 'low' || !lowTierOnly);
      verdict = canBlock ? 'block' : 'caution';
      blocked = verdict === 'block';
    }

    // 沉淀:真 RED→GREEN 修复 → 给出复现测试沉淀描述符(IO 由调用方完成)。
    let deposit = { shouldDeposit: false };
    if (autoDeposit && reproObserved) {
      const e = _confirmedReproEntry(state);
      if (e) {
        deposit = {
          shouldDeposit: true,
          framework: e.framework,
          command: e.command,
          redFailures: Array.isArray(e.redFailures) ? e.redFailures.slice(0, 8) : [],
          signature: _reproSignature(e),
        };
      }
    }

    const recommendations = [];
    if (phantomSuspected) recommendations.push('先写一个能复现该 bug 的失败测试,确认 bug 真实存在后再修改。');
    if (uncoveredFiles.length) recommendations.push('为本次改动的未覆盖源码补一个测试,锁住正确行为。');
    if (deposit.shouldDeposit) recommendations.push('已识别真实的红→绿复现,可将其沉淀为永久回归测试。');

    const summary = reasons.length
      ? `False-positive-fix guard ${blocked ? 'blocked' : 'flagged'} delivery: ${reasons.map(r => r.code).join(', ')}.`
      : 'False-positive-fix guard passed (reproduction observed or no risk).';

    // 收尾把裁决记进 cautions(供 summarize / 返回契约)。
    if (reasons.length) {
      for (const r of reasons) state.cautions.push({ type: r.code, detail: r.detail, at: state.iteration, finalized: true });
    }

    return {
      verdict, passed: !blocked, blocked, reasons,
      reproObserved, phantomSuspected, uncoveredFiles,
      silentBehaviorChanges, deposit, summary, recommendations,
    };
  } catch {
    return empty; // fail-soft:守卫绝不崩调用方
  }
}

/** 是否已浮出过任何告诫(供返回契约判定)。 */
function hasFindings(state) {
  return !!(state && state.cautions && state.cautions.length);
}

/** 收尾摘要:挂到 loop / harness 返回契约,供 UI/程序复盘。 */
function summarize(state) {
  if (!state) return null;
  const byType = {};
  for (const c of state.cautions) byType[c.type] = (byType[c.type] || 0) + 1;
  return {
    iterations: state.iteration,
    bugfixIntent: !!state.bugfixIntent,
    srcEdits: state.srcEditsCount,
    srcFilesTouched: state.editedSrcFiles.size,
    sawAnyRed: !!state.sawAnyRed,
    reproObserved: _reproObserved(state),
    cautions: state.cautions.slice(-10),
    byType,
  };
}

module.exports = {
  isEnabled,
  looksLikeBugfixTask,
  isTestFile,
  createState,
  recordIteration,
  assess,
  buildFalsePositiveHint,
  finalize,
  hasFindings,
  summarize,
  _reproSignature,
  _DEFAULTS: { BUGFIX_INTENT_PATTERN },
};
