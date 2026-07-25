'use strict';

/**
 * changeWatchService — 「khy 被改动时不一声不吭」的**后台常驻 watcher**(薄 IO 编排器,非纯叶子)。
 *
 * 职责:常驻后台,周期性侦测**其它 AI / 人**对 khy 源码的改动,对改动集跑既有机器校验
 *   (node --check 语法闸 + leafContractGuard / modelHardcodingGuard 守卫),把结果交给纯叶子
 *   changeWatchVerdict 判出「对 / 不对 / 无法判断」,并把主动反馈话术落盘成一条 verdict 记录,
 *   供 `khy verdict` 展示、供 cli/ai.js 在下一轮注入给 AI —— 让 khyos 主动开口,而不是沉默。
 *
 * 为什么是薄 IO 而判定在叶子:本族纪律是「IO 集中一处、判定收进可单元测试的叶子模块」。本文件只做副作用
 *   (git diff 侦测 / 读文件 / 落盘 / 定时器),所有「什么算改动、对不对、说什么、要不要开口」的
 *   判定都委托给 changeWatchVerdict 叶子;校验本身复用自修复子系统的 selfRepair/primitives
 *   .validateFiles —— **绝不另写一套语法/守卫校验**,与 selfRepairTransaction 共用同一真源。
 *
 * 与自修复事务的区别:selfRepair 在「khy 改**自己**」后决定 keep/回滚;本 watcher 在「**别人**
 *   改了 khy」后**只观察 + 反馈**,从不回滚别人的工作树(观察者,不是裁决执行者)。
 *
 * 依赖注入:create({ projectDir, io, validator, verdict, store, logger }) —— 默认绑定真实
 *   git/fs/primitives,测试可注入假实现,使 checkOnce 全程无真实 IO 可被确定性单测。
 *
 * 门控:KHY_CHANGE_WATCH(常驻总开关,默认开,{0,false,off,no} 关)。叶子判定另有
 *   KHY_CHANGE_WATCH_VERDICT(默认开)。关任一即静默。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const verdictLeaf = require('./changeWatchVerdict');

const OFF = ['0', 'false', 'off', 'no'];
const DEFAULT_INTERVAL_MS = 15000;
const MAX_FILES = 80;

// 落盘反馈契约版本 —— 外部 AI 工具按此版本号识别 schema(向后兼容时递增)。公开契约,勿轻改字段名。
const SCHEMA_VERSION = 'khy-change-watch/1';
// khyos 自身的所有内部交付通道(cli/ai.js 系统提示缝 + 原生 PrePrompt 钩子)共用同一个消费者 ID,
// 故同一轮内不会重复注入;每个**外部 AI 工具**应使用各自独立的 consumerId,从而各自恰好拿到一次。
const INTERNAL_CONSUMER = 'khy-internal';

/**
 * 算一条记录「已被哪些消费者取走」的集合。多消费者交付保证的真源:
 *   - 新版记录用 `ackedBy` 数组(每个 consumerId 对当前 verdict 签名恰好确认一次);
 *   - 兼容旧版:只有 `consumed:true` 的老记录视为内部消费者已取走。
 * @returns {string[]}
 */
function _acksOf(rec) {
  if (rec && Array.isArray(rec.ackedBy)) return rec.ackedBy.slice();
  return rec && rec.consumed === true ? [INTERNAL_CONSUMER] : [];
}

/** 常驻总开关(与叶子门控独立;关闭即不启动 watcher)。 */
function isWatchEnabled(env = process.env) {
  const raw = env && env.KHY_CHANGE_WATCH;
  if (raw == null) return true;
  return !OFF.includes(String(raw).trim().toLowerCase());
}

function _intervalMs(env = process.env) {
  const raw = Number(env && env.KHY_CHANGE_WATCH_INTERVAL_MS);
  if (Number.isFinite(raw) && raw >= 2000 && raw <= 600000) return Math.floor(raw);
  return DEFAULT_INTERVAL_MS;
}

// ── 默认 IO 实现(真实 git / fs)──────────────────────────────────────────────
function _git(args, cwd) {
  return spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** 是否把 projectDir 锚定到 git 仓库顶层(默认开;{0,false,off,no} 关 → 用原始 cwd,逐字节回退)。 */
function _repoRootAnchorEnabled(env = process.env) {
  const raw = env && env.KHY_CHANGE_WATCH_REPO_ROOT;
  if (raw == null) return true;
  return !OFF.includes(String(raw).trim().toLowerCase());
}

/**
 * 把起始目录解析到其 git 仓库顶层(`git rev-parse --show-toplevel`)。这是本 watcher 路径
 * 解析的**正确锚点**:git 输出的改动路径是**仓根相对**的,而全链(本文件 statSync 签名 +
 * selfRepair/primitives 的 node --check 与 `path.join(projectDir,'services','backend')`)都以
 * 「projectDir === 仓库顶层」为前提。khy 从子目录(如 services/backend)运行时若不锚定,每个
 * 仓根相对文件都解析到不存在路径 → 校验全失败 → 误报「改动校验未通过」。非 git / 探测失败 → null。
 * @param {string} dir
 * @returns {string|null}
 */
function _repoTopLevel(dir) {
  try {
    const r = _git(['rev-parse', '--show-toplevel'], dir);
    if (r && r.status === 0) {
      const top = String(r.stdout || '').trim();
      if (top) return top;
    }
  } catch { /* fail-soft */ }
  return null;
}

/**
 * 解析 watcher 的 projectDir:门控开且能探到 git 顶层 → 用顶层;否则(门控关 / 非 git /
 * 探测失败)→ 原样返回 dir(逐字节回退到今日行为)。
 * @param {string} dir
 * @param {object} [env]
 * @returns {string}
 */
function _anchorToRepoRoot(dir, env = process.env) {
  if (!_repoRootAnchorEnabled(env)) return dir;
  const top = _repoTopLevel(dir);
  return top || dir;
}

/** 是否把「守卫自测夹具」排除出改动校验集(默认开;{0,false,off,no} 关 → 不排除,逐字节回退)。 */
function _guardFixtureExclusionEnabled(env = process.env) {
  const raw = env && env.KHY_CHANGE_WATCH_SKIP_GUARD_FIXTURES;
  if (raw == null) return true;
  return !OFF.includes(String(raw).trim().toLowerCase());
}

/**
 * repoRel 是否为**守卫自身的自测夹具**(`scripts/tests/<name>.test.js`)。这些夹具**按设计**
 * 内含违规样本(「叶子」夹具里的 IO、硬编码模型名等)充当测试数据,守卫独立运行时会把它们当
 * 作**已知永久基线**报出、全项目一贯忽略。change-watch 是唯一把这些基线「违规」误当成「你刚才
 * 那次改动的真实回归」的消费者:任何分支只要有一个此类夹具处于 WIP,verdict 就会被这几条固定
 * 失败永久钉死成 incorrect,进而每轮向模型注入「你上次改动不对、先修好它」的强制指令 —— 即便
 * 被驱动的是强模型也会被劫持偏航。故校验前把它们从 validatable 剔除(移入 skipped 诚实计数)。
 * @param {string} repoRel  仓根相对路径
 * @returns {boolean}
 */
function _isGuardSelfTestFixture(repoRel) {
  const norm = String(repoRel || '').split(path.sep).join('/');
  return /(^|\/)scripts\/tests\/[^/]+\.test\.js$/.test(norm);
}

/**
 * 是否启用「自基线以来的增量归因」(默认开;{0,false,off,no} 关 → 归因整棵脏树,逐字节回退)。
 *
 * 修的病:`git diff` 侦测到的是**整棵累积 WIP 脏树**(本分支历次会话攒下的所有未提交文件,可达
 * 数百个),旧逻辑把它们**全部**当成「你刚才那次改动」灌进校验与 [SYSTEM:] 指令——任一文件里
 * 有真回归,就会把「你上次改动不对、先修好」误扣到一整棵与本轮无关的树上,劫持模型偏航。
 * 正确语义:watcher 首次观察到的脏树 = **既存基线**(在它开始盯之前就在,不归因给任何人);
 * 只有**自基线以来新增 / 内容变化**的文件才是「刚发生的改动」,才该被归因与校验。
 */
function _deltaAttributionEnabled(env = process.env) {
  const raw = env && env.KHY_CHANGE_WATCH_DELTA_ATTRIBUTION;
  if (raw == null) return true;
  return !OFF.includes(String(raw).trim().toLowerCase());
}

/**
 * 侦测当前工作树里被改动的 khy 源文件(tracked 改动 + staged + untracked),并算一个内容签名。
 * 签名变化即代表「有人又改了」。非 git 仓库 → 空集(watcher 静默不报错)。
 * @returns {{files:string[], signature:string}}
 */
function _defaultDetectChanges(projectDir) {
  const inside = _git(['rev-parse', '--is-inside-work-tree'], projectDir);
  if (inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
    return { files: [], signature: '' };
  }
  const set = new Set();
  const collect = (args, splitNul) => {
    const r = _git(args, projectDir);
    if (r.status !== 0) return;
    const out = String(r.stdout || '');
    for (const raw of splitNul ? out.split('\0') : out.split('\n')) {
      const f = raw.trim();
      if (f) set.add(f);
    }
  };
  collect(['diff', '--name-only'], false);
  collect(['diff', '--name-only', '--cached'], false);
  collect(['ls-files', '--others', '--exclude-standard'], false);

  const files = [...set];
  // 内容签名:path:mtimeMs:size,排序后哈希。确定性反映「文件是否又变了」。
  // 同时产出**逐文件**签名映射 fileSigs(path → "mtime:size"),供 checkOnce 做「自基线以来的
  // 增量归因」——只把**真正变化的那部分**当作「你刚才那次改动」,而非整棵累积 WIP 脏树。
  const parts = [];
  const fileSigs = {};
  for (const f of files.sort()) {
    try {
      const st = fs.statSync(path.resolve(projectDir, f));
      const per = `${Math.floor(st.mtimeMs)}:${st.size}`;
      parts.push(`${f}:${per}`);
      fileSigs[f] = per;
    } catch {
      parts.push(`${f}:gone`);
      fileSigs[f] = 'gone';
    }
  }
  const signature = parts.length
    ? crypto.createHash('sha1').update(parts.join('\n')).digest('hex')
    : '';
  return { files, signature, fileSigs };
}

/**
 * 工厂:绑定一组(可注入的)IO 依赖,返回 watcher 实例。
 * @param {Object} [deps]
 * @param {string} [deps.projectDir]
 * @param {(projectDir:string)=>{files:string[],signature:string}} [deps.detectChanges]
 * @param {(files:string[], plan:Object)=>{syntax,guards,tests}} [deps.validate]
 * @param {{write:(rec)=>void, read:()=>Object|null}} [deps.store]
 * @param {(feedback:{verdict,directive,display,files})=>void} [deps.onFeedback]
 * @param {(msg:string)=>void} [deps.logger]
 * @param {Object} [deps.env]
 */
function create(deps = {}) {
  const env = deps.env || process.env;
  // projectDir 必须是**仓库顶层**(下游 git 改动集与 primitives 校验都以此为前提)。显式注入
  // (测试 / 特定调用方)原样尊重;仅对自动解析的 cwd 做「锚定到 git 顶层」修正,门控可关。
  const projectDir = deps.projectDir || _anchorToRepoRoot(env.KHYQUANT_CWD || process.cwd(), env);
  const detectChanges = deps.detectChanges || ((dir) => _defaultDetectChanges(dir));
  const validate =
    deps.validate ||
    ((files, plan) => {
      // 复用自修复子系统的真实校验原语,绝不另写语法/守卫闸。
      const primitives = require('./selfRepair/primitives');
      const inst = primitives.create({ projectDir });
      return inst.validateFiles(files, plan);
    });
  const store = deps.store || _defaultStore(projectDir);
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};
  const onFeedback = typeof deps.onFeedback === 'function' ? deps.onFeedback : null;

  let _lastDetectSig = null; // 上次侦测到的工作树签名(变了才重新校验)
  let _lastSpokenSig = null; // 上次已「开口播报」的 verdict 签名(去抖)
  let _baselineSigs = null;  // 逐文件基线映射(path→"mtime:size");delta 归因的参照系,跨进程从落盘 detectBaseline 恢复
  let _timer = null;

  /**
   * 跑一次:侦测改动 → 校验 → 判定 → (变化时)落盘 + 反馈。fail-soft,绝不抛。
   * 异步:底层 validateFiles(primitives)是异步的(spawn node --check),必须 await,否则把未
   * 兑现的 Promise 当 validation 传给叶子会一律判「correct」(Promise 是真值且无 syntax/guards)。
   * @returns {Promise<{changed:boolean, verdict?:Object, spoke?:boolean}>}
   */
  async function checkOnce() {
    if (!isWatchEnabled(env) || !verdictLeaf.isEnabled(env)) return { changed: false };
    let detected;
    try {
      detected = detectChanges(projectDir);
    } catch (e) {
      logger(`change-watch detect error: ${e && e.message}`);
      return { changed: false };
    }
    const files = Array.isArray(detected && detected.files) ? detected.files : [];
    const sig = String((detected && detected.signature) || '');

    // 工作树没变(或本就干净)→ 无新改动,不重复校验。
    if (sig === '' ) { _lastDetectSig = sig; return { changed: false }; }
    if (sig === _lastDetectSig) return { changed: false };

    // 跨进程去重(关键性能闸):一次性 CLI 是全新进程,内存 _lastDetectSig 为空,否则每轮对话
    // 都会对整个脏树重跑 node --check(脏树可达数十文件 → 数十次子进程 spawn,拖慢每次 LLM 调用)。
    // 若落盘记录的 detectSignature 已等于当前工作树签名,说明这棵树早已被(daemon 或上次调用)
    // 校验过 → 直接复用,不重算;未消费的判定仍会被 ai.js 读出并注入。
    if (_lastDetectSig === null) {
      let prev = null;
      try { prev = store.read(); } catch { prev = null; }
      if (prev && prev.detectSignature === sig) {
        _lastDetectSig = sig;
        if (prev.consumed === true) _lastSpokenSig = prev.signature;
        return { changed: false };
      }
    }
    _lastDetectSig = sig;

    // ── 自基线以来的增量归因(修「整棵累积 WIP 脏树全归因你刚才那次改动」)────────────────
    // 参照系 = 上次观察时的逐文件签名基线;只有相对基线**新增 / 变化**的文件才算「刚发生的改动」。
    // 首次观察(无基线)→ 整棵脏树是既存 WIP,建立基线并**保持沉默**(不归因、不校验、不注入)。
    let attributedFiles = files;                 // 门关 / 无 fileSigs → 归因整棵脏树(逐字节回退)
    const curSigs = detected && detected.fileSigs && typeof detected.fileSigs === 'object'
      ? detected.fileSigs
      : null;
    const deltaOn = _deltaAttributionEnabled(env) && !!curSigs;
    if (deltaOn) {
      let baseline = _baselineSigs;
      if (baseline === null) {                   // 全新进程 → 从落盘 detectBaseline 恢复参照系
        try {
          const prev = store.read();
          baseline = prev && prev.detectBaseline && typeof prev.detectBaseline === 'object'
            ? prev.detectBaseline
            : null;
        } catch { baseline = null; }
      }
      // 首次观察无参照 → 整棵脏树都视为既存(attributedFiles=[]);否则取「签名与基线不同」的子集。
      attributedFiles = baseline === null
        ? []
        : files.filter((f) => curSigs[f] !== baseline[f]);
      _baselineSigs = curSigs;                   // 基线推进到当前态
      if (attributedFiles.length === 0) {
        // 自基线以来无任何**新增/变化**(首次观察,或仅有文件被移出脏树)→ 推进基线并沉默。
        const baselineRecord = {
          schemaVersion: SCHEMA_VERSION,
          verdict: 'uncertain',
          reason: baseline === null ? 'baseline-established' : 'baseline-advanced',
          failures: [], warnings: [], files: [], skipped: [],
          directive: '', display: '', text: '',
          signature: '',                         // 无 verdict 可播报 → 不注入
          detectSignature: sig,
          detectBaseline: curSigs,
          ackedBy: [INTERNAL_CONSUMER],
          consumed: true,                        // 视为已消费 → 永不注入
        };
        try { store.write(baselineRecord); }
        catch (e) { logger(`change-watch persist error: ${e && e.message}`); }
        return { changed: false, baseline: baselineRecord.reason };
      }
    }

    const cls = verdictLeaf.classifyChangedFiles(attributedFiles, { maxFiles: MAX_FILES });
    let validatable = cls.validatable;
    let skipped = cls.skipped;
    // 守卫自测夹具的「违规」是设计基线、非本次回归 → 剔出校验集(门关则原样,逐字节回退)。
    if (_guardFixtureExclusionEnabled(env)) {
      const fixtures = validatable.filter(_isGuardSelfTestFixture);
      if (fixtures.length) {
        validatable = validatable.filter((f) => !_isGuardSelfTestFixture(f));
        skipped = skipped.concat(fixtures);
      }
    }

    let validation = null;
    if (validatable.length > 0) {
      try {
        validation = await validate(validatable, { runSyntax: true, runGuards: true, runTests: false });
      } catch (e) {
        logger(`change-watch validate error: ${e && e.message}`);
        validation = null; // → uncertain
      }
    } else {
      // 改动里没有可校验源文件(纯文档 / 二进制)→ 让叶子判 uncertain(nothing-checked)。
      validation = { syntax: [], guards: [] };
    }

    const verdict = verdictLeaf.classifyVerdict(validation, { checkedCount: validatable.length });
    const feedback = verdictLeaf.buildVerdictFeedback(verdict, { files: validatable });
    const spoke = verdictLeaf.shouldSpeak(_lastSpokenSig, verdict);

    const record = {
      // ── 公开反馈契约(外部 AI 工具按 schemaVersion 读取并使用)──────────────
      schemaVersion: SCHEMA_VERSION,
      verdict: verdict.verdict,
      reason: verdict.reason,
      failures: verdict.failures,
      warnings: verdict.warnings,
      files: validatable,
      skipped,
      directive: feedback.directive,   // 命令式 [SYSTEM:] 指令,直接注入 AI 提示词
      display: feedback.display,        // 人/工具可读的纯文本反馈
      text: feedback.display,           // 稳定别名:任何工具可逐字采用的反馈文本
      signature: verdictLeaf.verdictSignature(verdict),
      detectSignature: sig, // 工作树内容签名,供跨进程去重(同一棵树不重复校验)

      // 多消费者交付:每个消费者(khyos 内部 / 各外部工具)对本签名恰好确认一次。
      // 新记录初始为空 → 所有消费者都「待取」。consumed 为兼容旧读取者的镜像。
      ackedBy: spoke ? [] : [INTERNAL_CONSUMER],
      consumed: !spoke,
    };
    // delta 模式:把基线随本次判定一并推进(供跨进程下次增量归因);门关时不加字段 → 逐字节回退。
    if (deltaOn) record.detectBaseline = curSigs;

    try {
      store.write(record);
    } catch (e) {
      logger(`change-watch persist error: ${e && e.message}`);
    }

    if (spoke) {
      _lastSpokenSig = record.signature;
      logger(`change-watch: ${verdict.verdict} — ${feedback.display.split('\n')[0]}`);
      if (onFeedback) {
        try { onFeedback({ verdict: verdict.verdict, directive: feedback.directive, display: feedback.display, files: validatable }); }
        catch (e) { logger(`change-watch onFeedback error: ${e && e.message}`); }
      }
    }

    return { changed: true, verdict, spoke };
  }

  async function start(opts = {}) {
    if (_timer) return { started: false, reason: 'already-running' };
    if (!isWatchEnabled(env)) return { started: false, reason: 'disabled' };
    const ms = Number.isFinite(opts.intervalMs) ? Math.max(2000, Math.floor(opts.intervalMs)) : _intervalMs(env);
    // 启动即跑一次(立刻反映启动前已发生的改动),再定时。
    await checkOnce().catch(() => {});
    _timer = setInterval(() => { Promise.resolve(checkOnce()).catch(() => {}); }, ms);
    if (_timer && typeof _timer.unref === 'function') _timer.unref();
    logger(`change-watch started (interval=${ms}ms, dir=${projectDir})`);
    return { started: true, intervalMs: ms };
  }

  function stop() {
    if (!_timer) return { stopped: false };
    clearInterval(_timer);
    _timer = null;
    return { stopped: true };
  }

  function getLatestVerdict() {
    try { return store.read(); } catch { return null; }
  }

  /** 标记最新记录已被某 AI 消费(注入过),避免重复灌。返回是否成功。 */
  function markConsumed() {
    try {
      const rec = store.read();
      if (!rec) return false;
      rec.consumed = true;
      store.write(rec);
      return true;
    } catch { return false; }
  }

  /** 把一条记录投影成对外反馈对象(公开契约字段)。 */
  function _projectFeedback(rec) {
    const directive = String((rec && rec.directive) || '').trim();
    return {
      schemaVersion: (rec && rec.schemaVersion) || SCHEMA_VERSION,
      verdict: rec && rec.verdict,
      reason: rec && rec.reason,
      directive,
      display: String((rec && rec.display) || ''),
      text: String((rec && (rec.text || rec.display)) || directive),
      files: Array.isArray(rec && rec.files) ? rec.files : [],
      failures: Array.isArray(rec && rec.failures) ? rec.failures : [],
      warnings: Array.isArray(rec && rec.warnings) ? rec.warnings : [],
    };
  }

  /**
   * 偷看(peek):返回某消费者「尚待取走」的反馈,但**不**确认/不改盘。供 `--peek` 与诊断用。
   * @param {string} [consumerId]
   * @returns {Object|null}
   */
  function pendingFor(consumerId = INTERNAL_CONSUMER) {
    if (!isWatchEnabled(env) || !verdictLeaf.isEnabled(env)) return null;
    const cid = String(consumerId || INTERNAL_CONSUMER).trim() || INTERNAL_CONSUMER;
    let rec = null;
    try { rec = store.read(); } catch { rec = null; }
    if (!rec) return null;
    const directive = String(rec.directive || '').trim();
    if (!directive) return null;
    if (_acksOf(rec).includes(cid)) return null;
    return _projectFeedback(rec);
  }

  /**
   * 取出一条某消费者「尚未取走」的待注入反馈,**原子地对该消费者确认**并返回 —— 这是**代码级、
   * 完全不依赖 AI** 的反馈取数原语:纯读盘 + 置位,**不跑校验、不调用任何 LLM**,话术早已由纯叶子
   * changeWatchVerdict 确定性产好。
   *
   * **多消费者交付保证**:按 `consumerId` 各自记账(`ackedBy`),khyos 内部通道共用 `khy-internal`
   * 故同一轮不重复注入;每个外部 AI 工具用各自 ID → 对同一判定**各自恰好拿到一次**。这正是「确保
   * 其他 ai 工具或 khyos 自己读取时都能正确拿到」的机制。门控关 / 无记录 / 已被该消费者取走 /
   * 无指令 → null(静默)。
   * @param {string} [consumerId]  消费者标识(默认 khyos 内部)
   * @returns {Object|null}
   */
  function consumePendingInjection(consumerId = INTERNAL_CONSUMER) {
    if (!isWatchEnabled(env) || !verdictLeaf.isEnabled(env)) return null;
    const cid = String(consumerId || INTERNAL_CONSUMER).trim() || INTERNAL_CONSUMER;
    let rec = null;
    try { rec = store.read(); } catch { rec = null; }
    if (!rec) return null;
    const directive = String(rec.directive || '').trim();
    if (!directive) return null;
    const acks = _acksOf(rec);
    if (acks.includes(cid)) return null;
    acks.push(cid);
    rec.ackedBy = acks;
    if (cid === INTERNAL_CONSUMER) rec.consumed = true; // 兼容旧读取者(ai.js / 渲染器)的镜像
    try { store.write(rec); } catch { /* best-effort,落盘失败不影响本次注入 */ }
    _lastSpokenSig = rec.signature || _lastSpokenSig;
    return _projectFeedback(rec);
  }

  return {
    checkOnce, start, stop, getLatestVerdict, markConsumed,
    consumePendingInjection, pendingFor,
    getStorePath: () => (typeof store.path === 'function' ? store.path() : null),
    _projectDir: projectDir,
  };
}

// ── 默认落盘 store(<dataHome>/change-watch/verdict.json)─────────────────────
function _defaultStore(projectDir) {
  let dir = null;
  function _dir() {
    if (dir) return dir;
    let base;
    try { base = require('../utils/dataHome').getDataHome(); }
    catch { base = path.join(require('os').homedir(), '.khyos'); }
    dir = path.join(base, 'change-watch');
    return dir;
  }
  return {
    write(rec) {
      const d = _dir();
      fs.mkdirSync(d, { recursive: true });
      const tmp = path.join(d, 'verdict.json.tmp');
      const dst = path.join(d, 'verdict.json');
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
      fs.renameSync(tmp, dst);
    },
    read() {
      const dst = path.join(_dir(), 'verdict.json');
      if (!fs.existsSync(dst)) return null;
      return JSON.parse(fs.readFileSync(dst, 'utf8'));
    },
    // 公开契约路径:外部 AI 工具可直接定位并读取这份反馈(<dataHome>/change-watch/verdict.json)。
    path() { return path.join(_dir(), 'verdict.json'); },
  };
}

/**
 * 造一个 `PrePrompt` 钩子处理器:把一条待注入反馈作为 `additionalContext` 注入到下一轮提示词里。
 *
 * 这是「代码级、不依赖 AI 的主动反馈」落到 khyos **原生钩子生命周期**上的出口 —— 不同于 cli/ai.js
 * 那条专用系统提示缝,本钩子让任何走 toolUseLoop 的路径(不止聊天入口)都能在 PrePrompt 处被动收到
 * 反馈;内容是 changeWatchVerdict 确定性产好的,**全程零 LLM**。失败一律 fail-soft 放行,绝不挡 AI 管线。
 *
 * @param {() => ({directive:string}|null)} [consume]  取数原语(默认走单例 consumePendingInjection),可注入测试。
 * @returns {(context?:Object)=>Promise<{action:'modify'|'allow', additionalContext?:string}>}
 */
function makePrePromptInjector(consume) {
  const take = typeof consume === 'function' ? consume : () => _instance().consumePendingInjection();
  return async function changeWatchInjector() {
    try {
      const pending = take();
      if (pending && pending.directive) {
        return { action: 'modify', additionalContext: String(pending.directive) };
      }
    } catch { /* fail-soft:反馈通道故障绝不挡 AI 管线 */ }
    return { action: 'allow' };
  };
}

// ── 模块级单例(daemon / CLI 用同一实例)──────────────────────────────────────
let _singleton = null;
function _instance() {
  if (!_singleton) _singleton = create();
  return _singleton;
}

module.exports = {
  isWatchEnabled,
  _repoRootAnchorEnabled,
  _guardFixtureExclusionEnabled,
  _isGuardSelfTestFixture,
  _deltaAttributionEnabled,
  create,
  makePrePromptInjector,
  SCHEMA_VERSION,
  INTERNAL_CONSUMER,
  // 单例转发(供 daemon 常驻 + CLI 查询用同一实例)
  start: (opts) => _instance().start(opts),
  stop: () => _instance().stop(),
  checkOnce: () => _instance().checkOnce(),
  getLatestVerdict: () => _instance().getLatestVerdict(),
  markConsumed: () => _instance().markConsumed(),
  consumePendingInjection: (consumerId) => _instance().consumePendingInjection(consumerId),
  pendingFor: (consumerId) => _instance().pendingFor(consumerId),
  getStorePath: () => _instance().getStorePath(),
};
