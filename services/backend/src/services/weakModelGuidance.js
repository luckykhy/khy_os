'use strict';

// [AI-弱模型·照抄] 本文件是纯叶子:改动照 goalStopGate.js 的 isEnabled+decide 形状;接线照 toolUseLoop.js:4276 的 try/catch fail-soft。

/**
 * weakModelGuidance.js
 *
 * 「弱模型改 khyos 时,在哪个高危位置该看到什么护栏指令 + 照抄哪个范例」的**确定性引擎**(单一真源)。
 *
 * 诉求(goal 2026-07-06「绝对不信任 khy 以后使用的其他模型,尽你所能对 khyos 多处标注、多出
 * 示范引导,保证弱智模型的生成效果」):文档/skill 需要模型主动去读;本引擎把引导**下沉成可复算
 * 的代码**,让就地标注(散在源码里的 `[AI-弱模型·…]` 横幅)、工具出口(WeakModelGuidanceTool /
 * CommentGuidanceTool view)、coding profile 注入,**全部从同一份文案生成**——不各处散抄、不漂移。
 *
 * 纯叶子:无 I/O、无随机、无副作用。只返回结构化文案/判定;读文件、注入提示词等副作用留给上层
 * (工具 / profile 注入点)。
 *
 * 与既有件的关系(同「教学方法论 → 确定性引擎」族,正交):
 *  - commentGuidance —— 「什么地方写什么注释」;本件 —— 「什么高危位置放什么护栏 + 照抄哪个范例」。
 *  - 二者共享:纯叶子契约、buildXxxDirective(注入 coding profile)、被同一教学工具出口聚合。
 *
 * 设计要点:
 *  - **单一真源**:GUARD_SITES / WEAK_MODEL_EXEMPLARS 是所有护栏文案与示范的唯一来源;就地横幅经
 *    bannerFor() 取,保证源码里的横幅与工具返回的指令逐字一致,改一处即全处生效。
 *  - **示范优先**:每个位点都带 exemplar 指针(照抄哪个文件:行);另有 WEAK_MODEL_EXEMPLARS 一批
 *    「BAD→GOOD→WHY」成对反例——弱模型「照着改」比「读规则」更可靠,且这些反例专治死循环
 *    (超时重试、无输出重跑、手写全盘扫描、未登记门控)。
 *  - **门控 + 逐字节回退**:KHY_WEAK_MODEL_GUIDANCE 关闭时,注入/工具出口回退到「无本引擎」的旧行为;
 *    就地横幅是静态注释,不受门控影响(注释永远在,不会因门控关而消失)。
 */

// ── env 门控 ─────────────────────────────────────────────────────────
// 委托 flagRegistry 单一声明式真源;注册表自门控(KHY_FLAG_REGISTRY)关时,逐字节回退到本文件
// 私有 _off 手写判定(CANON 4 词 + 归一)。此模式照抄自 goalStopGate.js。
const flagRegistry = require('./flagRegistry');
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _off(v) {
  return v !== undefined && _FALSY.has(String(v).trim().toLowerCase());
}

/**
 * 弱模型引导是否启用(默认开,仅显式 0/false/off/no 关闭)。
 * 委托 flagRegistry('KHY_WEAK_MODEL_GUIDANCE');注册表关时回退 `!_off(KHY_WEAK_MODEL_GUIDANCE)`。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    if (flagRegistry.isRegistryEnabled(e)) {
      return flagRegistry.isFlagEnabled('KHY_WEAK_MODEL_GUIDANCE', e);
    }
  } catch { /* 注册表异常 → 回退手写判定 */ }
  return !_off(e.KHY_WEAK_MODEL_GUIDANCE);
}

// HOW-TO-EXTEND (给本引擎加一条护栏/反例/刻意设计 — 照抄,别改既有条目):
//   本文件维护三份冻结注册表,扩展都是「追加一个 Object.freeze({...}) 条目」,既有条目逐字不动;
//   工具出口(WeakModelGuidance / CommentGuidance)与 coding profile 注入会自动带出新条目。
//   1. 加一个高危位点护栏 → 往 GUARD_SITES 追加一个键:
//        '<kebab-key>': Object.freeze({ title, where, danger, directive, exemplar })
//      (bannerFor()/listGuardSites() 自动生效;别在别处散抄横幅正文。)
//   2. 加一条「反例→正例」死循环示范 → 往 WEAK_MODEL_EXEMPLARS 追加:
//        Object.freeze({ id, topic, bad, good, why })   // 英文寄存器,与既有同风格
//   3. 加一条「看似 bug 实为刻意设计」 → 往 INTENTIONAL_DESIGNS 追加:
//        Object.freeze({ id, looksLikeBug, actualDesign, where, why })
//      WHERE 必须指向现场源码注释(依据在那,不编造);别把证伪不了的当设计登记。
//   4. 验证:  node --test services/backend/src/services/__tests__/weakModelGuidance.test.js
//   全部保持纯叶子:零 IO、确定性、绝不抛(坏输入返安全默认)、门控 KHY_WEAK_MODEL_GUIDANCE 关时逐字节回退。
//
// ── 高危位点护栏(单一真源)────────────────────────────────────────────────────
// 每个位点:where(在哪) / danger(弱模型最容易在此犯什么错) / directive(就地指令,做横幅正文)
//          / exemplar(照抄哪个文件:行)。
const GUARD_SITES = Object.freeze({
  'tool-funnel': Object.freeze({
    title: '唯一工具执行漏斗',
    where: 'services/backend/src/services/toolCalling.js 的 executeTool()',
    danger: '在权限链中间早 return、加旁路、或另起一个绕过 executeTool 的执行入口',
    directive: '这里是所有工具调用的唯一漏斗,权限判定是有序 fail-closed 链。绝不早 return 跳过后续闸;'
      + '绝不另开旁路执行工具。要加能力→加在链末尾且默认 fail-closed。',
    exemplar: '既有闸的写法见同文件 3063-3481 的各 _check* 块',
  }),
  'pretooluse-hardfloor': Object.freeze({
    title: 'PreToolUse 硬底(绕不过)',
    where: 'toolCalling.js executeTool 内 PreToolUse hooks 块',
    danger: '在硬底前早 return、改 alreadyHooked 戳使钩子不触发、或放宽 KHY_PRETOOL_HOOKS kill-switch',
    directive: '钩子在所有权限闸之前、无条件运行(即便 bypass/危险模式也绕不过)——这是 CC 对齐的不变量。'
      + '勿在此块前 return,勿改 alreadyHooked 戳逻辑,勿放宽其 kill-switch。',
    exemplar: '本块自带的中文注释即权威说明,勿删勿改其语义',
  }),
  'exec-approved-stamp': Object.freeze({
    title: 'EXEC_APPROVED 审批戳',
    where: 'toolCalling.js 的 syscall 审批网关',
    danger: '在别处伪造/预置 EXEC_APPROVED 戳,使调用跳过 requestPermission',
    directive: '此戳是「已通过中央审批」的不可伪造凭据,只应由审批网关盖。'
      + '绝不在别处设此戳来跳过 requestPermission。',
    exemplar: '盖戳处见网关内 stamp 写入行;消费处见 requestPermission 前的戳检查',
  }),
  'flag-registry': Object.freeze({
    title: 'KHY_* 门控注册表',
    where: 'services/backend/src/services/flagRegistry.js 的 FLAGS 对象',
    danger: '新门控不登记、方言不一致、忘了 parent 父子优先级',
    directive: '新增 KHY_* 门控作为 FLAGS 的一个新键,形状 '
      + '`{ mode:\'default-on\', off:\'CANON\', default:true[, parent:\'KHY_父\'] }`。'
      + '父门控关→子门控必关,用 parent 声明。',
    exemplar: '照抄 KHY_GOAL / KHY_GOAL_STOP_GATE(带 parent)那几行',
  }),
  'leaf-authoring': Object.freeze({
    title: '纯叶子写法',
    where: '新增业务判定逻辑时',
    danger: '把逻辑直接塞进大文件、抛异常、做 IO、忘门控',
    directive: '新逻辑写成纯叶子:零 IO、确定性、绝不抛(坏输入返安全默认)、可单测、经 KHY_* 门控(默认开)。',
    exemplar: '照抄 services/backend/src/services/goalStopGate.js 的 isEnabled + decide 形状',
  }),
  'wiring': Object.freeze({
    title: '叶子接线(判定在叶子,这里只做 IO)',
    where: '在真实入口消费纯叶子时',
    danger: '把判定逻辑写进接线处、不加 try/catch、叶子异常冒泡阻断主流程',
    directive: '接线处只做 IO:require 叶子→isEnabled 门控检查→取叶子裁决→落地。'
      + '整块 try/catch,叶子异常 fail-soft 回退旧行为,绝不因叶子出错阻断交付。',
    exemplar: '照抄 services/backend/src/services/toolUseLoop.js 的 4276-4311 接线块',
  }),
  'tool-description': Object.freeze({
    title: '工具对模型的自述(prompt)',
    where: 'services/backend/src/tools/<Tool>/index.js 的 prompt() 与 inputSchema.description',
    danger: '描述含糊致弱模型误用:参数拼错、包代码块、一次调太多',
    directive: 'prompt() 用简明祈使句说清用途/参数/边界;参数 description 逐个写清。'
      + '弱模型调工具要点:参数照 schema、别把 JSON 包在代码块里、一次一步。',
    exemplar: '照抄 services/backend/src/tools/GrepTool/index.js 的 prompt() 与 inputSchema',
  }),
});

// ── 弱模型高频错误的「反例→正例」成对示范(单一真源)──────────────────────────────
// 弱模型「照着改」比「读规则」更可靠;这批 exemplar 专治**死循环与低质生成**:每条 = 一个真实
// 高频错误(bad)+ 正确做法(good)+ 为什么这么做能跳出循环/提质(why)。BAD/GOOD 都写得足够具体,
// 让弱模型能直接对照自己的行为。英文寄存器,与 buildWeakModelDirective 同风格(同注入 coding profile)。
const WEAK_MODEL_EXEMPLARS = Object.freeze([
  Object.freeze({
    id: 'retry-timeout',
    topic: 'A shell command timed out',
    bad: 'Retry the SAME command with a bigger timeout (e.g. timeout=600000) to "get past" the 60s cap.',
    good: 'Read the error. The 60s idle cap catches commands that produce no output (e.g. a silent full-disk scan). Change the command (narrow scope, add progress output) or use the right tool. timeout is clamped to 60000 anyway — raising it does nothing.',
    why: 'A bigger timeout never fixes a command that emits no output; the identical retry just loops until the iteration budget is gone.',
  }),
  Object.freeze({
    id: 'repeat-after-no-output',
    topic: 'A tool returned nothing useful',
    bad: 'Call the exact same tool with the exact same params again, and again.',
    good: 'Stop after the first empty/failed repeat. Answer with what you already have, or change approach (different tool, different query, ask the user). The loop detector will force tools off and block you around 3–8 repeats regardless.',
    why: 'Identical retries cannot produce new information; they only burn iterations and trip the death-loop guards.',
  }),
  Object.freeze({
    id: 'handwrite-disk-scan',
    topic: 'Find large / old / duplicate files',
    bad: 'Hand-write `powershell Get-ChildItem -Recurse`, `dir /s`, `find /`, or a `du` loop.',
    good: 'Use the DiskAnalyze tool — it is bounded (wall-clock + entry caps + hash caps), read-only, and cross-platform.',
    why: 'A silent full-disk recursion produces no output for minutes, gets killed by the idle timeout, and then you loop on the retry.',
  }),
  Object.freeze({
    id: 'edit-before-read',
    topic: 'Editing a file',
    bad: 'Call Edit/Write on a file you have not Read this session, guessing old_string.',
    good: 'Read the file first, then Edit with an old_string copied verbatim from what you read (include enough surrounding lines to be unique).',
    why: 'The harness rejects edits to unread files, and a guessed old_string loops on "no match found".',
  }),
  Object.freeze({
    id: 'unregistered-gate',
    topic: 'Adding a new KHY_* feature flag',
    bad: 'Add `if (process.env.KHY_MY_FEATURE) { ... }` and ship it.',
    good: 'Register KHY_MY_FEATURE in flagRegistry.js FLAGS first — `{ mode:\'default-on\', off:\'CANON\', default:true[, parent:\'KHY_PARENT\'] }` — then gate via flagRegistry.isFlagEnabled.',
    why: 'Unregistered flags are conservatively treated as ON, so your off-switch silently does nothing and the byte-revert guarantee is lost.',
  }),
  Object.freeze({
    id: 'logic-in-wiring',
    topic: 'Adding new decision logic',
    bad: 'Inline the logic at the hot call site, no gate, no try/catch — and let it throw on bad input.',
    good: 'Decision → a pure leaf (zero IO, deterministic, never throws, byte-revert when gated off). Wiring → require + isEnabled + try/catch fail-soft. Copy goalStopGate.js and toolUseLoop.js:4276-4311.',
    why: 'A throwing leaf at a hot call site aborts real work; the fail-soft wiring keeps delivery even when the leaf misbehaves.',
  }),
  Object.freeze({
    id: 'no-verify',
    topic: 'A guard is red',
    bad: 'Pass `--no-verify` (or disable the guard) to force the commit through.',
    good: 'A red guard is a real problem. Fix the code until node --check / check:leaf-contract / check:change-safety pass on their own.',
    why: 'Bypassing a guard ships exactly the breakage the guard exists to catch.',
  }),
]);

// ── 「看似 bug,实为刻意设计」清单(单一真源)────────────────────────────────────────
// 六轮 ultra-review 里,弱模型与审查报告反复把 khyos 的**刻意设计**当成 CRITICAL bug「修掉」,
// 结果制造回归或噪音(见记忆 project_ultrareview_reports_triage_farewell)。这些设计的现场注释
// 早已写清「为什么这样是对的」,但只在本文件可见——审查报告扫的是别处快照/已装副本时就看不到。
// 本清单把它们**上收成一份可被工具查询的单一真源**:任何模型/审查在「修」这些点之前,先查
// `WeakModelGuidance view='intentional'`(或此处)自证,不再重蹈覆辙。
// 每条 = looksLikeBug(乍看像什么错)+ actualDesign(其实是什么设计)+ where(现场,注释权威在此)
//        + why(为什么改成「看起来对」的样子反而会坏事)。全部**有据**:where 指向的源码注释即依据,不编造。
// 英文寄存器,与 WEAK_MODEL_EXEMPLARS 同风格(同注入 coding profile)。
const INTENTIONAL_DESIGNS = Object.freeze([
  Object.freeze({
    id: 'export-not-password-gated',
    looksLikeBug: 'verifyExportPassword(_password) just `return true` — the password check is broken / a backdoor.',
    actualDesign: 'Model export is deliberately no longer password-gated. The function is kept only so existing call sites and the public export stay stable; it ignores its argument and never rejects, by design.',
    where: 'services/backend/src/services/modelTrainingService.js :: verifyExportPassword (see its doc comment)',
    why: 'Deleting the function or "fixing" it to reject would break every call site and the export contract; the always-true is the intended behavior, documented in place.',
  }),
  Object.freeze({
    id: 'default-source-secret',
    looksLikeBug: "DEFAULT_SOURCE_SECRET = 'khy2026' is a hardcoded secret / leaked password.",
    actualDesign: 'It is an intentional public default passphrase, not a real secret. Source snapshot publish/restore is no longer password-gated: the build embeds the snapshot under this fixed key so `khy restore` decrypts automatically. An explicit KHY_SOURCE_PUBLISH_SECRET / --secret still overrides it.',
    where: 'services/backend/src/services/sourceSnapshotCrypto.js :: DEFAULT_SOURCE_SECRET (see the block comment above it)',
    why: 'This is anti-mis-propagation packaging, not cryptographic protection. Removing it or treating it as a leaked credential would break automatic restore of already-published snapshots.',
  }),
  Object.freeze({
    id: 'dynamic-version',
    looksLikeBug: 'platform/khy_platform/__init__.py has no literal `__version__ = "x.y.z"` — the version looks missing / unset.',
    actualDesign: '__version__ is resolved at runtime via _detect_version() from the authoritative pyproject.toml. Hardcoding a literal is deliberately avoided.',
    where: 'platform/khy_platform/__init__.py :: _detect_version() / __version__',
    why: 'scripts/ci/check-version-sync.js ENFORCES the no-hardcode rule: pinning a literal here makes the CI version-sync gate fail on purpose. The three authoritative sources are pyproject.toml / packaging/npm/package.json / services/backend/package.json.',
  }),
  Object.freeze({
    id: 'snapshot-sha256-blank',
    looksLikeBug: 'Proxy-core ASSETS all have `sha256: null` — the integrity check is missing / unfinished.',
    actualDesign: 'The blank fingerprint is intentional. A pre-baked WRONG sha256 would make auto-install fail permanently and silently; leaving it null degrades to HTTPS transport-level integrity from the official pinned GitHub release URL.',
    where: 'services/backend/src/services/proxy/proxyCoreInstaller.js :: ASSETS (see the `sha256:null` comment above the table)',
    why: 'Filling in a guessed/placeholder hash is worse than none — it turns a working download into a permanent silent failure. Integrity comes from the pinned HTTPS release path.',
  }),
  Object.freeze({
    id: 'cron-default-enqueue',
    looksLikeBug: '_defaultEnqueue just forwards the prompt text — the scheduled job has "no real closed loop" (e.g. a backtest never actually runs).',
    actualDesign: 'It routes the fired prompt INTO the agent as a follow-up turn. Executing the work (tool calls, backtests, etc.) is the agent\'s job, not something the scheduler hardcodes.',
    where: 'services/backend/src/jobs/cronScheduler.js :: _defaultEnqueue (see its doc comment)',
    why: 'This is agent-architecture by design. "Fixing" it to hardcode a specific pipeline in the scheduler would duplicate and freeze what the agent is supposed to decide dynamically.',
  }),
  Object.freeze({
    id: 'env-path-forest',
    looksLikeBug: "resolveGatewayEnvPaths uses `../../.env` and `../../../.env` — the relative depths look off / like a path bug.",
    actualDesign: 'The depths are correct for the forest layout: from src/utils, `../../.env` resolves to services/backend/.env (canonical) and `../../../.env` to services/.env (repo mirror). Consumers keep their local binding so call sites stay byte-identical.',
    where: 'services/backend/src/utils/resolveGatewayEnvPaths.js (see the file-head block + inline comments)',
    why: 'The compensation is deliberate depth-matching across the forest, not an error. Changing either path silently writes .env to the wrong place.',
  }),
]);

/**
 * 取某高危位点的就地横幅正文(单行,供源码注释与工具出口同源引用)。
 * 未知 key 返回空串(纯叶子:坏输入返安全默认,绝不抛)。
 * @param {string} siteKey
 * @returns {string}
 */
function bannerFor(siteKey) {
  const site = GUARD_SITES[String(siteKey || '')];
  if (!site) return '';
  return `[AI-弱模型] ${site.title}:${site.directive}(示范:${site.exemplar})`;
}
/**
 * 构建注入「编码 profile」的弱模型引导指令(确定性,英文寄存器,与 buildCommentGuidanceDirective 同风格)。
 * @returns {string}
 */
function buildWeakModelDirective() {
  return [
    '## Editing Khy-OS: guardrails for weaker/untrusted models',
    'You are not trusted by default. Before editing, obey these in-repo invariants:',
    '- **One tool funnel** — all tool calls go through executeTool() in toolCalling.js. Never add a bypass path, never early-return past its ordered fail-closed permission chain.',
    '- **PreToolUse hooks are a hard floor** — they run before every permission gate, even under bypass mode. Never short-circuit them.',
    '- **Add behavior as a pure leaf + a default-on KHY_* gate** — zero IO, deterministic, never throws (bad input → safe default), byte-revert when the gate is off. Copy the shape of goalStopGate.js.',
    '- **Wire leaves with try/catch fail-soft** — the decision lives in the leaf; the wiring site only does IO and must never break delivery on a leaf error. Copy toolUseLoop.js:4276-4311.',
    '- **Register every new gate** in flagRegistry.js FLAGS, in the `{ mode, off, default[, parent] }` shape; parent-off forces child-off.',
    '- **Never `--no-verify`** past the guards; a red guard means a real problem.',
    'When unsure what guardrail applies to the spot you are editing, call the WeakModelGuidance tool (or CommentGuidance view="weak-model") — it returns the exact directive + which file to copy.',
  ].join('\n');
}

/**
 * 单句「弱模型调工具要点」,供各工具 prompt() 末尾追加(与 GUARD_SITES['tool-description'] 同源要点)。
 * @returns {string}
 */
function toolCallHint() {
  return '弱模型调用要点:参数严格按 schema(别拼错/别改名)、别把 JSON 参数包进代码块、一次一步、拿不准先只读确认再动手。';
}

/**
 * 构建注入「编码 profile」的弱模型「反例→正例」示范块(确定性,英文寄存器)。
 * 门控 KHY_WEAK_MODEL_GUIDANCE 关时返回空串(逐字节回退:profile 不含该段)。
 * @param {object} [env]
 * @returns {string}
 */
function buildWeakModelExemplars(env) {
  try {
    if (!isEnabled(env)) return '';
    const lines = ['## Common weak-model mistakes in Khy-OS (BAD → GOOD)'];
    WEAK_MODEL_EXEMPLARS.forEach((ex, i) => {
      lines.push(`${i + 1}. ${ex.topic}`);
      lines.push(`   - BAD: ${ex.bad}`);
      lines.push(`   - GOOD: ${ex.good}`);
      lines.push(`   - WHY: ${ex.why}`);
    });
    return lines.join('\n');
  } catch {
    return ''; // 纯叶子:异常 → 安全默认(空串),绝不抛
  }
}

/**
 * 列出所有高危位点(供工具出口枚举)。返回浅拷贝数组,元素为冻结对象。
 * @returns {Array<object>}
 */
function listGuardSites() {
  return Object.entries(GUARD_SITES).map(([key, v]) => ({ key, ...v }));
}

/**
 * 构建注入「编码 profile」的「看似 bug,实为刻意设计」清单块(确定性,英文寄存器)。
 * 门控 KHY_WEAK_MODEL_GUIDANCE 关时返回空串(逐字节回退:profile 不含该段)。
 * @param {object} [env]
 * @returns {string}
 */
function buildIntentionalDesigns(env) {
  try {
    if (!isEnabled(env)) return '';
    const lines = ['## Looks-like-a-bug but INTENTIONAL in Khy-OS (do NOT "fix" these)'];
    INTENTIONAL_DESIGNS.forEach((d, i) => {
      lines.push(`${i + 1}. ${d.id}`);
      lines.push(`   - LOOKS-LIKE-BUG: ${d.looksLikeBug}`);
      lines.push(`   - BY-DESIGN: ${d.actualDesign}`);
      lines.push(`   - WHERE: ${d.where}`);
      lines.push(`   - WHY: ${d.why}`);
    });
    return lines.join('\n');
  } catch {
    return ''; // 纯叶子:异常 → 安全默认(空串),绝不抛
  }
}

/**
 * 列出所有「看似 bug 实为刻意设计」条目(供工具出口枚举)。返回浅拷贝数组,元素为冻结对象。
 * @returns {Array<object>}
 */
function listIntentionalDesigns() {
  return INTENTIONAL_DESIGNS.map(d => ({ ...d }));
}

module.exports = {
  GUARD_SITES,
  WEAK_MODEL_EXEMPLARS,
  INTENTIONAL_DESIGNS,
  isEnabled,
  bannerFor,
  buildWeakModelDirective,
  buildWeakModelExemplars,
  buildIntentionalDesigns,
  toolCallHint,
  listGuardSites,
  listIntentionalDesigns,
};
