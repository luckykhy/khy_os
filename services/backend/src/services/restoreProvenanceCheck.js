'use strict';

/**
 * 还原「来源可溯性 / restore-provenance」运行时把关 —— bundled 运行时纯叶子（零 IO · 绝不抛）。
 *
 * ── 补的缺口：把 restore-provenance 的诊断能力接进运行时 restore 横幅 ──────────────
 * 快照头（snapshot.json）由 makeSourceSnapshot.js 忠实记录这份快照是**怎么捕获**的：
 *   captureMode:         'working-tree'（默认）| 'head'   ← 从工作树打包，还是从某个提交 archive
 *   includesUncommitted: true | false                    ← 是否含未提交改动（tracked 改动 + untracked）
 *   dirty:               true | false                    ← 捕获时工作树是否脏
 *   gitCommit:           '<sha>'                          ← 捕获时 HEAD 所在提交
 * dev 侧早已写好纯叶 `scripts/lib/restoreProvenance.js`（assessRestoreProvenance）能据此裁决
 * 「这份还原源码到底等于哪个 git 状态」，但它**只被 dev CLI 消费**（scripts/restore-provenance.js /
 * restore-effect-probe.js），**从未接进运行时还原路径**。运行时 `handleRestore` 的成功横幅
 * **只打印 gitCommit**（"共 N 个文件 · commit 44a491fb · 目录布局原样"），**从不读
 * captureMode / includesUncommitted / dirty**——grep 这三个字段在整个运行时还原代码里零消费者
 * = 死字段（断桥）。后果对陌生机器上的维护者最毒：
 *   · 真实 shipped 快照**默认就是脏捕获**（captureMode='working-tree' · includesUncommitted=true）——
 *     还原出来的源码 = 提交 44a491fb **加上未提交增量**，**不等于** 44a491fb 这个干净提交。
 *   · 但维护者只看到横幅那句「commit 44a491fb · 目录布局原样」→ 合理地误判「我还原的就是
 *     44a491fb」→ 拿它去 `git diff 44a491fb` 看到一堆幻影差异、或把它当成「发布的那份代码」——
 *     全错，因为它比那个提交多了未提交的活儿。
 * 本叶把这条缺失的**横幅期**消费者接上线：把「这份还原源码到底等于哪个 git 状态」从一句会误导的
 * 「commit X」，变成一次诚实的裁决 + 一行诚实的横幅提示。
 *
 * ── 和已接线的三层还原诊断正交（别混淆）──────────────────────────────────────────
 *   · restorePreflightCheck（解密**前**）：外层信封 format + 加密套件——「本机解不解得开密文」。
 *   · restoreArchiveExtractCheck（解密后、解包**前**）：内层归档形制 plaintextFormat/layout——
 *     「本机 tar -xzf 认不认识这团归档」。
 *   · restoreCompletenessCheck（解包**后**）：磁盘落地文件数 vs 快照 fileCount——「文件数量对不对」。
 *   · 本叶（还原成功、打**横幅**时）：captureMode/includesUncommitted/dirty——「这份源码等于哪个
 *     git 状态、是不是干净提交」。四者读的字段完全不重叠，覆盖还原路径四个不同阶段。
 *
 * ── 怎么判：来源诚实门（最保守优先 · 没有正面证据绝不谎称 clean）──────────────────
 * assessRestoreProvenance(header) 纯函数，绝不抛。header = 解析好的 snapshot.json 对象。
 *   1) header 非对象 / 数组                                → unverifiable（无从判断来源）。
 *   2) 无 gitCommit（非串 / 空）                           → no-provenance（没记录任何提交，无从溯源）。
 *   3) 脏捕获（includesUncommitted===true 或 dirty===true）→ dirty（== 提交 X + 未提交增量，不等于干净提交）。
 *   4) 有正面 clean 证据（HEAD 归档，或 working-tree 且 includesUncommitted===false）→ clean（== 提交 X）。
 *   5) 其余（有提交、非脏、但拿不到正面 clean 证据）        → indeterminate（保守：不臆断 clean）。
 * ok===true **仅当** status==='clean'——维护者可以放心把它当成「就是那个提交」。dirty / indeterminate /
 * no-provenance / unverifiable 都 ok:false，提醒「这份源码不等于一个干净提交，别当发布快照用」。
 *
 * ── 横幅渲染：buildProvenanceBannerLine(verdict) → {line, severity} | null ─────────
 * 把裁决翻成一行给运行时 restore 横幅：dirty→severity:'warn'（printWarn 诚实告警）；
 * clean/indeterminate/no-provenance→severity:'info'（printInfo 附注）；unverifiable / 裁决畸形→null
 * （不打行，横幅字节等价旧行为）。渲染是纯函数、可单测，严重度路由留给 publish.js。
 *
 * ── 恒久红线（继承还原家族）──────────────────────────────────────────────────────
 * · 没有正面 clean 证据绝不谎称 clean：任何脏 / 不确定 / 缺来源 → ok:false，诚实披露。
 * · 只披露不阻拦：dirty 是**合法且完整**的还原（内容一字不缺），只是不等于干净提交——本层把
 *   「静默误导」变成「诚实标注」，绝不改变还原本身的成败、绝不 markFailure。
 * · 纯计算、零 IO、无时钟、无随机、绝不抛：任何字段缺失 / 非法 → 保守（unverifiable / indeterminate）。
 *   只读来源字符串，绝不碰任何密钥。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────────────
 * 新增一档来源判定时：按**保守优先**插进 assessRestoreProvenance 判定链正确位置（越像「不该说
 * clean」越靠前），在下方 STATUS_* 常量表登记它的 status 名，并在 _BANNER_SEVERITY 表登记它的横幅
 * 严重度。ok 的定义只有一个出口 _verdict——status==='clean' 才 ok:true，别在别处放行。若
 * makeSourceSnapshot 新增来源字段（如 branch / tag），在此消费它、丰富 reason，别让它成为下一个死字段。
 * 本叶逻辑须与 dev 叶 scripts/lib/restoreProvenance.js 的判定链保持一致（同一诚实标准的两处实现）。
 */

// 单一裁决的状态枚举（新增判定档时在此登记）。
const STATUS_CLEAN = 'clean';                 // 可证等于某个干净提交：最强档，可当「就是那个提交」。
const STATUS_DIRTY = 'dirty';                 // == 提交 X + 未提交增量：合法完整还原，但不等于干净提交。
const STATUS_INDETERMINATE = 'indeterminate'; // 有提交、非脏，但无正面 clean 证据：保守不臆断。
const STATUS_NO_PROVENANCE = 'no-provenance'; // 没记录任何提交：无从溯源。
const STATUS_UNVERIFIABLE = 'unverifiable';   // 头缺失 / 非对象：无从判断来源。

// 横幅严重度：dirty 值得诚实告警，其余可披露的档是附注，证据不足则不打行（字节等价）。
const _BANNER_SEVERITY = {
  [STATUS_DIRTY]: 'warn',
  [STATUS_CLEAN]: 'info',
  [STATUS_INDETERMINATE]: 'info',
  [STATUS_NO_PROVENANCE]: 'info',
  [STATUS_UNVERIFIABLE]: 'none',
};

/** 非空字符串判定。 */
function _isNonEmptyStr(x) {
  return typeof x === 'string' && x.length > 0;
}

/**
 * 唯一构造裁决的出口：ok 只在 status==='clean' 时为真。红线只需在此一处把守。
 */
function _verdict(status, header, reason) {
  const h = (header && typeof header === 'object' && !Array.isArray(header)) ? header : {};
  const commit = _isNonEmptyStr(h.gitCommit) ? h.gitCommit : null;
  return {
    status,
    ok: status === STATUS_CLEAN,
    gitCommit: commit,
    shortCommit: commit ? commit.slice(0, 12) : null,
    captureMode: _isNonEmptyStr(h.captureMode) ? h.captureMode : null,
    includesUncommitted: typeof h.includesUncommitted === 'boolean' ? h.includesUncommitted : null,
    version: _isNonEmptyStr(h.version) ? h.version : null,
    reason: String(reason || ''),
  };
}

/**
 * 判定一份还原源码（由其 snapshot.json 头描述）到底对应哪个 git 状态。绝不抛。
 * 逻辑镜像 dev 叶 scripts/lib/restoreProvenance.js（同一诚实标准的运行时实现）。
 *
 * @param {object} header  解析好的 snapshot.json 对象
 * @returns {{status:string, ok:boolean, gitCommit:(string|null), shortCommit:(string|null),
 *            captureMode:(string|null), includesUncommitted:(boolean|null), version:(string|null),
 *            reason:string}}
 */
function assessRestoreProvenance(header) {
  try {
    // 1) 证据不足：头非对象（含 null / 数组 / 标量）。无从判断来源，绝不臆断 clean。
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      return _verdict(STATUS_UNVERIFIABLE, header,
        '缺快照头（snapshot.json 缺失 / 非对象）：无从判断这份还原源码的 git 来源');
    }

    // 2) 没记录任何提交：无从溯源。
    if (!_isNonEmptyStr(header.gitCommit)) {
      return _verdict(STATUS_NO_PROVENANCE, header,
        '快照头未记录 gitCommit：无从把这份还原源码溯源到任何提交');
    }

    const short = header.gitCommit.slice(0, 12);

    // 3) 脏捕获（最需要诚实披露的档）：含未提交改动 → 不等于干净提交。
    const isDirty = header.includesUncommitted === true || header.dirty === true;
    if (isDirty) {
      return _verdict(STATUS_DIRTY, header,
        `这份还原源码 = 提交 ${short} 加上未提交增量（脏捕获），不等于 ${short} 这个干净提交：`
        + `别当作「发布的那份代码」，git diff ${short} 会显示这些未提交改动`);
    }

    // 4) 有正面 clean 证据：HEAD 归档天然干净，或 working-tree 且明确 includesUncommitted===false。
    //    注：makeSourceSnapshot 的 head 模式记 includesUncommitted=false，故大小写差异不影响此档判定。
    const cleanEvidence =
      header.captureMode === 'HEAD' ||
      header.captureMode === 'head' ||
      header.includesUncommitted === false;
    if (cleanEvidence) {
      return _verdict(STATUS_CLEAN, header,
        `这份还原源码可证等于干净提交 ${short}（`
        + ((header.captureMode === 'HEAD' || header.captureMode === 'head') ? '从提交归档' : 'working-tree 捕获且无未提交改动')
        + '）：可放心当作「就是那个提交」');
    }

    // 5) 有提交、非脏，但拿不到正面 clean 证据（如 working-tree 模式而 includesUncommitted 未记录）：
    //    保守，不臆断 clean。
    return _verdict(STATUS_INDETERMINATE, header,
      `记录了提交 ${short} 且未标记为脏，但缺少正面「无未提交改动」证据（`
      + `captureMode=${header.captureMode || '?'} · includesUncommitted 未记录）：保守起见不断言等于干净提交`);
  } catch {
    return _verdict(STATUS_UNVERIFIABLE, null, '把关异常：无从判断来源，保守不臆断 clean');
  }
}

/**
 * 把来源裁决翻成一行运行时 restore 横幅提示。绝不抛。
 *   · dirty          → {severity:'warn', line}（printWarn 诚实告警：不等于干净提交）
 *   · clean          → {severity:'info', line}（printInfo 附注：等于干净提交）
 *   · indeterminate  → {severity:'info', line}（printInfo 附注：保守不断言）
 *   · no-provenance  → {severity:'info', line}（printInfo 附注：无从溯源）
 *   · unverifiable / 裁决畸形 → null（不打行，横幅字节等价旧行为）
 *
 * @param {object} verdict  assessRestoreProvenance 的返回值
 * @returns {({severity:string, line:string}|null)}
 */
function buildProvenanceBannerLine(verdict) {
  try {
    if (!verdict || typeof verdict !== 'object') return null;
    const status = verdict.status;
    const severity = _BANNER_SEVERITY[status] || 'none';
    if (severity === 'none') return null;

    const short = _isNonEmptyStr(verdict.shortCommit) ? verdict.shortCommit : null;

    let line;
    if (status === STATUS_DIRTY) {
      const s = short || '(未知提交)';
      line = `来源：这份源码 = 提交 ${s} + 未提交增量（脏捕获），不等于干净提交 ${s}；`
        + `勿当作「发布的那份代码」（git diff ${s} 会显示这些改动）`;
    } else if (status === STATUS_CLEAN) {
      line = `来源：可证等于干净提交 ${short || '(未知提交)'}（可放心当作「就是那个提交」）`;
    } else if (status === STATUS_INDETERMINATE) {
      line = `来源：记录提交 ${short || '(未知)'} 但缺正面「无未提交改动」证据，保守起见不断言等于干净提交`;
    } else if (status === STATUS_NO_PROVENANCE) {
      line = '来源：快照未记录 gitCommit，无从把这份源码溯源到任何提交';
    } else {
      return null;
    }
    return { severity, line };
  } catch {
    return null;
  }
}

module.exports = {
  assessRestoreProvenance,
  buildProvenanceBannerLine,
  STATUS_CLEAN,
  STATUS_DIRTY,
  STATUS_INDETERMINATE,
  STATUS_NO_PROVENANCE,
  STATUS_UNVERIFIABLE,
  _verdict,
  _isNonEmptyStr,
  _BANNER_SEVERITY,
};
