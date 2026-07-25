'use strict';

/**
 * flagRegistry.test.js — KHY_* flag 中央注册表 resolver 的单元 + 逐字节等价 oracle(node:test)。
 *
 * 背景(goal 2026-07-03「khy 中有许多规则但是缺乏优先级,我希望能完善」):flagRegistry 把散落近百处
 * 的门控父→子优先级收敛成单一声明式真源。本测两条主线:
 *   ① 语义正确:父→子优先级(父关⇒子恒关)、三种 mode 解析、numeric clamp、绝不抛。
 *   ② **逐字节等价 oracle**(关键):对已 rewire 的 flag,遍历值域断言 isFlagEnabled == 原 inline
 *      谓词副本(oracle),证 goalStopGate/toolContract rewire 零行为变化;并证声明-only 的
 *      rewind/priority 条目精确(含 KHY_PLAN_PRIORITY=OFF⇒开 的不归一 quirk)。
 */

const test = require('node:test');
const assert = require('node:assert');

const reg = require('../../src/services/flagRegistry');

// ── oracle:各方言的原始 inline 谓词副本(从各源文件逐字复刻)────────────────
const CANON = new Set(['0', 'false', 'off', 'no']);
const EXTENDED = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);
const MINIMAL_BARE = new Set(['0', 'false', 'off']); // priorityTaxonomy 裸 === 不归一

// goalStopGate 原 _off(CANON + 归一)
const off4 = (v) => v !== undefined && CANON.has(String(v).trim().toLowerCase());
// toolContract 原(EXTENDED + 归一 + 空串视为开)
function oToolContract(env, key) {
  const raw = String((env && env[key]) || '').trim().toLowerCase();
  if (!raw) return true;
  return !EXTENDED.has(raw);
}
// priorityTaxonomy 原 _flagOn(裸 ===,不 trim/不 lowercase)
const oPlanBare = (env, name) => {
  const v = env && env[name];
  return !(v === '0' || v === 'false' || v === 'off');
};

const VALS = [undefined, '', '0', 'false', 'off', 'no', 'disable', 'disabled', 'OFF', ' off ', 'true', '1', 'x', 'No', 'Off'];

// ── 父→子优先级 ────────────────────────────────────────────────────────
test('父→子优先级:KHY_GOAL 关 ⇒ 子 KHY_GOAL_STOP_GATE 恒 false', () => {
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(reg.isFlagEnabled('KHY_GOAL_STOP_GATE', { KHY_GOAL: v }), false, `KHY_GOAL=${v}`);
  }
  // 父开、子自身也开 → true
  assert.strictEqual(reg.isFlagEnabled('KHY_GOAL_STOP_GATE', {}), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_GOAL_STOP_GATE', { KHY_GOAL: 'yes' }), true);
});

test('父→子优先级:KHY_TOOL_CONTRACT 关 ⇒ 子 KHY_TOOL_PARAM_AUDIT 恒 false', () => {
  for (const v of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    assert.strictEqual(reg.isFlagEnabled('KHY_TOOL_PARAM_AUDIT', { KHY_TOOL_CONTRACT: v }), false, `contract=${v}`);
  }
  assert.strictEqual(reg.isFlagEnabled('KHY_TOOL_PARAM_AUDIT', {}), true);
});

test('父→子优先级:KHY_REWIND_SCOPE 关 ⇒ 子 KHY_REWIND_SUMMARIZE 恒 false(声明-only 链)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_REWIND_SUMMARIZE', { KHY_REWIND_SCOPE: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_REWIND_SUMMARIZE', {}), true);
});

// ── mode 解析 ──────────────────────────────────────────────────────────
test('numeric 解析:default / clamp / 非法回退', () => {
  assert.strictEqual(reg.resolveNumeric('KHY_GOAL_STOP_GATE_MAX', {}), 1, 'default');
  assert.strictEqual(reg.resolveNumeric('KHY_GOAL_STOP_GATE_MAX', { KHY_GOAL_STOP_GATE_MAX: '3' }), 3);
  assert.strictEqual(reg.resolveNumeric('KHY_GOAL_STOP_GATE_MAX', { KHY_GOAL_STOP_GATE_MAX: '-5' }), 1, '负 → 回退默认');
  assert.strictEqual(reg.resolveNumeric('KHY_GOAL_STOP_GATE_MAX', { KHY_GOAL_STOP_GATE_MAX: '999' }), 10, 'clamp max');
  assert.strictEqual(reg.resolveNumeric('KHY_GOAL_STOP_GATE_MAX', { KHY_GOAL_STOP_GATE_MAX: 'abc' }), 1, 'NaN → 默认');
  assert.strictEqual(reg.resolveNumeric('KHY_GOAL_STOP_GATE_MAX', { KHY_GOAL_STOP_GATE_MAX: '0' }), 0, '0 合法');
});

test('未登记 name → 保守放行 true', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_TOTALLY_UNKNOWN', { KHY_TOTALLY_UNKNOWN: 'off' }), true);
});

test('自门控 isRegistryEnabled:默认开,仅 CANON 关', () => {
  assert.strictEqual(reg.isRegistryEnabled({}), true);
  assert.strictEqual(reg.isRegistryEnabled({ KHY_FLAG_REGISTRY: 'off' }), false);
  assert.strictEqual(reg.isRegistryEnabled({ KHY_FLAG_REGISTRY: 'no' }), false);
  assert.strictEqual(reg.isRegistryEnabled({ KHY_FLAG_REGISTRY: 'OFF' }), false, '归一大写');
  assert.strictEqual(reg.isRegistryEnabled({ KHY_FLAG_REGISTRY: 'true' }), true);
});

test('绝不抛:null/坏输入 → 安全默认', () => {
  assert.doesNotThrow(() => reg.isFlagEnabled('KHY_GOAL', null));
  assert.doesNotThrow(() => reg.isFlagEnabled(undefined, undefined));
  assert.doesNotThrow(() => reg.resolveNumeric('KHY_GOAL_STOP_GATE_MAX', null));
  assert.doesNotThrow(() => reg.listFlags());
  assert.strictEqual(reg.isFlagEnabled('KHY_GOAL', { KHY_GOAL: 123 }), true, '数值非关闭词 → 开');
});

test('listFlags 确定性升序 + 含 name', () => {
  const a = reg.listFlags();
  const b = reg.listFlags();
  assert.deepStrictEqual(a.map((f) => f.name), b.map((f) => f.name), '两次调用一致');
  const names = a.map((f) => f.name);
  assert.deepStrictEqual(names, [...names].sort(), '升序');
  assert.ok(names.includes('KHY_GOAL_STOP_GATE'));
});

// ── 逐字节等价 oracle(关键)─────────────────────────────────────────────
test('等价 oracle:KHY_GOAL_STOP_GATE(含父)== 原 goalStopGate.isEnabled', () => {
  for (const a of VALS) for (const b of VALS) {
    const env = {};
    if (a !== undefined) env.KHY_GOAL = a;
    if (b !== undefined) env.KHY_GOAL_STOP_GATE = b;
    const oracle = off4(env.KHY_GOAL) ? false : !off4(env.KHY_GOAL_STOP_GATE);
    assert.strictEqual(reg.isFlagEnabled('KHY_GOAL_STOP_GATE', env), oracle, JSON.stringify(env));
  }
});

test('等价 oracle:KHY_GOAL_AUTO_CLEAR == 原 !_off(...)', () => {
  for (const a of VALS) {
    const env = {};
    if (a !== undefined) env.KHY_GOAL_AUTO_CLEAR = a;
    assert.strictEqual(reg.isFlagEnabled('KHY_GOAL_AUTO_CLEAR', env), !off4(env.KHY_GOAL_AUTO_CLEAR), JSON.stringify(env));
  }
});

test('等价 oracle:KHY_GOAL_STOP_GATE_MAX == 原 resolveMaxRedrives', () => {
  for (const a of VALS.concat(['5', '10', '11', '-1', '2.7'])) {
    const env = {};
    if (a !== undefined) env.KHY_GOAL_STOP_GATE_MAX = a;
    const raw = env.KHY_GOAL_STOP_GATE_MAX;
    const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
    const oracle = (Number.isFinite(n) && n >= 0) ? Math.min(n, 10) : 1;
    assert.strictEqual(reg.resolveNumeric('KHY_GOAL_STOP_GATE_MAX', env), oracle, JSON.stringify(env));
  }
});

test('等价 oracle:KHY_TOOL_CONTRACT == 原 toolContractEnabled', () => {
  for (const a of VALS) {
    const env = {};
    if (a !== undefined) env.KHY_TOOL_CONTRACT = a;
    assert.strictEqual(reg.isFlagEnabled('KHY_TOOL_CONTRACT', env), oToolContract(env, 'KHY_TOOL_CONTRACT'), JSON.stringify(env));
  }
});

test('等价 oracle:KHY_TOOL_PARAM_AUDIT(父开时)== 原 paramAuditEnabled', () => {
  // 父开(不设 KHY_TOOL_CONTRACT)时,子谓词应逐字节等于原裸子查。
  for (const a of VALS) {
    const env = {};
    if (a !== undefined) env.KHY_TOOL_PARAM_AUDIT = a;
    assert.strictEqual(reg.isFlagEnabled('KHY_TOOL_PARAM_AUDIT', env), oToolContract(env, 'KHY_TOOL_PARAM_AUDIT'), JSON.stringify(env));
  }
});

test('等价 oracle:KHY_PLAN_PRIORITY == 原 priorityTaxonomy._flagOn(裸 ===,不归一)', () => {
  // 声明-only:证注册表 normalize:false 精确复现 quirk(OFF 大写读成开、no 不在词表读成开)。
  for (const a of VALS) {
    const env = {};
    if (a !== undefined) env.KHY_PLAN_PRIORITY = a;
    assert.strictEqual(reg.isFlagEnabled('KHY_PLAN_PRIORITY', env), oPlanBare(env, 'KHY_PLAN_PRIORITY'), JSON.stringify(env));
  }
  // 显式钉住 quirk:
  assert.strictEqual(reg.isFlagEnabled('KHY_PLAN_PRIORITY', { KHY_PLAN_PRIORITY: 'OFF' }), true, 'OFF 大写 → 开(不归一)');
  assert.strictEqual(reg.isFlagEnabled('KHY_PLAN_PRIORITY', { KHY_PLAN_PRIORITY: 'no' }), true, 'no 不在 MINIMAL → 开');
  assert.strictEqual(reg.isFlagEnabled('KHY_PLAN_PRIORITY', { KHY_PLAN_PRIORITY: 'off' }), false, 'off 小写 → 关');
});

test('等价 oracle:KHY_BUG_SEVERITY == 原 priorityTaxonomy._flagOn', () => {
  for (const a of VALS) {
    const env = {};
    if (a !== undefined) env.KHY_BUG_SEVERITY = a;
    assert.strictEqual(reg.isFlagEnabled('KHY_BUG_SEVERITY', env), oPlanBare(env, 'KHY_BUG_SEVERITY'), JSON.stringify(env));
  }
});

// MINIMAL_BARE 仅供文档参照(裸词表);上面的 oPlanBare 已覆盖其语义。
void MINIMAL_BARE;

// ── 磁盘分析 / shell timeout clamp 新 flag(0.1.104 批次)──────────────────────
test('新 flag:default-on 语义(缺省/CANON off 值)', () => {
  for (const name of ['KHY_SHELL_TIMEOUT_CLAMP', 'KHY_DISKANALYZE_TOOL',
    'KHY_DISKANALYZE_CATALOG', 'KHY_DISKANALYZE_REPORT']) {
    assert.strictEqual(reg.isFlagEnabled(name, {}), true, name + ' 缺省应开');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: '0' }), false, name + '=0 应关');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: 'off' }), false, name + '=off 应关');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: '1' }), true, name + '=1 应开');
  }
});

test('新 flag:父关 ⇒ 子恒关(KHY_DISKANALYZE_TOOL → catalog/report)', () => {
  const parentOff = { KHY_DISKANALYZE_TOOL: '0' };
  assert.strictEqual(reg.isFlagEnabled('KHY_DISKANALYZE_CATALOG', parentOff), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_DISKANALYZE_REPORT', parentOff), false);
  // 父开时子按自身默认(开)
  assert.strictEqual(reg.isFlagEnabled('KHY_DISKANALYZE_CATALOG', { KHY_DISKANALYZE_TOOL: '1' }), true);
});

test('新 flag:KHY_WEAK_MODEL_PROFILE_INJECT default-on + 父关(KHY_WEAK_MODEL_GUIDANCE)恒关', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_WEAK_MODEL_PROFILE_INJECT', {}), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_WEAK_MODEL_PROFILE_INJECT', { KHY_WEAK_MODEL_PROFILE_INJECT: '0' }), false);
  // 父门控关 → 子必关(profile 注入随之回退)
  assert.strictEqual(reg.isFlagEnabled('KHY_WEAK_MODEL_PROFILE_INJECT', { KHY_WEAK_MODEL_GUIDANCE: 'off' }), false);
  // 父开时子按自身默认(开)
  assert.strictEqual(reg.isFlagEnabled('KHY_WEAK_MODEL_PROFILE_INJECT', { KHY_WEAK_MODEL_GUIDANCE: '1' }), true);
});

test('新 flag:KHY_STDIN_UTF8_DECODE / KHY_TERMINAL_LAUNCH default-on(缺省/CANON off 值)', () => {
  for (const name of ['KHY_STDIN_UTF8_DECODE', 'KHY_TERMINAL_LAUNCH']) {
    assert.strictEqual(reg.isFlagEnabled(name, {}), true, name + ' 缺省应开');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: '0' }), false, name + '=0 应关');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: 'off' }), false, name + '=off 应关');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: ' OFF ' }), false, name + '=OFF 归一应关');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: '1' }), true, name + '=1 应开');
  }
});

test('新 flag:KHY_MODEL_VISION_BADGE default-on(缺省/CANON off 值)', () => {
  const name = 'KHY_MODEL_VISION_BADGE';
  assert.strictEqual(reg.isFlagEnabled(name, {}), true, name + ' 缺省应开');
  assert.strictEqual(reg.isFlagEnabled(name, { [name]: '0' }), false, name + '=0 应关');
  assert.strictEqual(reg.isFlagEnabled(name, { [name]: 'off' }), false, name + '=off 应关');
  assert.strictEqual(reg.isFlagEnabled(name, { [name]: ' OFF ' }), false, name + '=OFF 归一应关');
  assert.strictEqual(reg.isFlagEnabled(name, { [name]: '1' }), true, name + '=1 应开');
});

test('新 flag:KHY_VISION_FALLBACK_CASCADE default-on + 父关(KHY_VISION_DESCRIBE_RETURN)恒关', () => {
  const name = 'KHY_VISION_FALLBACK_CASCADE';
  assert.strictEqual(reg.isFlagEnabled(name, {}), true, name + ' 缺省应开');
  assert.strictEqual(reg.isFlagEnabled(name, { [name]: '0' }), false, name + '=0 应关');
  assert.strictEqual(reg.isFlagEnabled(name, { [name]: 'off' }), false, name + '=off 应关');
  assert.strictEqual(reg.isFlagEnabled(name, { [name]: ' OFF ' }), false, name + '=OFF 归一应关');
  assert.strictEqual(reg.isFlagEnabled(name, { [name]: '1' }), true, name + '=1 应开');
  // 父门控关(describe-and-return 关)→ 子必关:级联只在 describe-and-return 内生效
  assert.strictEqual(reg.isFlagEnabled(name, { KHY_VISION_DESCRIBE_RETURN: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled(name, { KHY_VISION_DESCRIBE_RETURN: 'off' }), false);
  // 父开时子按自身默认(开)
  assert.strictEqual(reg.isFlagEnabled(name, { KHY_VISION_DESCRIBE_RETURN: '1' }), true);
});

test('新 flag:numeric 默认值与 clamp', () => {
  assert.strictEqual(reg.resolveNumeric('KHY_DISKANALYZE_MIN_SIZE_MB', {}), 100);
  assert.strictEqual(reg.resolveNumeric('KHY_DISKANALYZE_OLD_INSTALLER_DAYS', {}), 180);
  assert.strictEqual(reg.resolveNumeric('KHY_DISKANALYZE_MAX_ENTRIES', {}), 200000);
  assert.strictEqual(reg.resolveNumeric('KHY_DISKANALYZE_HASH_MAX_FILES', {}), 2000);
  assert.strictEqual(reg.resolveNumeric('KHY_DISKANALYZE_HASH_MAX_FILE_MB', {}), 512);
  // env 覆盖
  assert.strictEqual(reg.resolveNumeric('KHY_DISKANALYZE_MIN_SIZE_MB', { KHY_DISKANALYZE_MIN_SIZE_MB: '250' }), 250);
  // 低于 min 被 clamp(MAX_ENTRIES min=1000)
  assert.strictEqual(reg.resolveNumeric('KHY_DISKANALYZE_MAX_ENTRIES', { KHY_DISKANALYZE_MAX_ENTRIES: '2' }), 1000);
});

// ── 更新包学习 UpstreamStudy 新 flag 家族 ─────────────────────────────────────
test('新 flag:UpstreamStudy default-on(缺省/CANON off 值)', () => {
  for (const name of ['KHY_UPSTREAM_STUDY_TOOL', 'KHY_UPSTREAM_STUDY_CATALOG', 'KHY_UPSTREAM_STUDY_REPORT', 'KHY_UPSTREAM_STUDY_PLAN']) {
    assert.strictEqual(reg.isFlagEnabled(name, {}), true, name + ' 缺省应开');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: '0' }), false, name + '=0 应关');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: 'off' }), false, name + '=off 应关');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: '1' }), true, name + '=1 应开');
  }
});

test('新 flag:UpstreamStudy 父关(TOOL)⇒ catalog/report/plan 恒关', () => {
  const parentOff = { KHY_UPSTREAM_STUDY_TOOL: '0' };
  assert.strictEqual(reg.isFlagEnabled('KHY_UPSTREAM_STUDY_CATALOG', parentOff), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_UPSTREAM_STUDY_REPORT', parentOff), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_UPSTREAM_STUDY_PLAN', parentOff), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_UPSTREAM_STUDY_CATALOG', { KHY_UPSTREAM_STUDY_TOOL: '1' }), true);
});

test('新 flag:UpstreamStudy numeric 默认值与覆盖', () => {
  assert.strictEqual(reg.resolveNumeric('KHY_UPSTREAM_STUDY_TOP', {}), 25);
  assert.strictEqual(reg.resolveNumeric('KHY_UPSTREAM_STUDY_MAX_FILE_KB', {}), 256);
  assert.strictEqual(reg.resolveNumeric('KHY_UPSTREAM_STUDY_BLOB_MB', {}), 5);
  assert.strictEqual(reg.resolveNumeric('KHY_UPSTREAM_STUDY_TOP', { KHY_UPSTREAM_STUDY_TOP: '10' }), 10);
  // 低于 min=1 被 clamp
  assert.strictEqual(reg.resolveNumeric('KHY_UPSTREAM_STUDY_TOP', { KHY_UPSTREAM_STUDY_TOP: '0' }), 1);
});

// ── 计划模式 CC 对齐(planModeDirective)新 flag ────────────────────────────────
test('新 flag:KHY_PLAN_CC_RESEARCH default-on(缺省/CANON off 值)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_PLAN_CC_RESEARCH', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_PLAN_CC_RESEARCH', { KHY_PLAN_CC_RESEARCH: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_PLAN_CC_RESEARCH', { KHY_PLAN_CC_RESEARCH: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_PLAN_CC_RESEARCH', { KHY_PLAN_CC_RESEARCH: '1' }), true);
});

// ── 代理管理订阅组(proxyNodeParse)新 flag ──────────────────────────────────────
test('新 flag:KHY_PROXY_SUBSCRIPTION default-on(缺省/CANON off 值)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_PROXY_SUBSCRIPTION', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_PROXY_SUBSCRIPTION', { KHY_PROXY_SUBSCRIPTION: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_PROXY_SUBSCRIPTION', { KHY_PROXY_SUBSCRIPTION: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_PROXY_SUBSCRIPTION', { KHY_PROXY_SUBSCRIPTION: '1' }), true);
});

test('新 flag:KHY_PROXY_SUB_USERINFO default-on + 父关(KHY_PROXY_SUBSCRIPTION=0)恒关', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_PROXY_SUB_USERINFO', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_PROXY_SUB_USERINFO', { KHY_PROXY_SUB_USERINFO: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_PROXY_SUB_USERINFO', { KHY_PROXY_SUB_USERINFO: 'off' }), false);
  // 父门关 ⇒ 子恒关(整个订阅特性关时不解析流量元信息)。
  assert.strictEqual(reg.isFlagEnabled('KHY_PROXY_SUB_USERINFO', { KHY_PROXY_SUBSCRIPTION: '0' }), false);
  // 父开时子按自身默认(开)。
  assert.strictEqual(reg.isFlagEnabled('KHY_PROXY_SUB_USERINFO', { KHY_PROXY_SUBSCRIPTION: '1' }), true);
});

// ── MarkText(muya)Markdown 工作台(md 命令)新 flag 家族 ─────────────────────────
test('新 flag:KHY_MD_* default-on(缺省/CANON off 值)', () => {
  for (const name of ['KHY_MD_EDITOR', 'KHY_MD_WYSIWYG', 'KHY_MD_AUTO_REGISTER', 'KHY_MD_AUTO_SHUTDOWN', 'KHY_MD_SIDEBAR_CURRENT_DIR']) {
    assert.strictEqual(reg.isFlagEnabled(name, {}), true, name + ' 缺省应开');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: '0' }), false, name + '=0 应关');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: 'off' }), false, name + '=off 应关');
    assert.strictEqual(reg.isFlagEnabled(name, { [name]: '1' }), true, name + '=1 应开');
  }
});

test('新 flag:KHY_MD 父关(KHY_MD_EDITOR)⇒ WYSIWYG/AUTO_REGISTER/AUTO_SHUTDOWN/SIDEBAR_CURRENT_DIR 恒关', () => {
  const parentOff = { KHY_MD_EDITOR: '0' };
  assert.strictEqual(reg.isFlagEnabled('KHY_MD_WYSIWYG', parentOff), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_MD_AUTO_REGISTER', parentOff), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_MD_AUTO_SHUTDOWN', parentOff), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_MD_SIDEBAR_CURRENT_DIR', parentOff), false);
  // 父开时子按自身默认(开)
  assert.strictEqual(reg.isFlagEnabled('KHY_MD_WYSIWYG', { KHY_MD_EDITOR: '1' }), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_MD_AUTO_REGISTER', { KHY_MD_EDITOR: '1' }), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_MD_AUTO_SHUTDOWN', { KHY_MD_EDITOR: '1' }), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_MD_SIDEBAR_CURRENT_DIR', { KHY_MD_EDITOR: '1' }), true);
});

// ── model_not_found(404）硬失败恢复指引(modelNotFoundRecovery)新 flag ──────────────
test('新 flag:KHY_MODEL_NOT_FOUND_RECOVERY default-on(缺省/CANON off 值)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_MODEL_NOT_FOUND_RECOVERY', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_MODEL_NOT_FOUND_RECOVERY', { KHY_MODEL_NOT_FOUND_RECOVERY: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_MODEL_NOT_FOUND_RECOVERY', { KHY_MODEL_NOT_FOUND_RECOVERY: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_MODEL_NOT_FOUND_RECOVERY', { KHY_MODEL_NOT_FOUND_RECOVERY: '1' }), true);
});

// ── 生成型号不当视觉输入(visionGenerationExclusion)新 flag ──────────────────────────
test('新 flag:KHY_VISION_GENERATION_EXCLUSION default-on(缺省/CANON off 值)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_GENERATION_EXCLUSION', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_GENERATION_EXCLUSION', { KHY_VISION_GENERATION_EXCLUSION: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_GENERATION_EXCLUSION', { KHY_VISION_GENERATION_EXCLUSION: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_GENERATION_EXCLUSION', { KHY_VISION_GENERATION_EXCLUSION: '1' }), true);
});

// ── 透明视觉 describe-and-return(visionDescribeReturn)新 flag ──────────────────────────
test('新 flag:KHY_VISION_DESCRIBE_RETURN default-on(缺省/CANON off 值)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_DESCRIBE_RETURN', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_DESCRIBE_RETURN', { KHY_VISION_DESCRIBE_RETURN: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_DESCRIBE_RETURN', { KHY_VISION_DESCRIBE_RETURN: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_DESCRIBE_RETURN', { KHY_VISION_DESCRIBE_RETURN: '1' }), true);
});

// ── 动作声称否定守卫(claimReconciler)新 flag ──────────────────────────
test('新 flag:KHY_CLAIM_NEGATION_GUARD default-on(缺省/CANON off 值)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_CLAIM_NEGATION_GUARD', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_CLAIM_NEGATION_GUARD', { KHY_CLAIM_NEGATION_GUARD: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_CLAIM_NEGATION_GUARD', { KHY_CLAIM_NEGATION_GUARD: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_CLAIM_NEGATION_GUARD', { KHY_CLAIM_NEGATION_GUARD: '1' }), true);
});
test('新 flag:KHY_ERROR_SOLUTION_ADVISOR default-on(缺省/CANON off 值)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_ERROR_SOLUTION_ADVISOR', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_ERROR_SOLUTION_ADVISOR', { KHY_ERROR_SOLUTION_ADVISOR: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_ERROR_SOLUTION_ADVISOR', { KHY_ERROR_SOLUTION_ADVISOR: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_ERROR_SOLUTION_ADVISOR', { KHY_ERROR_SOLUTION_ADVISOR: '1' }), true);
});

test('新 flag:KHY_FS_WALK_ASYNC default-on(缺省/CANON off 值)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_FS_WALK_ASYNC', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_FS_WALK_ASYNC', { KHY_FS_WALK_ASYNC: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_FS_WALK_ASYNC', { KHY_FS_WALK_ASYNC: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_FS_WALK_ASYNC', { KHY_FS_WALK_ASYNC: '1' }), true);
});

test('新 flag:KHY_DIAGNOSTIC_GROUNDING default-on(缺省/CANON off 值·parent 链)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_DIAGNOSTIC_GROUNDING', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_DIAGNOSTIC_GROUNDING', { KHY_DIAGNOSTIC_GROUNDING: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_DIAGNOSTIC_GROUNDING', { KHY_DIAGNOSTIC_GROUNDING: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_DIAGNOSTIC_GROUNDING', { KHY_DIAGNOSTIC_GROUNDING: '1' }), true);
  // parent 关 → 子强制关。
  assert.strictEqual(
    reg.isFlagEnabled('KHY_DIAGNOSTIC_GROUNDING', { KHY_WEAK_MODEL_GUIDANCE: 'off' }),
    false,
    'parent off 应强制子关',
  );
});

test('新 flag:KHY_VISION_EXHAUSTION_DIAG default-on + 父关(KHY_GLM_VISION_MODEL)恒关', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_EXHAUSTION_DIAG', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_EXHAUSTION_DIAG', { KHY_VISION_EXHAUSTION_DIAG: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_EXHAUSTION_DIAG', { KHY_VISION_EXHAUSTION_DIAG: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_VISION_EXHAUSTION_DIAG', { KHY_VISION_EXHAUSTION_DIAG: '1' }), true);
  // parent 关 → 子强制关(视觉耗尽诊断随 GLM 视觉门整体回退)。
  assert.strictEqual(
    reg.isFlagEnabled('KHY_VISION_EXHAUSTION_DIAG', { KHY_GLM_VISION_MODEL: 'off' }),
    false,
    'parent off 应强制子关',
  );
});

test('新 flag:KHY_ANSWER_ECHO_GUARD default-on(缺省/CANON off 值)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_ANSWER_ECHO_GUARD', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_ANSWER_ECHO_GUARD', { KHY_ANSWER_ECHO_GUARD: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_ANSWER_ECHO_GUARD', { KHY_ANSWER_ECHO_GUARD: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_ANSWER_ECHO_GUARD', { KHY_ANSWER_ECHO_GUARD: '1' }), true);
});

test('新 flag:KHY_SUPPRESS_SOFT_REDRIVE default-on + 父关(KHY_ANSWER_ECHO_GUARD)恒关', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_SUPPRESS_SOFT_REDRIVE', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_SUPPRESS_SOFT_REDRIVE', { KHY_SUPPRESS_SOFT_REDRIVE: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_SUPPRESS_SOFT_REDRIVE', { KHY_SUPPRESS_SOFT_REDRIVE: 'off' }), false);
  // parent 关 → 子强制关(软门抑制随回声守卫整体回退)。
  assert.strictEqual(reg.isFlagEnabled('KHY_SUPPRESS_SOFT_REDRIVE', { KHY_ANSWER_ECHO_GUARD: 'off' }), false, 'parent off 应强制子关');
  // 父开时子按自身默认(开)。
  assert.strictEqual(reg.isFlagEnabled('KHY_SUPPRESS_SOFT_REDRIVE', { KHY_ANSWER_ECHO_GUARD: '1' }), true);
});

test('新 flag:KHY_REPLY_DEDUP default-on(缺省/CANON off 值)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_REPLY_DEDUP', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_REPLY_DEDUP', { KHY_REPLY_DEDUP: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_REPLY_DEDUP', { KHY_REPLY_DEDUP: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_REPLY_DEDUP', { KHY_REPLY_DEDUP: 'no' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_REPLY_DEDUP', { KHY_REPLY_DEDUP: '1' }), true);
});

test('新 flag:KHY_SHORT_STOP_CONTINUATION opt-in(默认关·仅 true/1 开)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_SHORT_STOP_CONTINUATION', {}), false, '缺省应关(opt-in)');
  assert.strictEqual(reg.isFlagEnabled('KHY_SHORT_STOP_CONTINUATION', { KHY_SHORT_STOP_CONTINUATION: '1' }), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_SHORT_STOP_CONTINUATION', { KHY_SHORT_STOP_CONTINUATION: 'true' }), true);
  assert.strictEqual(reg.isFlagEnabled('KHY_SHORT_STOP_CONTINUATION', { KHY_SHORT_STOP_CONTINUATION: 'yes' }), false);
});

// ── 工作目录自动 git 化(workspaceGitInit)新 flag ────────────────────────────────
test('新 flag:KHY_AUTO_GIT_INIT default-on(缺省/CANON off 值)', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_AUTO_GIT_INIT', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_AUTO_GIT_INIT', { KHY_AUTO_GIT_INIT: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_AUTO_GIT_INIT', { KHY_AUTO_GIT_INIT: 'off' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_AUTO_GIT_INIT', { KHY_AUTO_GIT_INIT: 'no' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_AUTO_GIT_INIT', { KHY_AUTO_GIT_INIT: ' OFF ' }), false, '归一大写应关');
  assert.strictEqual(reg.isFlagEnabled('KHY_AUTO_GIT_INIT', { KHY_AUTO_GIT_INIT: '1' }), true);
});

test('新 flag:KHY_GIT_INIT_WIZARD default-on + 父关(KHY_AUTO_GIT_INIT)恒关', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_GIT_INIT_WIZARD', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_GIT_INIT_WIZARD', { KHY_GIT_INIT_WIZARD: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_GIT_INIT_WIZARD', { KHY_GIT_INIT_WIZARD: 'off' }), false);
  // 父门控关(整个自动 init 特性关)⇒ 向导无意义,子恒关。
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(reg.isFlagEnabled('KHY_GIT_INIT_WIZARD', { KHY_AUTO_GIT_INIT: v }), false, `parent=${v} 应强制子关`);
  }
  // 父开时子按自身默认(开)。
  assert.strictEqual(reg.isFlagEnabled('KHY_GIT_INIT_WIZARD', { KHY_AUTO_GIT_INIT: '1' }), true);
});

test('新 flag:KHY_GIT_INIT_FALLBACK_IDENTITY default-on + 祖辈链关恒关', () => {
  assert.strictEqual(reg.isFlagEnabled('KHY_GIT_INIT_FALLBACK_IDENTITY', {}), true, '缺省应开');
  assert.strictEqual(reg.isFlagEnabled('KHY_GIT_INIT_FALLBACK_IDENTITY', { KHY_GIT_INIT_FALLBACK_IDENTITY: '0' }), false);
  assert.strictEqual(reg.isFlagEnabled('KHY_GIT_INIT_FALLBACK_IDENTITY', { KHY_GIT_INIT_FALLBACK_IDENTITY: 'off' }), false);
  // 直接父门(wizard)关 ⇒ 恒关。
  assert.strictEqual(reg.isFlagEnabled('KHY_GIT_INIT_FALLBACK_IDENTITY', { KHY_GIT_INIT_WIZARD: 'off' }), false, 'wizard 关应强制关');
  // 祖父门(auto-init)关 ⇒ 经父链传导恒关(transitively)。
  assert.strictEqual(reg.isFlagEnabled('KHY_GIT_INIT_FALLBACK_IDENTITY', { KHY_AUTO_GIT_INIT: 'off' }), false, 'auto-init 关应经父链传导恒关');
  // 全链开 → 子按自身默认开。
  assert.strictEqual(reg.isFlagEnabled('KHY_GIT_INIT_FALLBACK_IDENTITY', { KHY_AUTO_GIT_INIT: '1', KHY_GIT_INIT_WIZARD: '1' }), true);
});
