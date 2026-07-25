'use strict';

/**
 * sourceHealService.js — 薄壳(IO 层):khy 源码/文件「自愈」的执行器。
 *
 * 与纯叶子 sourceHealPolicy.js 的分工:
 *   - 叶子(决策大脑,零 IO):给定「应有哈希清单」vs「磁盘实际哈希」,确定性算出
 *     该补哪些(missing)、该修哪些(corrupt)、绝不碰哪些(extra 只报告、不安全路径拒绝),
 *     并对一次修复文件数封顶。
 *   - 本壳(执行器,做 IO):
 *       ① 定位随包分发的**加密源码快照** `bundled/_source/{snapshot.json,*.enc}`(纯净参照);
 *       ② 只在需要时解密+解包到临时目录得到纯净树(fingerprint 命中缓存则跳过解密);
 *       ③ 构建/缓存「应有哈希清单」(按快照 sha256 版本键缓存到数据家,避免每次启动重解密);
 *       ④ 哈希磁盘实际运行文件;
 *       ⑤ 调 planSourceHeal 得计划;
 *       ⑥ 逐个从纯净树覆盖回写(损坏文件先备份 `.broken-<ts>`),并校验回写后哈希;
 *       ⑦ 全程 fail-soft——自愈绝不能把启动/更新流程搞崩,任何异常都降级为「本次不修」。
 *
 * 治愈范围(诚实边界):只管 khy **运行时后端源码子树** `services/backend/src`——即真正
 *   被执行的代码(用户点名的「函数名少打一个字母」「个别文件丢失」都落在这里)。kernel/docs/
 *   前端构建产物等不在自愈范围(风险高、非运行时热路径,整树重建交给 `khy restore`)。
 *
 * 复用:解密走 sourceSnapshotCrypto(SSOT,与 makeSourceSnapshot/khy restore 同一实现),
 *   哈希走 crypto.sha256,门控/计划走 sourceHealPolicy 叶子。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const policy = require('./sourceHealPolicy');
const { sweepBundledOrphans } = require('./orphanSweep/orphanSweep');
const {
  SNAPSHOT_ENC_NAME,
  SNAPSHOT_META_NAME,
  DEFAULT_SOURCE_SECRET,
  decrypt: decryptSnapshot,
  sha256Hex,
} = require('./sourceSnapshotCrypto');

// 运行时后端源码子树(仓库相对);快照(git archive of repo)与安装树都以此为锚。
const MANAGED_REL = path.join('services', 'backend', 'src');

// 收集时跳过的目录(不应出现在 git archive 的 src 里,但防御性排除)。
const _SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.pytest_cache']);

// ── 环境/路径工具 ───────────────────────────────────────────────────────────

function _env(opts) {
  return (opts && opts.env) || (typeof process !== 'undefined' ? process.env : {});
}

/** 本进程真正运行的 services/backend/src 目录(本文件位于其 services/ 子目录下)。 */
function _installSrcDir() {
  return path.resolve(__dirname, '..');
}

/** 快照解包后纯净树里对应的 services/backend/src。 */
function _pristineSrcDir(pristineRoot) {
  return path.join(pristineRoot, MANAGED_REL);
}

function _isInside(child, parent) {
  try {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/**
 * 从安装的 backend src 目录向上定位最近的 `bundled` 打包树根,作为孤儿深扫的 root。
 * 首选:安装树布局 `.../bundled/services/backend/src` → 剥掉 MANAGED_REL 得 `.../bundled`。
 * 兜底:逐级向上找名为 `bundled` 的祖先目录。定位不到(dev 源码树)→ null(跳过深扫)。
 */
function _findBundledRoot(installSrcDir) {
  try {
    if (!installSrcDir || typeof installSrcDir !== 'string') return null;
    // 首选:剥掉尾部 MANAGED_REL,若剩余目录本身叫 bundled 即命中。
    if (installSrcDir.endsWith(MANAGED_REL)) {
      const stripped = installSrcDir.slice(0, installSrcDir.length - MANAGED_REL.length);
      const cand = path.resolve(stripped);
      if (path.basename(cand) === 'bundled') return cand;
    }
    // 兜底:逐级向上找 `bundled`(硬上限防无限循环)。
    let cur = path.resolve(installSrcDir);
    for (let i = 0; i < 12; i++) {
      if (path.basename(cur) === 'bundled') return cur;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function _hashFileSafe(fp) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
  } catch {
    return null;
  }
}

/** 递归收集 dir 下所有文件,返回有序 relPath 数组(posix 分隔,稳定排序)。 */
function _collectRelFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (ent.isDirectory()) {
        if (_SKIP_DIRS.has(name)) continue;
        walk(childAbs, childRel);
      } else if (ent.isFile()) {
        out.push(childRel);
      }
    }
  };
  walk(dir, '');
  out.sort();
  return out;
}

/** 构建纯净参照哈希清单 {relPath: sha256}(遍历纯净树 src 子目录)。 */
function _buildManifest(pristineSrcDir) {
  const manifest = {};
  for (const rel of _collectRelFiles(pristineSrcDir)) {
    const h = _hashFileSafe(path.join(pristineSrcDir, rel));
    if (h) manifest[rel] = h;
  }
  return manifest;
}

/**
 * 哈希安装树里的实际文件。
 *   - relPaths:应有清单的键(缺失/不可读 → null,供 missing/corrupt 判定)。
 *   - scanExtra=true:额外遍历整个安装 src 收录磁盘上多出来的文件(供 extra 诚实报告;
 *     启动 subset 快路径传 false 跳过全盘遍历省时——extra 只报告不影响修复安全性)。
 */
function _hashActual(relPaths, installSrcDir, scanExtra) {
  const actual = {};
  for (const rel of relPaths) {
    actual[rel] = _hashFileSafe(path.join(installSrcDir, rel));
  }
  if (scanExtra) {
    for (const rel of _collectRelFiles(installSrcDir)) {
      if (!(rel in actual)) actual[rel] = _hashFileSafe(path.join(installSrcDir, rel));
    }
  }
  return actual;
}

// ── 快照定位 / 解密 / 解包(复用 publish.js 的定位思路,壳内自持避免耦合 CLI) ─────

/** 判定 dir 是否是一个含快照的 _source 目录。 */
function _snapshotDirHasFiles(dir) {
  return !!dir
    && fs.existsSync(path.join(dir, SNAPSHOT_META_NAME))
    && fs.existsSync(path.join(dir, SNAPSHOT_ENC_NAME));
}

/**
 * 跨安装形态定位随包 `_source/` 快照目录。锚点由本后端自身位置推导:
 *   - npm / 独立后端:<backendRoot>/_source
 *   - pip bundled:bundled/services/backend → bundled/_source
 */
function _findSnapshotSourceDir(opts = {}) {
  const explicit = opts && (opts.sourceDir || opts.snapshotDir);
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));

  const backendRoot = path.resolve(__dirname, '../..'); // services/backend
  candidates.push(
    path.join(backendRoot, '_source'),               // npm package + standalone backend
    path.join(backendRoot, '..', '..', '_source'),   // pip: bundled/services/backend → bundled/_source
    path.join(backendRoot, '..', '_source'),          // defensive
  );

  for (const c of candidates) {
    try {
      if (_snapshotDirHasFiles(c)) return c;
    } catch { /* ignore */ }
  }
  return null;
}

function _readJsonSafe(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

/** 本进程运行的后端 package.json 版本(fail-soft,拿不到 → null)。 */
function _runningVersion() {
  try {
    return String(require('../../package.json').version || '') || null;
  } catch {
    return null;
  }
}

// 自动触发时「一次最多自动写回」的文件数——远小于叶子的硬上限(200)。这是把用户诉求
// (「个别文件丢失」「一个函数名少打一个字母」= 局部零星损坏)编码进策略:自动自愈只应处理
// **少量**孤立文件;若计划涉及大量文件,那更像版本漂移/系统性损坏,应交给整树 `khy restore`
// 而非在启动/更新时静默重写几十上百个文件。KHY_SOURCE_HEAL_AUTO_MAX 覆盖,坏值回落默认。
const DEFAULT_AUTO_MAX = 25;
function _resolveAutoMax(env) {
  try {
    const raw = env && env.KHY_SOURCE_HEAL_AUTO_MAX;
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_AUTO_MAX;
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return DEFAULT_AUTO_MAX;
    return n;
  } catch {
    return DEFAULT_AUTO_MAX;
  }
}

function _resolveSecret(opts) {
  const env = _env(opts);
  const explicit = (opts && opts.secret)
    || (env && env.KHY_SOURCE_PUBLISH_SECRET)
    || '';
  const s = String(explicit).trim();
  return s || DEFAULT_SOURCE_SECRET;
}

/** 把 tar.gz buffer 解包到 destDir(与 khy restore 同一实现:tar -xzf)。 */
function _extractTarGz(tarGzBuffer, destDir) {
  const tmp = path.join(os.tmpdir(), `khy-heal-${process.pid}-${Date.now()}.tar.gz`);
  fs.writeFileSync(tmp, tarGzBuffer);
  try {
    const result = spawnSync('tar', ['-xzf', tmp, '-C', destDir], { encoding: 'utf-8' });
    if (result.error && result.error.code === 'ENOENT') {
      throw new Error('tar command not found');
    }
    if (result.status !== 0) {
      throw new Error(`tar extract failed: ${String(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * 解密+解包快照到一个新建临时目录,返回 {pristineRoot, cleanup}。
 * 失败(无快照/坏 header/解密失败/无 tar)→ 返回 null(fail-soft)。
 */
function _extractPristine(opts = {}) {
  const srcDir = _findSnapshotSourceDir(opts);
  if (!srcDir) return null;

  const header = _readJsonSafe(path.join(srcDir, SNAPSHOT_META_NAME));
  if (!header || !header.crypto) return null;

  let plaintext;
  try {
    const ciphertext = fs.readFileSync(path.join(srcDir, SNAPSHOT_ENC_NAME));
    plaintext = decryptSnapshot(ciphertext, header, _resolveSecret(opts));
  } catch {
    return null; // 自定义密钥/损坏 → 交给 khy restore,自愈不冒进
  }
  if (header.sha256 && sha256Hex(plaintext) !== header.sha256) return null;

  let tmpRoot;
  try {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-heal-src-'));
    _extractTarGz(plaintext, tmpRoot);
  } catch {
    if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
    return null;
  }

  return {
    pristineRoot: tmpRoot,
    header,
    srcDir,
    cleanup() {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ── 应有清单缓存(按快照 sha256 版本键,避免每次启动重解密) ─────────────────────

/**
 * 解析「数据家」目录(缓存/状态文件的落点)。opts.dataHome 显式覆盖优先(测试隔离,
 * 绕开 getAppHome 的 legacy-established 冻结),否则走 SSOT getAppHome();都拿不到 → null。
 */
function _resolveDataHome(opts) {
  try {
    if (opts && opts.dataHome) return path.resolve(opts.dataHome);
  } catch { /* ignore */ }
  try {
    const { getAppHome } = require('../utils/dataHome');
    return getAppHome();
  } catch {
    return null;
  }
}

/** 缓存文件位置:数据家下 source_heal_manifest.json(fail-soft,拿不到就不缓存)。 */
function _manifestCachePath(opts) {
  const home = _resolveDataHome(opts);
  return home ? path.join(home, 'source_heal_manifest.json') : null;
}

/** 读缓存清单;版本(fingerprint)不匹配或坏 → null。 */
function _loadCachedManifest(fingerprint, opts) {
  if (!fingerprint) return null;
  const cp = _manifestCachePath(opts);
  if (!cp) return null;
  const cached = _readJsonSafe(cp);
  if (cached && cached.fingerprint === fingerprint && cached.files && typeof cached.files === 'object') {
    return cached.files;
  }
  return null;
}

function _saveCachedManifest(fingerprint, files, opts) {
  if (!fingerprint) return;
  const cp = _manifestCachePath(opts);
  if (!cp) return;
  try {
    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({ fingerprint, files }), 'utf-8');
  } catch { /* ignore — 缓存是优化非必需 */ }
}

// ── 核心:给定纯净 src 目录 + 安装 src 目录,执行自愈(可单测,不碰快照) ──────────

/**
 * 从纯净树目录修复安装树。这是自愈的核心逻辑,与快照/加密解耦,可用临时目录直接单测。
 *
 * @param {string} pristineSrcDir 纯净参照的 services/backend/src 目录
 * @param {string} installSrcDir  安装树的 services/backend/src 目录
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {boolean} [opts.apply=false] 是否真写回(false=仅规划,dry-run)
 * @param {string[]} [opts.subset] 只检查这些 relPath(启动快路径可传关键子集)
 * @returns {{ok:boolean, applied:Array, failed:Array, plan:Array, report:object}}
 */
function healFromPristineDir(pristineSrcDir, installSrcDir, opts = {}) {
  const env = _env(opts);
  const apply = !!opts.apply;

  const baseReport = { ok: false, applied: [], failed: [], plan: [], report: null };
  try {
    if (!policy.isEnabled(env)) {
      return { ...baseReport, ok: true, report: { enabled: false, skipped: 'gate-off' } };
    }

    let expected = _buildManifest(pristineSrcDir);
    if (Array.isArray(opts.subset) && opts.subset.length) {
      const keep = new Set(opts.subset);
      const filtered = {};
      for (const k of Object.keys(expected)) if (keep.has(k)) filtered[k] = expected[k];
      expected = filtered;
    }

    const scanExtra = !(Array.isArray(opts.subset) && opts.subset.length);
    const actual = _hashActual(Object.keys(expected), installSrcDir, scanExtra);
    const plan = policy.planSourceHeal(expected, actual, { env });

    const applied = [];
    const failed = [];

    if (apply) {
      for (const item of plan.plan) {
        const rel = item.relPath;
        const src = path.join(pristineSrcDir, rel);
        const dst = path.join(installSrcDir, rel);
        // 二次防线:写目标必须落在安装 src 之内(叶子已过滤,壳再核一遍)。
        if (!_isInside(dst, installSrcDir)) {
          failed.push({ relPath: rel, reason: item.reason, error: 'unsafe-target' });
          continue;
        }
        try {
          if (!fs.existsSync(src)) {
            failed.push({ relPath: rel, reason: item.reason, error: 'source-missing' });
            continue;
          }
          // 损坏文件先备份原件(取证/可回滚),缺失文件无原件可备份。
          if (item.reason === 'corrupt' && fs.existsSync(dst)) {
            try { fs.renameSync(dst, `${dst}.broken-${Date.now()}`); } catch { /* best-effort */ }
          }
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
          // 回写后校验:哈希必须与参照一致,否则记为 failed。
          const after = _hashFileSafe(dst);
          if (after && after === expected[rel]) {
            applied.push({ relPath: rel, reason: item.reason });
          } else {
            failed.push({ relPath: rel, reason: item.reason, error: 'verify-mismatch' });
          }
        } catch (err) {
          failed.push({ relPath: rel, reason: item.reason, error: String((err && err.message) || err) });
        }
      }
    }

    return {
      ok: true,
      applied,
      failed,
      plan: plan.plan,
      report: {
        enabled: true,
        summary: plan.summary,
        capped: plan.capped,
        skippedUnsafe: plan.skippedUnsafe,
        appliedCount: applied.length,
        failedCount: failed.length,
        dryRun: !apply,
      },
    };
  } catch (err) {
    return { ...baseReport, ok: false, report: { error: String((err && err.message) || err) } };
  }
}

// ── 顶层入口:定位快照 → 规划/修复(带清单缓存,健康时零解密) ──────────────────

/**
 * 执行一次源码自愈。健康路径极廉价:读快照 header(不解密)+ 命中清单缓存 + 哈希实际文件 +
 * 规划;仅当**发现损坏/缺失**时才解密解包纯净树写回。全程 fail-soft。
 *
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {boolean} [opts.apply=false] true=真修复;false=只体检出计划
 * @param {boolean} [opts.deep=false] true=忽略缓存,强制重建清单(用于更新/显式 khy heal)
 * @param {string[]} [opts.subset] 只检查关键子集(启动快路径)
 * @param {string} [opts.installSrcDir] 覆盖安装 src 目录(测试用)
 * @returns {{ok:boolean, reason?:string, healed?:number, applied?:Array, failed?:Array, plan?:Array, report?:object}}
 */
function healSource(opts = {}) {
  const env = _env(opts);
  try {
    if (!policy.isEnabled(env)) {
      return { ok: true, reason: 'gate-off', healed: 0, applied: [], failed: [], plan: [] };
    }

    const installSrcDir = opts.installSrcDir || _installSrcDir();

    // 1) 定位快照(dev 树无快照 → 无参照可比,自愈无从谈起,交给 git)。
    const srcDir = _findSnapshotSourceDir(opts);
    if (!srcDir) return { ok: true, reason: 'no-snapshot', healed: 0, applied: [], failed: [], plan: [] };

    const header = _readJsonSafe(path.join(srcDir, SNAPSHOT_META_NAME));
    if (!header) return { ok: true, reason: 'no-snapshot-header', healed: 0, applied: [], failed: [], plan: [] };
    const fingerprint = header.sha256 || header.version || null;

    // 版本一致性红线:快照是「本release 应有源码」的权威参照——仅当快照版本 == 运行版本时,
    // 「哈希不符」才可信地解读为**损坏**;版本不一致时不符只是版本漂移(如本地 src 领先随包快照),
    // 此时**绝不自动写回**(否则会把当前文件回退成旧版本)。降级为只报告,除非显式 allowVersionMismatch。
    const snapVersion = header.version || null;
    const runVersion = _runningVersion();
    const versionMatch = !snapVersion || !runVersion || snapVersion === runVersion;
    const wantApply = !!opts.apply;
    const effectiveApply = wantApply && (versionMatch || !!opts.allowVersionMismatch);

    // 2) 取应有清单:命中缓存则零解密;否则解包一次纯净树构建并缓存。
    let expected = opts.deep ? null : _loadCachedManifest(fingerprint, opts);
    let pristine = null;
    try {
      if (!expected) {
        pristine = _extractPristine({ ...opts, srcDir });
        if (!pristine) {
          return { ok: true, reason: 'snapshot-unreadable', healed: 0, applied: [], failed: [], plan: [] };
        }
        expected = _buildManifest(_pristineSrcDir(pristine.pristineRoot));
        _saveCachedManifest(fingerprint, expected, opts);
      }

      // subset 过滤(启动快路径)。
      if (Array.isArray(opts.subset) && opts.subset.length) {
        const keep = new Set(opts.subset);
        const filtered = {};
        for (const k of Object.keys(expected)) if (keep.has(k)) filtered[k] = expected[k];
        expected = filtered;
      }

      // 3) 哈希实际 + 规划。
      const scanExtra = !(Array.isArray(opts.subset) && opts.subset.length);
      const actual = _hashActual(Object.keys(expected), installSrcDir, scanExtra);
      const plan = policy.planSourceHeal(expected, actual, { env });

      // 「个别文件」红线:计划涉及文件数超过自动阈值 → 更像版本漂移/系统性损坏,
      // 拒绝自动写回,建议整树 khy restore(opts.force 可显式绕过,用于人工确认的深修)。
      const autoMax = _resolveAutoMax(env);
      const tooMany = plan.plan.length > autoMax;
      const doApply = effectiveApply && (!tooMany || !!opts.force);

      // 4) 若无需修复或不写回(dry-run / 版本不一致 / 变更过多降级),直接返回。
      if (!doApply || plan.plan.length === 0) {
        let reason = 'dry-run';
        if (plan.plan.length === 0) reason = 'healthy';
        else if (wantApply && !effectiveApply) reason = 'version-mismatch';
        else if (wantApply && effectiveApply && tooMany && !opts.force) reason = 'too-many-changes';
        return {
          ok: true,
          reason,
          healed: 0,
          applied: [],
          failed: [],
          plan: plan.plan,
          report: {
            enabled: true,
            summary: plan.summary,
            capped: plan.capped,
            dryRun: !doApply,
            versionMatch,
            snapshotVersion: snapVersion,
            runningVersion: runVersion,
            tooMany,
            autoMax,
            recommend: (tooMany && !opts.force) ? 'khy restore' : undefined,
          },
        };
      }

      // 5) 需要写回但走了缓存快路径 → 此刻才解包纯净树。
      if (!pristine) {
        pristine = _extractPristine({ ...opts, srcDir });
        if (!pristine) {
          return { ok: true, reason: 'snapshot-unreadable', healed: 0, applied: [], failed: [], plan: plan.plan };
        }
      }

      const res = healFromPristineDir(_pristineSrcDir(pristine.pristineRoot), installSrcDir, {
        env,
        apply: true,
        subset: Array.isArray(opts.subset) && opts.subset.length ? opts.subset : undefined,
      });
      return {
        ok: res.ok,
        reason: res.applied.length ? 'healed' : 'attempted',
        healed: res.applied.length,
        applied: res.applied,
        failed: res.failed,
        plan: res.plan,
        report: res.report,
      };
    } finally {
      if (pristine) pristine.cleanup();
    }
  } catch (err) {
    // 自愈绝不能拖垮宿主流程。
    return { ok: false, reason: 'error', healed: 0, applied: [], failed: [], plan: [], report: { error: String((err && err.message) || err) } };
  }
}

// ── 启动节流:自愈体检按「快照指纹 + 时间窗」限频,避免每条命令都全盘哈希 ──────────
//
// 背景:healSource 健康路径虽廉价(命中清单缓存后仅哈希 ~1800 文件 ≈ 数十毫秒),但 khy
// CLI 每条命令都会走 bootstrap;若每次都体检,累积开销可感。节流状态按**快照指纹**键存:
//   - 指纹不变且距上次体检 < 时间窗(KHY_SOURCE_HEAL_INTERVAL_HOURS 默认 24h)→ 跳过;
//   - 指纹变化(= pip/npm 更新装入新快照,或版本升级)→ 立即重查(不受时间窗限制),
//     这正是「pip/npm 更新时触发自愈」的天然实现:更新后首条命令即体检新装源码。
// force 显式绕过节流(手动 khy heal / postinstall)。now 可注入供测试。

const DEFAULT_HEAL_INTERVAL_HOURS = 24;

function _resolveIntervalMs(env) {
  try {
    const raw = env && env.KHY_SOURCE_HEAL_INTERVAL_HOURS;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return DEFAULT_HEAL_INTERVAL_HOURS * 3600 * 1000;
    }
    const n = Number(String(raw).trim());
    // 0 或负数 → 不节流(每次都查);坏值 → 默认。
    if (!Number.isFinite(n)) return DEFAULT_HEAL_INTERVAL_HOURS * 3600 * 1000;
    if (n <= 0) return 0;
    return Math.round(n * 3600 * 1000);
  } catch {
    return DEFAULT_HEAL_INTERVAL_HOURS * 3600 * 1000;
  }
}

/** 节流状态文件位置:数据家下 source_heal_state.json(fail-soft)。 */
function _healStatePath(opts) {
  const home = _resolveDataHome(opts);
  return home ? path.join(home, 'source_heal_state.json') : null;
}

function _readHealState(opts) {
  const sp = _healStatePath(opts);
  if (!sp) return null;
  return _readJsonSafe(sp);
}

function _writeHealState(state, opts) {
  const sp = _healStatePath(opts);
  if (!sp) return;
  try {
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify(state), 'utf-8');
  } catch { /* ignore — 节流状态是优化非必需 */ }
}

/** 廉价读取当前随包快照指纹(不解密):无快照 → null。 */
function _readSnapshotFingerprint(opts = {}) {
  try {
    const srcDir = _findSnapshotSourceDir(opts);
    if (!srcDir) return null;
    const header = _readJsonSafe(path.join(srcDir, SNAPSHOT_META_NAME));
    if (!header) return null;
    return header.sha256 || header.version || null;
  } catch {
    return null;
  }
}

/**
 * 启动/触发点调用的**节流**自愈体检。健康且近期已查 → 极廉价短路(仅读 header + 状态文件)。
 * 仅当指纹变化或超时间窗时才真正 healSource。全程 fail-soft——绝不能拖垮启动/更新流程。
 *
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {boolean} [opts.silent] 静默(不经 log 输出;仅返回结果)
 * @param {(line:string)=>void} [opts.log] 输出回调(修复了文件时打印一行提示)
 * @param {string} [opts.reason] 触发来源标签(cli-bootstrap / tui-startup / npm-postinstall …)
 * @param {boolean} [opts.force] 绕过节流,强制体检
 * @param {boolean} [opts.deep] 忽略清单缓存(更新场景:源码刚变,重建清单)
 * @param {number} [opts.now] 注入当前时间戳(测试用;默认 Date.now())
 * @param {string} [opts.installSrcDir] 覆盖安装目录(测试用)
 * @returns {{ok:boolean, reason:string, skipped?:boolean, healed?:number, ...}}
 */
function runStartupHeal(opts = {}) {
  const env = _env(opts);
  try {
    if (!policy.isEnabled(env)) {
      return { ok: true, reason: 'gate-off', skipped: true, healed: 0 };
    }

    const force = !!opts.force;
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const fingerprint = _readSnapshotFingerprint(opts);
    if (!fingerprint) {
      // dev 树无随包快照 → 无参照,静默跳过(交给 git)。
      return { ok: true, reason: 'no-snapshot', skipped: true, healed: 0 };
    }

    // 节流判定:非 force + 指纹未变 + 距上次体检未超窗 → 跳过。
    if (!force) {
      const intervalMs = _resolveIntervalMs(env);
      const state = _readHealState(opts);
      if (
        intervalMs > 0 &&
        state &&
        state.fingerprint === fingerprint &&
        typeof state.lastCheckAt === 'number' &&
        now - state.lastCheckAt < intervalMs
      ) {
        return { ok: true, reason: 'throttled', skipped: true, healed: 0 };
      }
    }

    // 真正体检(apply=true;但受 healSource 内版本红线 + 过量红线双护栏保护)。
    const res = healSource({
      env,
      apply: true,
      deep: !!opts.deep,
      force: !!opts.force,
      installSrcDir: opts.installSrcDir,
      sourceDir: opts.sourceDir,
      dataHome: opts.dataHome,
    });

    // 记录本次体检(无论结果):指纹 + 时间戳,供下次节流判定。
    _writeHealState({
      fingerprint,
      lastCheckAt: now,
      reason: res && res.reason,
      healed: (res && res.healed) || 0,
      at: (() => { try { return new Date(now).toISOString(); } catch { return null; } })(),
    }, opts);

    // 有修复且非静默 → 提示一行。
    if (res && res.healed > 0 && !opts.silent) {
      const line = `  源码自愈: 修复 ${res.healed} 个文件 (${(res.reason) || 'healed'})`;
      if (typeof opts.log === 'function') { try { opts.log(line); } catch { /* ignore */ } }
    }

    // 通过节流、已真正体检 → 顺带递归清除 pip 升级残留的 `~` 前缀孤儿目录(Windows stranded stash)。
    // 复用同一指纹节流(升级后首条命令清一次,之后短路),不额外增加启动开销。fail-soft:失败绝不影响自愈结果。
    try {
      const bundledRoot = _findBundledRoot(opts.installSrcDir || _installSrcDir());
      if (bundledRoot) {
        const sweep = sweepBundledOrphans({ root: bundledRoot, apply: true, env });
        if (sweep && sweep.removed && sweep.removed.length > 0 && !opts.silent) {
          const line = `  清理残留: 移除 ${sweep.removed.length} 个损坏孤儿目录 (pip 升级残留)`;
          if (typeof opts.log === 'function') { try { opts.log(line); } catch { /* ignore */ } }
        }
        res.orphanSweep = sweep ? { removed: sweep.removed.length, scanned: sweep.scanned, reason: sweep.reason } : null;
      }
    } catch { /* fail-soft:清理错误绝不阻断 */ }

    return { ...res, skipped: false };
  } catch (err) {
    return { ok: false, reason: 'error', skipped: true, healed: 0, error: String((err && err.message) || err) };
  }
}

module.exports = {
  isEnabled: policy.isEnabled,
  healSource,
  healFromPristineDir,
  runStartupHeal,
  MANAGED_REL,
  // 内部(测试/复用):
  _findSnapshotSourceDir,
  _buildManifest,
  _collectRelFiles,
  _installSrcDir,
  _findBundledRoot,
  _pristineSrcDir,
  _extractPristine,
  _manifestCachePath,
  _healStatePath,
  _readSnapshotFingerprint,
  _resolveIntervalMs,
};
