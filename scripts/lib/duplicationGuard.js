'use strict';

/**
 * duplicationGuard.js — 纯叶子:重复代码检测的**单一真源**判定核心(goal 2026-07-12
 * 「把所有重复的函数提取成公共库,统一维护;在 CI 里加重复代码检测,超过三行相同就报警」)。
 *
 * 背景:OCR 网关测试族过去十几轮送别礼里反复复制粘贴同一套脚手架
 * (_wireGateway / _makeRecordingAdapter / _realExtractImageOcrDetails …)。人肉盯梢挡不住
 * 复制粘贴;强模型知道该抽公共库,弱模型「照着旁边文件抄一份」就把重复越滚越大。本守卫把
 * 「超过三行相同即重复」这条散文规则变成**确定性的机器判据**:谁再抄一大段,提交/CI 时被点名。
 *
 * 契约(与本仓其它 guard 核心一致,弱模型改动时须守住):
 *   - 零 IO:只用 crypto(内容 hash)/ path;不碰 fs / 网络 / 子进程,确定性、可单测。
 *     所有文件读取 / 递归 / 基线读写都在薄 CLI(scripts/check-duplication.js)里。
 *   - env 门控:主闸 `KHY_DUPLICATION_GUARD`,显式 0/false/off/no 关闭 → 返回空判定(逐字节回退)。
 *   - fail-soft:任何畸形入参都不抛,吞掉后返回可用的空/部分结果。
 *   - 确定性排序:findings 按 (file,startLine,hash)、classes 按 hash 排序,跨机可复现。
 *
 * 判定算法(集合级,一次吃进全部候选文件才能跨文件找克隆伙伴):
 *   1. 行归一化:trim + 内部空白折叠为单空格;跳过(a)空行、(b)纯注释行(斜杠斜杠 / 井号 / JSDoc 星号行)、
 *      (c)纯结构标点行(仅 { } ( ) [ ] ; , 与空白)。只有「有效行」参与比对。
 *   2. 滑窗:MIN_BLOCK=4 有效行(即「超过三行」)。对每文件有效行序列滑窗,sha1(窗口归一化行 join)。
 *   3. 成组:某 hash 在 ≥2 个不同位置出现即「克隆类」。把所有克隆窗口覆盖到的有效行下标打点,
 *      同文件内相邻打点合并为**极大跨度**,每(文件,跨度)出一条 finding,伙伴 = 共享该跨度内任一
 *      hash 的其它文件集合。
 *   4. 基线 + 模式:
 *      - mode 'warn'(阶段一):全部 → warning(存量重复绝不红 CI)。
 *      - mode 'gate'(阶段二):跨度内全部窗口 hash ∈ baseline → warning(既有、已接受);
 *        含任一 ∉ baseline 的 hash → error(新引入的重复,挡回)。
 *      baseline 指纹 = 归一化窗口内容 hash(非 file+line):抗位移;抽公共库删掉重复副本后其 hash
 *      从语料消失,`--write-baseline` 时基线随之自动缩小。
 *
 * 用法(核心):
 *   const { assess } = require('./lib/duplicationGuard');
 *   const { findings, classes } = assess({ files:[{relPath,source}], baseline, mode, minBlock, env });
 */

const crypto = require('crypto');

const DEFAULT_MIN_BLOCK = 4; // 「超过三行相同」→ 4 有效行起报
const OFF_WORDS = new Set(['0', 'false', 'off', 'no']);

/**
 * 主闸:KHY_DUPLICATION_GUARD 显式关闭词才关,其余(含未设)默认开。
 * @param {object} env
 * @returns {boolean}
 */
function isEnabled(env) {
  const raw = env && env.KHY_DUPLICATION_GUARD;
  if (raw == null) return true;
  return !OFF_WORDS.has(String(raw).trim().toLowerCase());
}

/**
 * 单行归一化:trim + 内部连续空白折叠为单空格。仅字符串运算。
 * @param {string} raw
 * @returns {string}
 */
function normalizeLine(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}

// 纯注释行:// 开头、# 开头(py/sh)、或 JSDoc/块注释的 /* * */ 视觉行。
const COMMENT_LINE_RE = /^(?:\/\/|#|\/\*|\*\/|\*)/;
// 纯结构标点行:归一化后仅含 { } ( ) [ ] ; , 与空白。
const PUNCT_ONLY_RE = /^[{}()[\];,\s]*$/;

/**
 * 该归一化行是否为「有效行」(参与重复比对)。跳过空行 / 纯注释 / 纯结构标点。
 * @param {string} norm 已归一化的行
 * @returns {boolean}
 */
function isSignificant(norm) {
  if (!norm) return false;
  if (COMMENT_LINE_RE.test(norm)) return false;
  if (PUNCT_ONLY_RE.test(norm)) return false;
  return true;
}

/**
 * 抽出文件的有效行序列:[{ lineNo(1-based 原始行号), norm }]。
 * @param {string} source
 * @returns {Array<{lineNo:number, norm:string}>}
 */
function significantLines(source) {
  const out = [];
  const lines = String(source == null ? '' : source).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const norm = normalizeLine(lines[i]);
    if (isSignificant(norm)) out.push({ lineNo: i + 1, norm });
  }
  return out;
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex');
}

/**
 * 为单文件计算所有滑窗:[{ hash, startLine, endLine, sIdxStart, sIdxEnd }]。
 * sIdxStart/End 为**有效行序列**下标(用于同文件相邻窗口极大化合并)。
 * @param {Array<{lineNo:number,norm:string}>} sig
 * @param {number} minBlock
 */
function windowsForFile(sig, minBlock) {
  const wins = [];
  for (let i = 0; i + minBlock <= sig.length; i++) {
    const slice = sig.slice(i, i + minBlock);
    const hash = sha1(slice.map((s) => s.norm).join('\n'));
    wins.push({
      hash,
      startLine: slice[0].lineNo,
      endLine: slice[slice.length - 1].lineNo,
      sIdxStart: i,
      sIdxEnd: i + minBlock - 1,
    });
  }
  return wins;
}

/**
 * 归一化 baseline 入参为 hash 集合(接受 {entries:[{hash}]} 或 hash 数组或 Set)。
 * @param {*} baseline
 * @returns {Set<string>}
 */
function baselineHashSet(baseline) {
  const set = new Set();
  if (!baseline) return set;
  const push = (h) => { if (typeof h === 'string' && h) set.add(h); };
  if (baseline instanceof Set) { for (const h of baseline) push(h); return set; }
  if (Array.isArray(baseline)) { for (const e of baseline) push(typeof e === 'string' ? e : e && e.hash); return set; }
  if (Array.isArray(baseline.entries)) { for (const e of baseline.entries) push(e && e.hash); }
  return set;
}

/**
 * 集合级判定。一次吃进全部候选文件,跨文件找克隆伙伴。
 * @param {object} params
 * @param {Array<{relPath:string, source:string}>} params.files
 * @param {*}      [params.baseline]   {entries:[{hash}]} / hash[] / Set
 * @param {'warn'|'gate'} [params.mode='warn']
 * @param {number} [params.minBlock=4]
 * @param {object} [params.env=process.env]
 * @returns {{ findings: Array, classes: Array }}
 */
function assess(params) {
  const p = params || {};
  const env = p.env || {};
  const out = { findings: [], classes: [] };
  if (!isEnabled(env)) return out; // 门关:逐字节回退,空判定。

  let minBlock = Number(p.minBlock);
  if (!Number.isInteger(minBlock) || minBlock < 1) minBlock = DEFAULT_MIN_BLOCK;
  const mode = p.mode === 'gate' ? 'gate' : 'warn';
  const baseSet = baselineHashSet(p.baseline);

  const files = Array.isArray(p.files) ? p.files : [];

  // 每文件的有效行 + 窗口;并累积全局 hash → 出现位置。
  const perFile = []; // { relPath, sig, wins }
  const hashOccur = new Map(); // hash → [{file, startLine, endLine}]
  for (const f of files) {
    if (!f || typeof f.relPath !== 'string') continue;
    const sig = significantLines(f.source);
    const wins = windowsForFile(sig, minBlock);
    perFile.push({ relPath: f.relPath, sig, wins });
    for (const w of wins) {
      let arr = hashOccur.get(w.hash);
      if (!arr) { arr = []; hashOccur.set(w.hash, arr); }
      arr.push({ file: f.relPath, startLine: w.startLine, endLine: w.endLine });
    }
  }

  // 克隆类:某 hash 在 ≥2 个不同位置出现。
  const cloneHashes = new Set();
  for (const [hash, occ] of hashOccur) {
    if (occ.length >= 2) cloneHashes.add(hash);
  }

  // classes(供 --write-baseline):按 hash 排序。
  for (const hash of [...cloneHashes].sort()) {
    const occ = hashOccur.get(hash);
    out.classes.push({ hash, lines: minBlock, occurrences: occ.length });
  }

  // 每文件:把落在克隆窗口里的有效行下标打点 → 相邻合并为极大跨度 → 一跨度一条 finding。
  for (const pf of perFile) {
    const covered = new Map(); // sIdx → Set(该下标覆盖到的克隆 hash)
    for (const w of pf.wins) {
      if (!cloneHashes.has(w.hash)) continue;
      for (let s = w.sIdxStart; s <= w.sIdxEnd; s++) {
        let hs = covered.get(s);
        if (!hs) { hs = new Set(); covered.set(s, hs); }
        hs.add(w.hash);
      }
    }
    if (covered.size === 0) continue;

    const idxs = [...covered.keys()].sort((a, b) => a - b);
    let runStart = idxs[0];
    let prev = idxs[0];
    const spans = []; // { sStart, sEnd }
    for (let k = 1; k < idxs.length; k++) {
      if (idxs[k] === prev + 1) { prev = idxs[k]; continue; }
      spans.push({ sStart: runStart, sEnd: prev });
      runStart = idxs[k];
      prev = idxs[k];
    }
    spans.push({ sStart: runStart, sEnd: prev });

    for (const span of spans) {
      const startLine = pf.sig[span.sStart].lineNo;
      const endLine = pf.sig[span.sEnd].lineNo;
      // 跨度内涉及的克隆 hash + 伙伴文件。
      const spanHashes = new Set();
      for (let s = span.sStart; s <= span.sEnd; s++) {
        for (const h of covered.get(s)) spanHashes.add(h);
      }
      const partners = new Set();
      for (const h of spanHashes) {
        for (const o of hashOccur.get(h)) if (o.file !== pf.relPath) partners.add(o.file);
      }
      // gate 模式:跨度内全部 hash ∈ baseline → warning;含任一新 hash → error。
      let severity = 'warning';
      if (mode === 'gate') {
        let allKnown = true;
        for (const h of spanHashes) { if (!baseSet.has(h)) { allKnown = false; break; } }
        severity = allKnown ? 'warning' : 'error';
      }
      const nLines = endLine - startLine + 1;
      const partnerList = [...partners].sort();
      const partnerText = partnerList.length
        ? `与 ${partnerList.length} 处文件重复:${partnerList.join(', ')}`
        : '与同文件其它位置重复';
      out.findings.push({
        severity,
        rule: 'duplicate-block',
        file: pf.relPath,
        line: startLine,
        message: `重复代码块(${nLines} 行,含 ${spanHashes.size} 个重复窗口)${partnerText};请抽取为公共库统一维护`,
        snippet: pf.sig[span.sStart].norm.slice(0, 120),
        // 供 CLI 基线判定/写入(非展示字段)。
        hashes: [...spanHashes].sort(),
        startLine,
        endLine,
      });
    }
  }

  out.findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1
    : a.startLine - b.startLine || (a.hashes[0] < b.hashes[0] ? -1 : a.hashes[0] > b.hashes[0] ? 1 : 0)));
  return out;
}

module.exports = {
  DEFAULT_MIN_BLOCK,
  isEnabled,
  normalizeLine,
  isSignificant,
  significantLines,
  assess,
};
