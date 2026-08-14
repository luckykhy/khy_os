'use strict';

/**
 * restoreProvenance.js — 还原「来源可溯性 / restore-provenance」纯叶子（零 IO · 绝不抛）
 *
 * 还原家族第十四层，闭合一条**来源诚实性断桥（dirty-capture passed off as a clean commit）**，
 * 直击用户「完整的简单的还原」——「完整」不只是文件数量对（095）、格式看得懂（105），还包括
 * **诚实地告诉维护者：你还原出来的这份源码，到底对应哪个 git 状态**。
 *
 * ── 它补的缺口：captureMode / includesUncommitted 是死字段 ─────────────────────────
 * 快照构建期 makeSourceSnapshot.js 忠实记录了这份快照是**怎么捕获**的：
 *   captureMode:        'working-tree' | 'HEAD'   ← 从工作树打包，还是从某个提交 archive
 *   includesUncommitted: true | false             ← 是否含未提交改动（tracked 改动 + untracked）
 *   dirty:               true | false             ← 捕获时工作树是否脏
 *   gitCommit:          '<sha>'                    ← 捕获时 HEAD 所在提交
 * 这些随 pip/npm 包送到陌生机器。但还原侧 cli/handlers/publish.js 的成功横幅**只打印 gitCommit**
 * （"commit 44a491fb · 目录布局原样"），**从不读 includesUncommitted / captureMode**——
 * `grep includesUncommitted` / `grep captureMode` 在还原代码里零消费者。后果对维护者最毒：
 *   · 真实 shipped 快照就是**脏捕获**（captureMode='working-tree' · includesUncommitted=true）——
 *     还原出来的源码 = 提交 44a491fb **加上未提交增量**，**不等于** 44a491fb 这个干净提交。
 *   · 但维护者在陌生机器上只看到横幅那句「commit 44a491fb · 目录布局原样」→ 合理地误判
 *     「我还原的就是 44a491fb」→ 拿它去 `git diff 44a491fb` 看到一堆幻影差异、或把它当成
 *     「发布的那份代码」——全错，因为它比那个提交多了未提交的活儿。
 * captureMode/includesUncommitted 上游忠实记录、跨渠道送达、下游能读，却**在还原时无人据此
 * 向维护者澄清来源** = 死字段（断桥）。本层就是那个缺失的消费者：把「这份还原源码到底等于
 * 哪个 git 状态」从一句会误导的「commit X」，变成一次诚实的裁决。
 *
 * ── 怎么判：来源诚实门（最保守优先 · 没有正面证据绝不谎称 clean）──────────────────
 * assessRestoreProvenance(header) 纯函数，绝不抛。header = 解析好的 snapshot.json 对象。
 *   1) header 非对象                                   → unverifiable（无从判断来源）。
 *   2) 无 gitCommit（非串 / 空）                        → no-provenance（没记录任何提交，无从溯源）。
 *   3) 脏捕获（includesUncommitted===true 或 dirty===true）→ dirty（== 提交 X + 未提交增量，不等于干净提交）。
 *   4) 有正面 clean 证据（HEAD 归档，或 working-tree 且 includesUncommitted===false）→ clean（== 提交 X）。
 *   5) 其余（有提交、非脏、但拿不到正面 clean 证据）      → indeterminate（保守：不臆断 clean）。
 * 裁决 = { status, ok, gitCommit, shortCommit, captureMode, includesUncommitted, version, reason }。
 * ok===true **仅当** status==='clean'（还原源码可证等于某个干净提交）——这是「简单还原」里最强的一档：
 * 维护者可以放心把它当成「就是那个提交」。dirty / indeterminate / no-provenance 都 ok:false，
 * 提醒维护者「这份源码不等于一个干净提交，别当发布快照用」。
 *
 * ── 恒久红线（继承全家族）────────────────────────────────────────────────────────
 * · 没有正面 clean 证据绝不谎称 clean：任何脏 / 不确定 / 缺来源 → ok:false，诚实披露。
 * · ok===true 仅当 status==='clean'；dirty/indeterminate/no-provenance/unverifiable 一律 ok:false。
 * · 只披露不阻拦：dirty 是**合法且完整**的还原（内容一字不缺），只是不等于干净提交——
 *   本层把「静默误导」变成「诚实标注」，不改变还原本身的成败。
 *
 * ── 纯度边界 ─────────────────────────────────────────────────────────────────────
 * 纯计算、零 IO、无时钟、无随机、绝不抛：任何字段缺失 / 非法 → 保守（unverifiable / indeterminate）。
 * 真正读 snapshot.json 的 IO 在 CLI scripts/restore-provenance.js 里，单独隔离且 fail-soft。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────────────
 * 新增一档来源判定时：按**保守优先**插进 assessRestoreProvenance 判定链正确位置（越像
 * 「不该说 clean」越靠前），并在下方 _STATUS 常量表登记它的 status 名。ok 的定义只有一个
 * 出口 _verdict——status==='clean' 才 ok:true，别在别处放行。若 makeSourceSnapshot 新增了
 * 来源字段（如 branch / tag），在此消费它、丰富 reason，别让它成为下一个死字段。
 */

// 单一裁决的状态枚举（_STATUS 表：新增判定档时在此登记）。
const STATUS_CLEAN = 'clean';               // 可证等于某个干净提交：最强档，可当「就是那个提交」。
const STATUS_DIRTY = 'dirty';               // == 提交 X + 未提交增量：合法完整还原，但不等于干净提交。
const STATUS_INDETERMINATE = 'indeterminate'; // 有提交、非脏，但无正面 clean 证据：保守不臆断。
const STATUS_NO_PROVENANCE = 'no-provenance'; // 没记录任何提交：无从溯源。
const STATUS_UNVERIFIABLE = 'unverifiable'; // 头缺失 / 非对象：无从判断来源。

/** 非空字符串判定。 */
function _isNonEmptyStr(x) {
  return typeof x === 'string' && x.length > 0;
}

/**
 * 唯一构造裁决的出口：ok 只在 status==='clean' 时为真。红线只需在此一处把守。
 */
function _verdict(status, header, reason) {
  const h = (header && typeof header === 'object') ? header : {};
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
 *
 * @param {object} header  解析好的 snapshot.json 对象
 * @returns {{status:string, ok:boolean, gitCommit:(string|null), shortCommit:(string|null),
 *            captureMode:(string|null), includesUncommitted:(boolean|null), version:(string|null),
 *            reason:string}}
 */
function assessRestoreProvenance(header) {
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
      `这份还原源码 = 提交 ${short} **加上未提交增量**（脏捕获），`
      + '不等于 ' + short + ' 这个干净提交：别当作「发布的那份代码」，`git diff ' + short + '` 会显示这些未提交改动');
  }

  // 4) 有正面 clean 证据：HEAD 归档天然干净，或 working-tree 且明确 includesUncommitted===false。
  const cleanEvidence =
    header.captureMode === 'HEAD' ||
    header.includesUncommitted === false;
  if (cleanEvidence) {
    return _verdict(STATUS_CLEAN, header,
      `这份还原源码可证等于干净提交 ${short}（`
      + (header.captureMode === 'HEAD' ? '从提交归档' : 'working-tree 捕获且无未提交改动')
      + '）：可放心当作「就是那个提交」');
  }

  // 5) 有提交、非脏，但拿不到正面 clean 证据（如 working-tree 模式而 includesUncommitted 未记录）：
  //    保守，不臆断 clean。
  return _verdict(STATUS_INDETERMINATE, header,
    `记录了提交 ${short} 且未标记为脏，但缺少正面「无未提交改动」证据（`
    + `captureMode=${header.captureMode || '?'} · includesUncommitted 未记录）：保守起见不断言等于干净提交`);
}

module.exports = {
  assessRestoreProvenance,
  STATUS_CLEAN,
  STATUS_DIRTY,
  STATUS_INDETERMINATE,
  STATUS_NO_PROVENANCE,
  STATUS_UNVERIFIABLE,
  _verdict,
  _isNonEmptyStr,
};
