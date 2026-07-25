'use strict';

/**
 * updateGuard.js — 官方更新防破坏协议（任务三 · 第四部分 · 红线4）。
 *
 * 三道防线：
 *   1. 更新策略（planOfficialUpdate）：官方更新包的每个目标文件**必须**解析落在官方核心轨
 *      （coreRoot）内，且**绝不**落在任何受保护用户轨（user_patch/ · extensions/）内或核心轨外。
 *      任一越界 → 整包判定不安全（fail-closed），**绝不**覆盖 / 删除用户扩展轨（红线4）。
 *   2. 兼容性契约（detectBreakingChange）：若新核心移除了用户轨依赖的接入点（Hook/Slot/Override）
 *      或破坏了向后兼容的核心数据结构，**必须**在启动期检出并产出手动迁移提示，**绝不**静默作废。
 *   3. 隔离施工（applyOfficialUpdate）：仅当整包安全时才写入 allowed（全部在核心轨内）；
 *      不安全则拒绝施工，原子失败。
 */

const nodePath = require('path');
const { USER_TRACK_PROTECTED_NAMES } = require('./extensionLoader');

function isWithin(root, target, pathImpl) {
  const r = pathImpl.resolve(root);
  const abs = pathImpl.resolve(r, target);
  const rel = pathImpl.relative(r, abs);
  const escapes = rel === '..' || rel.startsWith('..' + pathImpl.sep) || pathImpl.isAbsolute(rel);
  return { abs, within: !escapes };
}

/**
 * 规划一次官方更新。逐文件判定是否可安全落入核心轨。
 *
 * @param {{coreRoot, protectedRoots?:string[], incomingFiles:Array<{path,content?}>, pathImpl?}} opts
 * @returns {{ safe:boolean, allowed:Array, rejected:Array<{path,reason}> }}
 */
function planOfficialUpdate(opts = {}) {
  const {
    coreRoot,
    protectedRoots = [],
    incomingFiles = [],
    pathImpl = nodePath,
  } = opts;

  if (!coreRoot) throw new Error('planOfficialUpdate: 缺少 coreRoot');

  const allowed = [];
  const rejected = [];

  for (const file of incomingFiles) {
    const target = file && file.path;
    if (!target) { rejected.push({ path: String(target), reason: '缺少 path' }); continue; }

    // 1) 必须落在核心轨内。
    const inCore = isWithin(coreRoot, target, pathImpl);
    if (!inCore.within) {
      rejected.push({ path: target, reason: '目标落在官方核心轨之外，拒绝（fail-closed）' });
      continue;
    }
    // 2) 绝不落在任何受保护用户轨内（红线4）。
    let hitsProtected = false;
    for (const proot of protectedRoots) {
      const inProt = isWithin(proot, inCore.abs, pathImpl);
      if (inProt.within) { hitsProtected = true; break; }
      // 受保护名兜底：路径段含 user_patch/ extensions/ 也拦。
    }
    const segHit = inCore.abs.split(pathImpl.sep).some((seg) => USER_TRACK_PROTECTED_NAMES.includes(seg));
    if (hitsProtected || segHit) {
      rejected.push({ path: target, reason: '目标命中受保护用户扩展轨，严禁官方覆盖（红线4）' });
      continue;
    }
    allowed.push({ path: target, abs: inCore.abs, content: file.content });
  }

  // fail-closed：只要有任一文件越界，整包不安全。
  const safe = rejected.length === 0 && allowed.length === incomingFiles.length;
  return { safe, allowed, rejected };
}

/**
 * 兼容性契约检查：新核心是否移除了用户轨依赖的接入点 / 破坏核心数据结构。
 *
 * @param {{oldEntryPoints:string[], newEntryPoints:string[]}} opts
 * @returns {{ breaking:boolean, removed:string[], migrationPrompt:(string|null) }}
 */
function detectBreakingChange(opts = {}) {
  const oldE = Array.isArray(opts.oldEntryPoints) ? opts.oldEntryPoints : [];
  const newE = new Set(Array.isArray(opts.newEntryPoints) ? opts.newEntryPoints : []);
  const removed = oldE.filter((e) => !newE.has(e));
  if (removed.length === 0) {
    return { breaking: false, removed: [], migrationPrompt: null };
  }
  const migrationPrompt = [
    '检测到破坏性更新：官方核心移除了以下用户扩展轨依赖的接入点：',
    ...removed.map((r) => `  - ${r}`),
    '为避免静默作废你的私有迭代，更新已暂停，请手动迁移受影响的扩展后再继续。',
  ].join('\n');
  return { breaking: true, removed, migrationPrompt };
}

/**
 * 施工：仅在整包安全时写入 allowed（全部位于核心轨）。不安全则拒绝。
 *
 * @param {{plan, fs?, pathImpl?}} opts
 * @returns {{ applied:string[], aborted:boolean, reason?:string }}
 */
function applyOfficialUpdate(opts = {}) {
  const { plan, fs = require('fs'), pathImpl = nodePath } = opts;
  if (!plan || plan.safe !== true) {
    return { applied: [], aborted: true, reason: '更新包不安全（命中用户轨或越界），已拒绝施工（红线4）' };
  }
  const applied = [];
  for (const f of plan.allowed) {
    fs.mkdirSync(pathImpl.dirname(f.abs), { recursive: true });
    fs.writeFileSync(f.abs, f.content == null ? '' : String(f.content), 'utf8');
    applied.push(f.abs);
  }
  return { applied, aborted: false };
}

module.exports = { planOfficialUpdate, detectBreakingChange, applyOfficialUpdate };
