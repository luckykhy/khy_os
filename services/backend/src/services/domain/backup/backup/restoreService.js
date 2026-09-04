'use strict';

/**
 * restoreService.js — 从备份集恢复(F3「恢复必须可演练」的执行端)。
 *
 * **做 IO**(文件系统 + SQLite)。与 backupService 共用同一批规则真源:
 * `constants/serviceDefaults.js` 的 BACKUP(布局与阈值)、`backupAssetPlan.js`(角色/资产/
 * 提示)、`backupManifest.js`(清单校验)、`sqliteHotCopy.restoreSqliteInPlace`(换库 + 清 WAL)。
 *
 * ── 恢复是**破坏性**操作,所以顺序本身就是安全机制 ────────────────────────
 *   1. **先校验**:缺 `.complete` → 直接拒绝(那是一份写到一半的备份);逐项 sha256 不符
 *      → 拒绝(除非调用方显式 force)。用一份坏备份覆盖现有数据 = 两份都没了。
 *   2. **拒绝在守护进程存活时恢复**:它持有 SQLite 连接与内存态,换掉库文件会得到
 *      「进程内旧状态 + 盘上新状态」的分裂。要求用户自己 `khy daemon stop` ——
 *      **绝不代为 kill**(AGENTS 规则 3:不硬杀他人进程)。
 *   3. **先给现状拍一份备份**再动手。恢复本身可能选错了 id;没有这一步就没有回头路。
 *   4. **家目录一致性**:manifest 记录了备份时的数据家目录绝对路径。路径变了(换机、
 *      换用户、portable 迁移)默认拒绝,需 `--remap` 明确表示「就恢复到当前家目录」。
 *   5. 逐项落盘走 `.restore-tmp-<pid>` + rename;SQLite 走 restoreSqliteInPlace,
 *      **必须**连带删除旧的 `-wal`/`-shm`,否则旧 WAL 会重放污染刚换上的库。
 *   6. 收尾按 manifest.restoreHints 执行:丢弃 integrity_manifest.json(派生物)、
 *      重建 sessions.db 的 FTS5 索引(会话 JSON 才是主副本)。
 *
 * ── 刻意**不做**的事 ────────────────────────────────────────────────────
 *   - 不自动 `pg_restore`:它需要先 drop/create 数据库对象,破坏性远超「放回文件」,
 *     且要凭据与停机窗口。备份集里有 dump,恢复命令原样打印给人执行(见 manualSteps)。
 *   - 不删除「备份集里没有、现状里有」的文件:恢复是**叠加**而非镜像同步。删除现有
 *     文件的语义太危险(备份分级 core 本就刻意少收),需要另一个显式命令来表达。
 *
 * 契约:fail-soft 返回结构化结果,绝不抛;任何一步不确定 → 拒绝并说清怎么办,
 * 而不是「尽力而为」地留下半恢复状态。
 *
 * @module services/backup/restoreService
 */

const fs = require('fs');
const path = require('path');

const { BACKUP, COLD_EXPORT } = require('../../../../constants/serviceDefaults');
const dh = require('../../../../utils/dataHome');
const plan = require('./backupAssetPlan');
const { restoreSqliteInPlace } = require('./sqliteHotCopy');
const backupService = require('./backupService');
const cold = require('./coldExportService');

// ── 内部工具 ─────────────────────────────────────────────────────────────

/**
 * 守护进程是否存活。
 *
 * 刻意不用 `daemonManager.daemonStatus()`:它是 async、会去探 /health(可能挂在一个
 * 已经卡死的进程上),而且发现 pid 陈旧时**会删掉 pid 文件**。一个恢复前的守卫应当
 * 只读、即时、无副作用 —— 只要 pid 文件里的进程还在,就足以判定「不能动库」。
 *
 * @returns {{alive: boolean, pid: number|null, pidFile: string}}
 */
function _daemonAlive() {
  const pidFile = path.join(dh.getDataDir(), 'daemon.pid');
  try {
    const info = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
    const pid = Number(info && info.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      return { alive: false, pid: null, pidFile };
    }
    process.kill(pid, 0);
    return { alive: true, pid, pidFile };
  } catch {
    return { alive: false, pid: null, pidFile };
  }
}

/** manifest 里的 target(POSIX)→ 本地路径分隔符。 */
function _local(rel) {
  return String(rel || '').split('/').join(path.sep);
}

/**
 * 解析一条 entry 应该落回哪里。
 *
 * @param {object} entry
 * @param {Record<string, string>} homeByRole 角色 → 目标家目录绝对路径
 * @returns {{ok: boolean, dest: string, reason: string}}
 */
function resolveEntryDestination(entry, homeByRole) {
  const e = entry || {};
  const target = String(e.target || '');
  if (!target) {
    return { ok: false, dest: '', reason: 'entry.target 为空' };
  }
  const role = String(e.home || '');
  const homeDir = homeByRole[role];

  if (e.kind === 'pgdump') {
    return { ok: false, dest: '', reason: 'pgdump 需人工 pg_restore(见 manualSteps)' };
  }
  if (!homeDir) {
    return { ok: false, dest: '', reason: `未知数据家目录角色: ${role || '(空)'}` };
  }

  if (e.kind === 'sqlite') {
    // 备份时目标名是 `db/<role>-<basename>`;按 basename 反查资产的原始相对路径,
    // 而不是靠字符串裁剪 —— 资产清单是真源,库的相对位置(如 khyquant/data/)在那里。
    const base = path.basename(target);
    const asset = plan.SQLITE_ASSETS.find((a) => base === `${role}-${path.basename(a.rel)}`);
    if (!asset) {
      return { ok: false, dest: '', reason: `备份集里的库不在资产清单中: ${target}` };
    }
    return { ok: true, dest: path.join(homeDir, asset.rel), reason: '' };
  }

  if (e.kind === 'cold-export') {
    // target 是 `cold/<role>-<dirName>.jsonl.gz`,落点是**目录**(<home>/<dirName>),
    // 因为一份归档里装着那个目录下的多个文件。dirName 从文件名反解:
    // 剥掉 `<role>-` 前缀和 `.jsonl.gz` 后缀。
    const base = path.basename(target);
    const rolePrefix = `${role}-`;
    if (!target.startsWith(`${COLD_EXPORT.SUBDIR}/`) || !base.startsWith(rolePrefix)) {
      return { ok: false, dest: '', reason: `冷归档 target 前缀与角色不符: ${target}` };
    }
    const dirName = base.slice(rolePrefix.length).replace(/.jsonl.gz$/i, '');
    // 只认备份时判定为「冷」的那批目录名。归档可能来自别处,不能让它指定任意目录:
    // 一个 target 写着 `user-.ssh.jsonl.gz` 的归档就能往家目录里任意写文件。
    if (!dirName || !plan.classifyColdDir(dirName, true).cold) {
      return { ok: false, dest: '', reason: `冷归档目录不在冷导出清单中: ${target}` };
    }
    return { ok: true, dest: path.join(homeDir, dirName), reason: '' };
  }

  // file:`home-<role>/<相对路径>`
  const prefix = `${BACKUP.HOME_SUBDIR_PREFIX}${role}/`;
  if (!target.startsWith(prefix)) {
    return { ok: false, dest: '', reason: `文件 target 前缀与角色不符: ${target}` };
  }
  const rel = target.slice(prefix.length);
  if (!rel || rel.split('/').includes('..')) {
    // 路径穿越防线:manifest 可能来自别处(拷来的备份集),不能盲信它的相对路径。
    return { ok: false, dest: '', reason: `非法相对路径: ${target}` };
  }
  return { ok: true, dest: path.join(homeDir, _local(rel)), reason: '' };
}

/** 原子放回一个普通文件:同目录临时名 + rename。 */
function _placeFile(srcAbs, destAbs) {
  let tmp = null;
  try {
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    tmp = `${destAbs}.restore-tmp-${process.pid}`;
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    fs.copyFileSync(srcAbs, tmp);
    fs.renameSync(tmp, destAbs);
    tmp = null;
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).split('\n')[0] };
  } finally {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

// ── 预检 ─────────────────────────────────────────────────────────────────

/**
 * 恢复前的全部只读检查。CLI 的 `khy backup restore --dry-run` 就是「只跑到这里」。
 *
 * @param {string} id 备份集 id 或 '--latest'
 * @param {object} [opts]
 * @param {boolean} [opts.remap] 允许家目录路径变化
 * @param {boolean} [opts.force] 允许 sha256 不符(缺 .complete 永不放行)
 * @param {boolean} [opts.ignoreDaemon] 跳过守护进程存活检查(仅演练测试用)
 * @returns {{ok: boolean, id: string, dir: string, manifest: object|null,
 *            homeByRole: object, blockers: string[], warnings: string[], error: string|null}}
 */
function precheckRestore(id, opts = {}) {
  const out = {
    ok: false,
    id: '',
    dir: '',
    manifest: null,
    homeByRole: {},
    blockers: [],
    warnings: [],
    error: null,
  };
  try {
    const root = backupService.resolveBackupRoot(opts);
    const setId = backupService.resolveSetId(id, opts);
    if (!setId) {
      out.error = `找不到备份集: ${String(id || '--latest')}(备份根 ${root})`;
      return out;
    }
    out.id = setId;
    out.dir = path.join(root, setId);

    // 1) .complete —— 唯一的「这份写完了」判据,force 也不放行。
    if (!fs.existsSync(path.join(out.dir, BACKUP.COMPLETE_MARKER))) {
      out.blockers.push('该备份缺少 .complete 标记(写入未完成),拒绝用它覆盖现有数据');
    }

    // 2) 逐项 sha256 / 字节数
    const verified = backupService.verifyBackup(setId, opts);
    if (verified.error) {
      out.blockers.push(`校验失败: ${verified.error}`);
    } else if (!verified.ok) {
      const detail = verified.problems.slice(0, 5).join('; ');
      const more = verified.problems.length > 5 ? ` (另有 ${verified.problems.length - 5} 项)` : '';
      if (opts.force) {
        out.warnings.push(`--force:忽略 ${verified.problems.length} 项校验问题: ${detail}${more}`);
      } else {
        out.blockers.push(`备份内容校验不通过(${verified.problems.length} 项): ${detail}${more}`);
      }
    }

    const manifest = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(out.dir, BACKUP.MANIFEST_FILENAME), 'utf-8'));
      } catch {
        return null;
      }
    })();
    if (!manifest) {
      out.error = `manifest 缺失或不可解析: ${path.join(out.dir, BACKUP.MANIFEST_FILENAME)}`;
      return out;
    }
    out.manifest = manifest;

    // 3) 守护进程:必须由用户自己停,绝不代为 kill。
    if (!opts.ignoreDaemon) {
      const d = _daemonAlive();
      if (d.alive) {
        out.blockers.push(
          `守护进程仍在运行(pid ${d.pid}):它持有 SQLite 连接与内存态,换库会造成状态分裂。` +
            '请先执行 `khy daemon stop`,再重试恢复'
        );
      }
    }

    // 4) 家目录一致性
    const current = backupService.resolveHomes(opts).reduce((acc, h) => {
      acc[h.role] = h.dir;
      return acc;
    }, {});
    const recorded = manifest.dataHomes && typeof manifest.dataHomes === 'object' ? manifest.dataHomes : {};
    const same = (a, b) =>
      process.platform === 'win32'
        ? String(a).toLowerCase() === String(b).toLowerCase()
        : String(a) === String(b);

    for (const role of Object.keys(recorded)) {
      const was = recorded[role];
      const now = current[role];
      if (!now) {
        if (opts.remap) {
          out.warnings.push(`--remap:备份含 ${role} 家目录(${was}),当前环境没有该角色,该部分将被跳过`);
        } else {
          out.blockers.push(
            `备份含 ${role} 家目录(${was}),当前环境未解析到该角色。` +
              '确认要恢复到当前家目录布局请加 --remap'
          );
        }
        continue;
      }
      if (!same(was, now)) {
        if (opts.remap) {
          out.warnings.push(`--remap:${role} 家目录已从 ${was} 变为 ${now},按当前路径恢复`);
        } else {
          out.blockers.push(
            `${role} 家目录路径已变化(备份时 ${was},现在 ${now})。` +
              '这可能是换机/换用户/portable 迁移;确认要恢复到当前路径请加 --remap'
          );
        }
      }
      out.homeByRole[role] = now;
    }
    // 备份里没记录、但当前存在的角色不参与恢复(备份集里本来就没有它的内容)。

    if (plan.normalizeTier(manifest.tier) !== plan.TIER_FULL) {
      out.warnings.push(
        `该备份为 ${plan.normalizeTier(manifest.tier)} 级:审计/凭据/事件等大体积流水未收录,恢复后这些历史将缺失`
      );
    }

    out.ok = out.blockers.length === 0;
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err || '未知错误').split('\n')[0];
    return out;
  }
}

// ── 执行恢复 ─────────────────────────────────────────────────────────────

/**
 * 从备份集恢复。
 *
 * @param {string} id 备份集 id 或 '--latest'
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] 只做预检并列出将要写的目标,不落盘
 * @param {boolean} [opts.remap] 允许家目录路径变化
 * @param {boolean} [opts.force] 忽略 sha256 校验问题
 * @param {boolean} [opts.skipPreBackup] 跳过「恢复前先备份现状」(演练测试用;人用场景不建议)
 * @param {boolean} [opts.skipReindex] 跳过 sessions.db 重建索引
 * @param {boolean} [opts.ignoreDaemon] 跳过守护进程检查(演练测试用)
 * @param {string[]} [opts.kinds] 只恢复这些 kind(默认 ['sqlite','file'])
 * @param {Function} [opts.onProgress] (msg) => void
 * @returns {Promise<{ok: boolean, id: string, dryRun: boolean, preBackupId: string,
 *                    restored: {sqlite: number, file: number, cold: number}, failed: Array<{target: string, reason: string}>,
 *                    skipped: Array<{target: string, reason: string}>, manualSteps: string[],
 *                    warnings: string[], blockers: string[], error: string|null}>}
 */
async function restoreBackup(id, opts = {}) {
  const out = {
    ok: false,
    id: '',
    dryRun: !!opts.dryRun,
    preBackupId: '',
    restored: { sqlite: 0, file: 0, cold: 0 },
    failed: [],
    skipped: [],
    manualSteps: [],
    warnings: [],
    blockers: [],
    error: null,
  };
  const report = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  try {
    const pre = precheckRestore(id, opts);
    out.id = pre.id;
    out.warnings.push(...pre.warnings);
    out.blockers.push(...pre.blockers);
    if (pre.error) {
      out.error = pre.error;
      return out;
    }
    if (!pre.ok) {
      out.error = `恢复前检查未通过(${pre.blockers.length} 项),已中止,现有数据未被改动`;
      return out;
    }

    const manifest = pre.manifest;
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    // 'cold-export' **必须**在默认集合里。冷导出后那批文件只存在于归档中(备份端
    // 把它们从逐文件复制清单里去掉了),默认不恢复就是默认丢数据 —— 而且 restored
    // 计数看起来一切正常,没有任何人会发现。
    const kinds =
      Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : ['sqlite', 'file', 'cold-export'];
    report(`恢复 ${pre.id}:预检通过,清单 ${entries.length} 项,开始规划落点`);

    // 规划:先把所有落点算清楚,再决定是否落盘(dry-run 就停在这里)。
    const jobs = [];
    for (const e of entries) {
      const dest = resolveEntryDestination(e, pre.homeByRole);
      if (e.kind === 'pgdump') {
        out.skipped.push({ target: String(e.target), reason: dest.reason });
        out.manualSteps.push(
          `PostgreSQL 需人工恢复(破坏性,需停机窗口与凭据):` +
            `pg_restore --clean --if-exists -h $DB_HOST -U $DB_USER -d $DB_NAME "${path.join(pre.dir, _local(e.target))}"`
        );
        continue;
      }
      if (!kinds.includes(e.kind)) {
        out.skipped.push({ target: String(e.target), reason: `--kinds 未选中 ${e.kind}` });
        continue;
      }
      if (!dest.ok) {
        out.skipped.push({ target: String(e.target), reason: dest.reason });
        continue;
      }
      jobs.push({ entry: e, src: path.join(pre.dir, _local(e.target)), dest: dest.dest });
    }

    if (out.dryRun) {
      out.ok = true;
      report(
        `恢复 ${pre.id}(--dry-run):将写入 ${jobs.length} 项,跳过 ${out.skipped.length} 项,未改动任何文件`
      );
      return out;
    }

    // 恢复前先给现状拍一份:选错 id 的唯一退路。
    if (!opts.skipPreBackup) {
      report(`恢复 ${pre.id}:先为当前数据创建回退备份(pre-restore)`);
      const snap = await backupService.createBackup({
        root: opts.root,
        homes: opts.homes,
        tier: plan.TIER_CORE,
        note: `pre-restore:${pre.id}`,
        allowPartial: true, // 现状可能本就残破;回退备份要尽量拿到手,而不是因一处失败放弃
        onProgress: (m) => report(`回退备份 · ${m}`),
      });
      if (!snap.ok) {
        out.error = `回退备份失败,已中止恢复(现有数据未被改动): ${snap.error}`;
        return out;
      }
      out.preBackupId = snap.id;
      out.warnings.push(...snap.warnings.map((w) => `回退备份告警: ${w}`));
      report(`恢复 ${pre.id}:回退备份 ${snap.id} 已就绪,开始写回数据`);
    } else {
      out.warnings.push('已跳过回退备份(--skip-pre-backup):本次恢复不可撤销');
    }

    // 落盘。SQLite 先做(它是权威主库),文件其次。
    const ordered = jobs.slice().sort((a, b) => (a.entry.kind === 'sqlite' ? -1 : b.entry.kind === 'sqlite' ? 1 : 0));
    let done = 0;
    for (const job of ordered) {
      if (job.entry.kind === 'sqlite') {
        report(`写回 SQLite ${path.basename(job.dest)}:替换库文件并清理 WAL/SHM`);
        const r = restoreSqliteInPlace(job.src, job.dest);
        if (!r.ok) {
          out.failed.push({ target: String(job.entry.target), reason: r.error });
        } else {
          out.restored.sqlite++;
          if (r.removedSidecars.length) {
            report(`写回 SQLite ${path.basename(job.dest)}:已删除 ${r.removedSidecars.length} 个旧 WAL/SHM 边车文件`);
          }
        }
      } else if (job.entry.kind === 'cold-export') {
        report(`摊回冷归档 ${path.basename(job.entry.target)}:${job.entry.records || 0} 条记录`);
        const r = cold.expandColdArchive({
          archiveAbs: job.src,
          destDir: job.dest,
          fileMode: BACKUP.FILE_MODE,
        });
        if (!r.ok) {
          out.failed.push({ target: String(job.entry.target), reason: r.error });
        } else {
          out.restored.cold += r.files;
          // 部分记录摊不回去 ≠ 整份失败,但绝不能静默:归档里少一条审计记录
          // 和删掉一条审计记录,后果是一样的。
          for (const sk of r.skipped) {
            out.warnings.push(`冷归档 ${path.basename(job.entry.target)} 跳过 ${sk.path}: ${sk.reason}`);
          }
        }
      } else {
        const r = _placeFile(job.src, job.dest);
        if (!r.ok) {
          out.failed.push({ target: String(job.entry.target), reason: r.error });
        } else {
          out.restored.file++;
        }
      }
      done++;
      if (done % 200 === 0 || done === ordered.length) {
        report(`写回数据:已完成 ${done}/${ordered.length}${out.failed.length ? `,失败 ${out.failed.length}` : ''}`);
      }
    }

    // 收尾:按 restoreHints 处理派生物。
    const hints = Array.isArray(manifest.restoreHints) ? manifest.restoreHints : plan.restoreHints();
    for (const role of Object.keys(pre.homeByRole)) {
      for (const hint of hints) {
        if (hint && hint.kind === 'discard' && hint.target) {
          const p = path.join(pre.homeByRole[role], String(hint.target));
          try {
            if (fs.existsSync(p) && fs.statSync(p).isFile()) {
              fs.unlinkSync(p);
              report(`收尾:已丢弃派生物 ${role}:${hint.target}(将自然重建)`);
            }
          } catch {
            out.warnings.push(`收尾:无法删除派生物 ${role}:${hint.target},请手动删除`);
          }
        }
      }
    }

    if (!opts.skipReindex) {
      report('收尾:从会话 JSON 重建 sessions.db 的 FTS5 搜索索引');
      try {
        const sessionSearchIndex = require('../../../sessionSearchIndex');
        const res = sessionSearchIndex.reindexAll({ source: 'backup-restore' });
        report(`收尾:索引重建完成 ${JSON.stringify(res && res.indexed !== undefined ? res.indexed : res)}`);
      } catch (err) {
        // 索引是派生物,重建失败不该让整次恢复算失败 —— 但必须留话,否则搜索会静默变空。
        out.warnings.push(
          `sessions.db 索引重建失败: ${String((err && err.message) || err).split('\n')[0]};稍后可用 \`khy session reindex\` 重试`
        );
      }
    }

    out.ok = out.failed.length === 0;
    if (!out.ok) {
      out.error = `${out.failed.length} 项写回失败(其余已恢复);回退备份: ${out.preBackupId || '(无)'}`;
    }
    report(
      `恢复 ${pre.id}:${out.ok ? '完成' : '部分完成'} — 库 ${out.restored.sqlite} 个 / 文件 ${out.restored.file} 个` +
        (out.restored.cold ? `(含冷归档摊回 ${out.restored.cold} 个)` : '') + `,` +
        `失败 ${out.failed.length},跳过 ${out.skipped.length}`
    );
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err || '未知错误').split('\n')[0];
    return out;
  }
}

module.exports = {
  precheckRestore,
  restoreBackup,
  resolveEntryDestination,
  _daemonAlive,
};
