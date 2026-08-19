'use strict';

/**
 * coldExportService.js — 冷数据封存(把只增不改的历史流水压成单个 .jsonl.gz)。
 *
 * **做 IO**(文件系统 + zlib)。判定规则(哪些目录算冷、记录时间怎么读、窗口怎么算)
 * 全在纯叶子 `backupAssetPlan.js`;本文件只负责「按规则搬字节 + 如实记账」。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────────
 * full 级备份里 `audit/` 一个目录就是 1300+ 个小文件 / 10 MB,`receipts`、`events`、
 * `telemetry` 同构。逐文件复制的代价几乎全在**文件数**而不是字节数:每个文件一次
 * copy、一次 stat、一次 sha256、一条 manifest entry。把它们流式并成一个 gzip
 * JSONL,manifest 从 1300 条变 1 条,体积按文本压缩比掉一个量级。
 *
 * ── 绝不碰 SQLite(F1 的边界在这里同样成立)─────────────────────────────
 * 本模块**只读 .json / .jsonl 文本流水**。库文件一律走 `sqliteHotCopy.js` 的
 * VACUUM INTO;冷导出器既不打开 .db,也不按文件遍历把 .db 拷走 —— 一个正在写的
 * 库被当成普通文件拷出去,得到的是缺了大半已提交事务的残库,而它看起来完全正常。
 * `_isExportableFile` 因此是白名单而不是黑名单:没见过的后缀一律不收。
 *
 * ── 为什么覆盖判定是**文件级**而不是目录级 ──────────────────────────────
 * 冷导出和逐文件复制是同一份数据的两种表示,同时收等于把备份集体积翻倍 —— 而体积
 * 正是这件事要治的东西。所以被归档的东西必须从复制清单里去掉。
 *
 * 但「整个 audit/ 目录归档了就别复制了」是**错的**:窗口过滤是按记录判的,一个文件
 * 里完全可能既有 40 天前的冷记录、也有今天刚追加的热记录。目录级短路会把那些热记录
 * 连同它们所在的文件一起从备份集里抹掉,而 manifest 上什么都看不出来 —— 这是静默丢
 * 数据,比多存一份严重得多。
 *
 * 因此判定的单位是**整个文件**:一个文件只要还有一条记录落在热窗口内,它整份都不进
 * 归档,照常逐文件复制。读失败的不进,`records===0` 没产归档时一个都不进。
 *
 * 这条「要么整份、要么不收」的规矩不只是为了省事 —— `expandColdArchive` 是按
 * `_source` 分组**重建整个文件**的。收一半就意味着恢复时把文件写成只剩冷记录的版本,
 * 而 kind='file' 那份完整副本可能已经先落盘了;两条恢复路径写同一个文件,谁后跑谁赢,
 * 输的那次是完整数据。代价是热窗口边缘的文件完全不参与压缩,换来的是恢复端可以无条件
 * 依赖「归档里出现的文件 = 备份时刻的完整文件」。
 *
 * ── 三条写盘约束 ────────────────────────────────────────────────────────
 *   1. 先写 `<target>.tmp-<pid>` 再 rename —— 中断不留半个归档;
 *   2. 目录 0700 / 文件 0600 —— 流水里有工具调用参数和会话内容,与备份集同级机密;
 *   3. 空导出**不产文件** —— 一个 0 记录的 .gz 会让 manifest 出现一条永远恢复不出
 *      任何东西的 entry,那比没有更容易骗人。
 *
 * 契约:fail-soft 返回结构化结果,绝不抛;任何跳过/失败都必须在返回值里留痕。
 *
 * @module services/backup/coldExportService
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const { COLD_EXPORT } = require('../../constants/serviceDefaults');
const plan = require('./backupAssetPlan');

/**
 * 可导出的文本流水后缀。白名单,不是黑名单 —— 见顶部「绝不碰 SQLite」。
 *
 * **刻意只收行式格式(.jsonl / .ndjson),不收 .json**,两个理由都是硬的:
 *
 *   1. 语义:冷导出的前提是"只增不改"。一个顶层数组的 .json 每次写都要整份重写,
 *      它不是流水而是状态文件,折叠它等于把一份活的状态当历史归档。
 *   2. 往返保真:行式格式拆成记录再拼回去逐字节等价;顶层数组拼回来会变成 JSONL,
 *      文件名还叫 .json 而内容已经换了形状 —— 恢复出一个读不动的文件,比没恢复更糟。
 *
 * .log 也不在内:日志归日志治理域(cleanupService),不是状态。
 */
const EXPORTABLE_EXTS = Object.freeze(['.jsonl', '.ndjson']);

/**
 * 归档文件在备份集里的子目录。取自 constants(F5),不在这里再写一遍字面量 ——
 * restore 端也按同一个常量寻址,两处各写一份「cold」就是等着有天只改一处。
 */
const COLD_SUBDIR = COLD_EXPORT.SUBDIR;

function _posix(p) {
  return String(p == null ? '' : p).split('\\').join('/');
}

/** 这个文件是不是本模块愿意读的文本流水。 */
function _isExportableFile(name) {
  const n = String(name == null ? '' : name).toLowerCase();
  const dot = n.lastIndexOf('.');
  if (dot <= 0) return false;
  return EXPORTABLE_EXTS.includes(n.slice(dot));
}

/**
 * 递归列出一个流水目录下的可导出文件,按相对路径排序。
 *
 * 排序是**刻意**的:归档内容因此只取决于目录内容,不取决于 readdir 的返回顺序。
 * 同一份数据两次导出得到同样的字节,sha256 才有比对价值。
 */
function _listFlowFiles(dirAbs) {
  const out = [];
  const walk = (cur, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(cur, e.name), childRel);
      } else if (e.isFile() && _isExportableFile(e.name)) {
        out.push(childRel);
      }
    }
  };
  walk(dirAbs, '');
  return out.sort();
}

/**
 * 把一个文件里的记录摊平成数组。
 *
 * 兼容三种现场形状:JSONL(一行一条)、顶层数组、顶层单对象。**解析不了的行原样
 * 保留为 `{_raw: <该行文本>}`**,而不是跳过 —— 冷导出是归档,一条格式坏掉的审计
 * 记录仍然是证据,把它悄悄吃掉就是让事故现场少一条线索。
 */
function _readRecords(fileAbs) {
  let text;
  try {
    text = fs.readFileSync(fileAbs, 'utf8');
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 顶层数组 / 单对象:整份解析。失败则退回逐行,不直接判死。
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch {
      /* fall through to line mode */
    }
  }

  const records = [];
  for (const line of trimmed.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      records.push(JSON.parse(s));
    } catch {
      records.push({ _raw: s });
    }
  }
  return records;
}

/**
 * 导出一个冷目录到 `<setDir>/cold/<role>-<dirName>.jsonl.gz`。
 *
 * @param {object} spec
 * @param {string} spec.sourceDir 流水目录绝对路径
 * @param {string} spec.setDir 备份集根目录
 * @param {string} spec.role 数据家目录角色,用于目标命名(避免跨家目录同名覆盖)
 * @param {string} spec.dirName 流水目录名(audit / receipts / …)
 * @param {number} spec.nowMs 当前时间(注入,保持可测)
 * @param {number} spec.windowDays 冷窗口天数;<=0 表示全收
 * @param {number} spec.dirMode
 * @param {number} spec.fileMode
 * @returns {{ok: boolean, exported: boolean, target: string, bytes: number,
 *            sha256: string, records: number, sourceFiles: number,
 *            skippedRecent: number, coveredFiles: string[], error: string|null}}
 *
 * `coveredFiles` 是**整份都进了归档**的源文件相对路径(该文件的每一条记录都落进
 * .gz,既没有落在热窗口内的,也没有读失败的)。调用方据此跳过逐文件复制 —— 见下方
 * 「为什么是文件级而不是目录级」。
 */
function exportColdDir(spec = {}) {
  const out = {
    ok: false,
    exported: false,
    target: '',
    bytes: 0,
    sha256: '',
    records: 0,
    sourceFiles: 0,
    skippedRecent: 0,
    coveredFiles: [],
    error: null,
  };

  let tmpAbs = null;
  try {
    const sourceDir = String(spec.sourceDir || '');
    const setDir = String(spec.setDir || '');
    const role = String(spec.role || '');
    const dirName = String(spec.dirName || '');
    if (!sourceDir || !setDir || !dirName) {
      out.error = '冷导出参数不完整(sourceDir / setDir / dirName)';
      return out;
    }
    if (!fs.existsSync(sourceDir)) {
      // 目录不存在不是错误:该功能可能从未被使用过。
      out.ok = true;
      return out;
    }

    const nowMs = Number.isFinite(Number(spec.nowMs)) ? Number(spec.nowMs) : Date.now();
    const windowDays = Number(spec.windowDays);
    const dirMode = Number.isFinite(Number(spec.dirMode)) ? Number(spec.dirMode) : 0o700;
    const fileMode = Number.isFinite(Number(spec.fileMode)) ? Number(spec.fileMode) : 0o600;

    const files = _listFlowFiles(sourceDir);
    out.sourceFiles = files.length;
    if (files.length === 0) {
      out.ok = true;
      return out;
    }

    // 逐文件读、逐记录判窗口,拼成 JSONL 文本。
    //
    // 这里**不做**流式管道:现场最大的 audit 目录是 10 MB 文本,整体拼接的峰值内存
    // 完全可接受,而流式 gzip 加背压处理会把这个模块的失败模式从「一次 catch」
    // 变成「跨 stream 的错误传播」,在 fail-soft 契约下不划算。若哪天流水到了
    // 百 MB 量级,这里再换成 createGzip + pipeline,接口不用动。
    const lines = [];
    const covered = [];
    for (const rel of files) {
      const abs = path.join(sourceDir, rel);
      const records = _readRecords(abs);
      if (records === null) {
        // 单个文件读不动不该毁掉整次导出,但它绝不能进 coveredFiles ——
        // 那等于告诉调用方「已归档,别再复制了」,而归档里其实一个字节都没有。
        continue;
      }
      if (records.length === 0) continue;

      // **先判整份,再决定收不收**。一个文件里只要还有一条落在热窗口内,整份都不进
      // 归档 —— 因为 expandColdArchive 是按 _source 分组**重建整个文件**的,收一半
      // 就意味着恢复时把它写成只剩冷记录的版本,而 kind='file' 那份完整副本可能已经
      // 先落盘了。两条恢复路径写同一个文件,谁后跑谁赢,而输的那次是完整数据。
      //
      // 代价是热窗口边缘的文件完全不参与归档(照常逐文件复制),换来的是「归档里
      // 出现的文件 = 备份时刻的完整文件」这条恢复端可以无条件依赖的性质。
      const hot = records.filter(
        (r) => !plan.withinColdWindow(plan.recordTimeMs(r), nowMs, windowDays)
      ).length;
      if (hot > 0) {
        out.skippedRecent += hot;
        continue;
      }

      for (const record of records) {
        // 归档每条记录都带上它的来源文件,否则恢复时无法把一条记录放回原处。
        try {
          lines.push(JSON.stringify({ _source: _posix(rel), ...record }));
        } catch {
          // 循环引用等无法序列化的对象:留一条可读的占位,不静默丢。
          lines.push(JSON.stringify({ _source: _posix(rel), _unserializable: true }));
        }
        out.records++;
      }
      covered.push(_posix(rel));
    }

    if (out.records === 0) {
      // 注意:此处**不**填 coveredFiles。没产文件就没有任何东西被归档,
      // 填了会让调用方跳过复制,数据就此凭空消失。
      // 全部记录都在热窗口内(或目录里没有可导出记录)。不产空归档 —— 见顶部约束 3。
      out.ok = true;
      return out;
    }

    const targetRel = _posix(path.join(COLD_SUBDIR, `${role}-${dirName}.jsonl.gz`));
    const targetAbs = path.join(setDir, targetRel);
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true, mode: dirMode });
    if (fs.existsSync(targetAbs)) {
      out.error = `冷归档目标已存在,拒绝覆盖: ${targetAbs}`;
      return out;
    }

    const payload = zlib.gzipSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
    tmpAbs = `${targetAbs}.tmp-${process.pid}`;
    fs.writeFileSync(tmpAbs, payload, { mode: fileMode });
    fs.renameSync(tmpAbs, targetAbs);
    tmpAbs = null;

    // 权限单独再落一次:某些平台上 writeFileSync 的 mode 会被 umask 削掉,而
    // 这份归档里有工具调用参数和会话内容,0600 不是建议是要求。
    try {
      fs.chmodSync(targetAbs, fileMode);
    } catch {
      /* Windows 上 chmod 基本无效,不因此判失败 */
    }

    out.coveredFiles = covered;
    out.target = targetRel;
    out.bytes = payload.length;
    out.sha256 = crypto.createHash('sha256').update(payload).digest('hex');
    out.exported = true;
    out.ok = true;
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err || '未知错误').split('\n')[0];
    return out;
  } finally {
    if (tmpAbs) {
      try {
        if (fs.existsSync(tmpAbs)) fs.unlinkSync(tmpAbs);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 读回一个冷归档(verify / restore 用)。
 * @param {string} archiveAbs
 * @returns {{ok: boolean, records: Array<object>, error: string|null}}
 */
function readColdArchive(archiveAbs) {
  const out = { ok: false, records: [], error: null };
  try {
    const buf = fs.readFileSync(String(archiveAbs || ''));
    const text = zlib.gunzipSync(buf).toString('utf8');
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.records.push(JSON.parse(s));
      } catch {
        out.records.push({ _raw: s });
      }
    }
    out.ok = true;
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err || '未知错误').split('\n')[0];
    return out;
  }
}

/**
 * 把一份冷归档摊回原来的文件(restore 用)。
 *
 * 归档里每条记录都带 `_source`(相对 `sourceDir` 的路径),按它分组重建文件。
 * 只有「整份都进了归档」的文件才会被折叠(见 exportColdDir 的 coveredFiles),
 * 所以摊回来就是备份时刻那个文件的全部内容 —— 与 kind='file' 逐文件恢复等价。
 *
 * ── 保真边界(必须知道,否则会误判 diff)───────────────────────────────────
 * **内容无损、字节不保证**:每行重新 JSON.stringify,行内空白和缩进被规范化,
 * 键序保持解析时的顺序。原样保留的只有当初解析不了的行(`_raw`)—— 它按原文写回,
 * 一个字符不动。这是收 .jsonl/.ndjson 而不收顶层数组 .json 的直接原因:行式格式
 * 拆开再拼回仍是同一种格式,顶层数组拼回来就变成 JSONL 了。
 *
 * 与 _placeFile 一样是覆盖写(临时名 + rename)。这是安全的:覆盖掉的内容正是这份
 * 归档装着的内容。恢复本身选错 id 的退路是 restoreService 的 pre-restore 备份。
 *
 * @param {object} spec
 * @param {string} spec.archiveAbs 归档文件绝对路径
 * @param {string} spec.destDir 摊回的目标目录(= <home>/<dirName>)
 * @param {number} [spec.fileMode]
 * @returns {{ok: boolean, files: number, records: number,
 *            skipped: Array<{path: string, reason: string}>, error: string|null}}
 */
function expandColdArchive(spec = {}) {
  const out = { ok: false, files: 0, records: 0, skipped: [], error: null };
  try {
    const destDir = String(spec.destDir || '');
    if (!destDir) {
      out.error = '冷归档摊回参数不完整(destDir)';
      return out;
    }
    const fileMode = Number.isFinite(Number(spec.fileMode)) ? Number(spec.fileMode) : 0o600;

    const read = readColdArchive(spec.archiveAbs);
    if (!read.ok) {
      out.error = `冷归档读取失败: ${read.error}`;
      return out;
    }

    /** @type {Map<string, string[]>} 相对路径 -> 行 */
    const byFile = new Map();
    for (const record of read.records) {
      const rel = record && typeof record === 'object' ? String(record._source || '') : '';
      // 路径穿越防线:归档可能来自别处(拷来的备份集),不能盲信它写的相对路径。
      if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) {
        out.skipped.push({ path: rel || '(空)', reason: '非法或缺失的 _source' });
        continue;
      }
      const rest = { ...record };
      delete rest._source;
      // `_raw` 是当初解析不了的原始行。按原文写回,不给它套一层 JSON ——
      // 否则恢复出来的文件里会多出 {"_raw":"..."} 这种当初根本不存在的东西。
      const line = Object.prototype.hasOwnProperty.call(rest, '_raw')
        ? String(rest._raw)
        : JSON.stringify(rest);
      const list = byFile.get(rel);
      if (list) list.push(line);
      else byFile.set(rel, [line]);
      out.records++;
    }

    for (const [rel, lines] of byFile) {
      const destAbs = path.join(destDir, rel.split('/').join(path.sep));
      let tmp = null;
      try {
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        tmp = `${destAbs}.cold-tmp-${process.pid}`;
        fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: fileMode });
        fs.renameSync(tmp, destAbs);
        tmp = null;
        out.files++;
      } catch (err) {
        out.skipped.push({
          path: rel,
          reason: `写回失败: ${String((err && err.message) || err).split('\n')[0]}`,
        });
      } finally {
        if (tmp) {
          try {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
        }
      }
    }

    out.ok = true;
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err || '未知错误').split('\n')[0];
    return out;
  }
}

module.exports = {
  COLD_SUBDIR,
  EXPORTABLE_EXTS,
  exportColdDir,
  readColdArchive,
  expandColdArchive,
  _isExportableFile,
  _listFlowFiles,
  _readRecords,
};
