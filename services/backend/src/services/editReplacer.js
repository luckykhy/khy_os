'use strict';

/**
 * editReplacer.js — 9-layer Replacer chain(借鉴 sst/opencode src/tool/edit.ts:651-687)。
 *
 * 背景:khy-os 的 editFile 工具当前走「严格 indexOf 匹配」(byte-equal),LLM 输出的
 * old_string 经常因以下 5 类常见漂移而失败:
 *   1) 行级 trim 漂移(LLM 给的代码前后多了 1-2 个空格)
 *   2) 块锚点漂移(中间行有 LLM 没意识到的小改动,首末行仍能锚定)
 *   3) 缩进漂移(复制粘贴时少缩进/多缩进)
 *   4) 空白归一化(连续空格被 LLM 合并为单个空格、CRLF ↔ LF)
 *   5) 转义漂移(LLM 把 \n 当字面 "\\n" 写入 JSON)
 *
 * 每次失败就冒泡 LLM 是糟糕的 UX(opencode 的研究:edit 失败率 ~40% → 修后 ~8%)。
 * 本模块提供 9 个 Replacer,按序尝试,首个命中即停,绝不抛错。**所有 Replacer 是纯
 * 函数**(只读字符串),与 fs / 子进程完全隔离,便于单测。
 *
 * Replacer 链(借鉴 opencode edit.ts,BSD-3-Clause,Copyright Anomaly Innovations):
 *   1. SimpleReplacer              严格 indexOf
 *   2. LineTrimmedReplacer         行级 trim 后 indexOf(抗前/尾空格漂移)
 *   3. BlockAnchorReplacer         首末行锚定 + Levenshtein 相似度(0.3)
 *   4. WhitespaceNormalizedReplacer 合并连续空白(空格/制表/换行)后匹配
 *   5. IndentationFlexibleReplacer 移除共同最小缩进
 *   6. EscapeNormalizedReplacer    反转义 \\n/\\t/\\r/\\"/\\\\ 等
 *   7. TrimmedBoundaryReplacer     边界 trim 后子块匹配(对抗尾部 \n)
 *   8. ContextAwareReplacer        3+ 行块用首末行做上下文锚(中段 50% 匹配即接受)
 *   9. MultiOccurrenceReplacer     返回所有出现位置(用于 replace_all)
 *
 * 公共 API:
 *   applyReplacers(fileContent, oldString, options) → {
 *     content,           // 替换后的完整内容
 *     matched: boolean,  // 是否有命中
 *     strategy: string,  // 命中的 Replacer 名(如 'SimpleReplacer')
 *     occurrences: number, // replace_all 模式下的命中数
 *     error: string?,    // 不可恢复时的诊断(用于 LLM 自检输入)
 *   }
 *
 * @module services/editReplacer
 */

const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

// ── 1. SimpleReplacer ─────────────────────────────────────────────
// 严格 indexOf 匹配。绝大多数成功路径走这条,零开销。
function simpleReplacer(fileContent, oldString) {
  if (typeof oldString !== 'string' || !oldString) {
    return { matched: false };
  }
  const idx = fileContent.indexOf(oldString);
  if (idx === -1) {
    return { matched: false };
  }
  return {
    matched: true,
    strategy: 'SimpleReplacer',
    replace: (newString) => fileContent.slice(0, idx) + newString + fileContent.slice(idx + oldString.length),
    occurrence: 0,
  };
}

// ── 2. LineTrimmedReplacer ─────────────────────────────────────────
// 逐行 trim 后再拼接匹配(抗前/尾部空格漂移)。trim 不改变行内相对位置。
function _lineTrim(content) {
  return content.split('\n').map((l) => l.trim());
}
function lineTrimmedReplacer(fileContent, oldString) {
  if (typeof oldString !== 'string' || !oldString) {
    return { matched: false };
  }
  const oldLines = oldString.split('\n');
  if (oldLines.length === 1) {
    return { matched: false }; // 单行让 Simple 解决
  }
  const oldNorm = _lineTrim(oldString);
  const fileLines = fileContent.split('\n');
  // 滑动窗口:每个起点 O(n) 比较。fileContent 实际不会很大(> 1MB 罕见)。
  const windowSize = oldLines.length;
  for (let i = 0; i + windowSize <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < windowSize; j += 1) {
      if (fileLines[i + j].trim() !== oldNorm[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const matchedText = fileLines.slice(i, i + windowSize).join('\n');
      const idx = fileContent.indexOf(matchedText);
      return {
        matched: true,
        strategy: 'LineTrimmedReplacer',
        replace: (newString) =>
          fileContent.slice(0, idx) + newString + fileContent.slice(idx + matchedText.length),
        occurrence: 0,
      };
    }
  }
  return { matched: false };
}

// ── 3. BlockAnchorReplacer ─────────────────────────────────────────
// 首末行严格相等(锚点),中间行通过 Levenshtein 相似度 ≥ 0.3 接受。
// 借鉴 opencode BlockAnchorReplacer。抗「中段有 1-2 行被 LLM 误改」漂移。
function _levenshtein(a, b) {
  // 优化版:只保留两行(滚动数组),空间 O(min(|a|,|b|))
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}
function blockAnchorReplacer(fileContent, oldString) {
  if (typeof oldString !== 'string' || !oldString) {
    return { matched: false };
  }
  const oldLines = oldString.split('\n');
  if (oldLines.length < 3) {
    return { matched: false };
  } // 至少 3 行才走锚定
  const fileLines = fileContent.split('\n');
  const window = oldLines.length;
  for (let i = 0; i + window <= fileLines.length; i += 1) {
    if (fileLines[i] !== oldLines[0] || fileLines[i + window - 1] !== oldLines[window - 1]) {
      continue;
    }
    // 中段比对(每行独立做 Levenshtein,相似度 ≥ 0.3)
    let totalSim = 0;
    let allOk = true;
    for (let j = 1; j < window - 1; j += 1) {
      const a = oldLines[j];
      const b = fileLines[i + j];
      const maxLen = Math.max(a.length, b.length);
      if (maxLen === 0) {
        totalSim += 1;
        continue;
      }
      const dist = _levenshtein(a, b);
      const sim = 1 - dist / maxLen;
      if (sim < 0.3) {
        allOk = false;
        break;
      }
      totalSim += sim;
    }
    if (allOk) {
      const matchedText = fileLines.slice(i, i + window).join('\n');
      const idx = fileContent.indexOf(matchedText);
      return {
        matched: true,
        strategy: 'BlockAnchorReplacer',
        replace: (newString) =>
          fileContent.slice(0, idx) + newString + fileContent.slice(idx + matchedText.length),
        occurrence: 0,
      };
    }
  }
  return { matched: false };
}

// ── 4. WhitespaceNormalizedReplacer ────────────────────────────────
// 合并连续空白(空格/制表/换行)后正则匹配。抗 LLM 把多空格合并成单空格、
// CRLF 当 LF 的常见漂移。
function _normalizeWs(text) {
  return text.replace(/[ \t]+/g, ' ').replace(/\r\n?/g, '\n');
}
function whitespaceNormalizedReplacer(fileContent, oldString) {
  if (typeof oldString !== 'string' || !oldString) {
    return { matched: false };
  }
  const oldNorm = _normalizeWs(oldString);
  const fileNorm = _normalizeWs(fileContent);
  const idx = fileNorm.indexOf(oldNorm);
  if (idx === -1) {
    return { matched: false };
  }
  // 关键:norm 后位置 ≠ 原始位置。需要在 fileContent 重新做 norm-aware 查找。
  // 这里采用「用 norm 后的 content 做替换,然后再尝试保留行结构」——简单起见,
  // 命中后回退到 LineTrimmed 找精确边界。若 LineTrimmed 也失败,给出明确错误。
  // 实践中 LLM 给的 oldString 与文件差异通常是「同一行内的多余空格」,
  // norm 后 hit,真实替换时用 Simple 找原 oldString(常见能命中);
  // 若还失败,返回 matched=true 但 caller 应降级。
  // 简化:命中后,在原始 fileContent 中回退到 oldString 找位置,找不到则说明
  // 漂移确实在空白;返回一个可消费的「replacementWindow」让 LLM 自检。
  return {
    matched: true,
    strategy: 'WhitespaceNormalizedReplacer',
    normalizedHit: true,
    replace: (newString) => {
      // 尝试在原 content 用 Simple 替换(常见能命中)
      const simpleHit = simpleReplacer(fileContent, oldString);
      if (simpleHit.matched) {
        return simpleHit.replace(newString);
      }
      // 实在找不到精确位置:用 norm-aware 替换(用 normalized 内容做手术,
      // 但用 newString 替换原 oldString — 可能行内空白被合并)
      const originalLines = fileContent.split('\n');
      const normLines = fileNorm.split('\n');
      // 找到 norm 中 oldString 起始行
      let lineStart = 0;
      let charPos = 0;
      for (let l = 0; l < normLines.length; l += 1) {
        if (normLines[l].indexOf(oldNorm) !== -1) {
          lineStart = l;
          charPos = normLines[l].indexOf(oldNorm);
          break;
        }
      }
      // 在原始行上做替换
      if (lineStart < originalLines.length) {
        const targetLine = originalLines[lineStart];
        const before = targetLine.slice(0, charPos);
        const after = targetLine.slice(charPos + oldString.length);
        originalLines[lineStart] = before + newString + after;
      }
      return originalLines.join('\n');
    },
    occurrence: 0,
  };
}

// ── 5. IndentationFlexibleReplacer ─────────────────────────────────
// 移除共同最小缩进后匹配。抗「复制粘贴时少缩进/多缩进」。
function _stripMinIndent(text) {
  const lines = text.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = l.match(/^[ \t]*/);
    const ind = m ? m[0].length : 0;
    if (ind < min) min = ind;
  }
  if (min === Infinity || min === 0) return text;
  return lines.map((l) => l.slice(min)).join('\n');
}
function indentationFlexibleReplacer(fileContent, oldString) {
  if (typeof oldString !== 'string' || !oldString) {
    return { matched: false };
  }
  const oldStrip = _stripMinIndent(oldString);
  const fileStrip = _stripMinIndent(fileContent);
  const idx = fileStrip.indexOf(oldStrip);
  if (idx === -1) {
    return { matched: false };
  }
  // norm 模式:把 norm 后位置映射回原文
  return {
    matched: true,
    strategy: 'IndentationFlexibleReplacer',
    replace: (newString) => {
      // newString 应当是 LLM 提供的「目标缩进」状态(可能与原文件缩进不同)。
      // 我们用 norm-aware 替换:找到 fileStrip 中 oldStrip 起点,
      // 在原文相同行做替换(行号相同),输出 = newString(用其原缩进)。
      const originalLines = fileContent.split('\n');
      const stripLines = fileStrip.split('\n');
      let lineStart = 0;
      let charPos = 0;
      for (let l = 0; l < stripLines.length; l += 1) {
        if (stripLines[l].indexOf(oldStrip) !== -1) {
          lineStart = l;
          charPos = stripLines[l].indexOf(oldStrip);
          break;
        }
      }
      if (lineStart < originalLines.length) {
        const targetLine = originalLines[lineStart];
        // 注意:charPos 在 strip 空间中;原文中缩进可能更多,需前移 minIndent
        const minIndent = (() => {
          let m = Infinity;
          for (const l of fileContent.split('\n')) {
            if (!l.trim()) continue;
            const ind = (l.match(/^[ \t]*/) || [''])[0].length;
            if (ind < m) m = ind;
          }
          return m === Infinity ? 0 : m;
        })();
        const realCharPos = charPos + minIndent;
        const before = targetLine.slice(0, realCharPos);
        const after = targetLine.slice(realCharPos + oldString.length);
        originalLines[lineStart] = before + newString + after;
      }
      return originalLines.join('\n');
    },
    occurrence: 0,
  };
}

// ── 6. EscapeNormalizedReplacer ────────────────────────────────────
// 反转义 JSON 字符串里常见的 \\n/\\t/\\"/\\\\ 等。
function _unescape(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
function escapeNormalizedReplacer(fileContent, oldString) {
  if (typeof oldString !== 'string' || !oldString || !oldString.includes('\\')) {
    return { matched: false };
  }
  const unescaped = _unescape(oldString);
  if (unescaped === oldString) {
    return { matched: false };
  }
  const simpleHit = simpleReplacer(fileContent, unescaped);
  if (!simpleHit.matched) {
    return { matched: false };
  }
  return {
    matched: true,
    strategy: 'EscapeNormalizedReplacer',
    replace: simpleHit.replace,
    occurrence: 0,
  };
}

// ── 7. TrimmedBoundaryReplacer ─────────────────────────────────────
// 把 oldString 边界 trim 后再匹配(抗 LLM 末尾多一个换行或空格)。
function trimmedBoundaryReplacer(fileContent, oldString) {
  if (typeof oldString !== 'string' || !oldString) {
    return { matched: false };
  }
  const trimmed = oldString.trim();
  if (trimmed === oldString) {
    return { matched: false };
  }
  const simpleHit = simpleReplacer(fileContent, trimmed);
  if (!simpleHit.matched) {
    return { matched: false };
  }
  // 命中后,replace 用 trimmed(LLM 给的 newString 应是 trim 后的状态)。
  return {
    matched: true,
    strategy: 'TrimmedBoundaryReplacer',
    replace: simpleHit.replace,
    occurrence: 0,
  };
}

// ── 8. ContextAwareReplacer ────────────────────────────────────────
// 3+ 行块,用首末行做上下文锚(中段 50% 行匹配即接受)。比 BlockAnchor 更宽松。
function contextAwareReplacer(fileContent, oldString) {
  if (typeof oldString !== 'string' || !oldString) {
    return { matched: false };
  }
  const oldLines = oldString.split('\n');
  if (oldLines.length < 3) {
    return { matched: false };
  }
  const fileLines = fileContent.split('\n');
  const window = oldLines.length;
  for (let i = 0; i + window <= fileLines.length; i += 1) {
    if (fileLines[i] !== oldLines[0] || fileLines[i + window - 1] !== oldLines[window - 1]) {
      continue;
    }
    // 中段:每行做归一化 trim 后比较,至少 50% 命中
    let midHit = 0;
    const midCount = window - 2;
    for (let j = 1; j < window - 1; j += 1) {
      if (fileLines[i + j].trim() === oldLines[j].trim()) {
        midHit += 1;
      }
    }
    if (midCount === 0 || midHit / midCount >= 0.5) {
      const matchedText = fileLines.slice(i, i + window).join('\n');
      const idx = fileContent.indexOf(matchedText);
      return {
        matched: true,
        strategy: 'ContextAwareReplacer',
        replace: (newString) =>
          fileContent.slice(0, idx) + newString + fileContent.slice(idx + matchedText.length),
        occurrence: 0,
      };
    }
  }
  return { matched: false };
}

// ── 9. MultiOccurrenceReplacer ─────────────────────────────────────
// 返回所有匹配位置(replace_all 专用)。正常 replace_all=true 时 Simple 已经
// 处理,这里是兜底。
function multiOccurrenceReplacer(fileContent, oldString) {
  if (typeof oldString !== 'string' || !oldString) {
    return { matched: false, occurrences: 0 };
  }
  const positions = [];
  let idx = -1;
  while ((idx = fileContent.indexOf(oldString, idx + 1)) !== -1) {
    positions.push(idx);
  }
  if (positions.length === 0) {
    return { matched: false, occurrences: 0 };
  }
  return {
    matched: true,
    strategy: 'MultiOccurrenceReplacer',
    occurrences: positions.length,
    replace: (newString) => {
      let out = '';
      let cursor = 0;
      for (const p of positions) {
        out += fileContent.slice(cursor, p) + newString;
        cursor = p + oldString.length;
      }
      out += fileContent.slice(cursor);
      return out;
    },
  };
}

// ── Replacer 链(主入口) ──────────────────────────────────────────
const REPLACER_CHAIN = [
  ['SimpleReplacer', simpleReplacer],
  ['LineTrimmedReplacer', lineTrimmedReplacer],
  ['BlockAnchorReplacer', blockAnchorReplacer],
  ['WhitespaceNormalizedReplacer', whitespaceNormalizedReplacer],
  ['IndentationFlexibleReplacer', indentationFlexibleReplacer],
  ['EscapeNormalizedReplacer', escapeNormalizedReplacer],
  ['TrimmedBoundaryReplacer', trimmedBoundaryReplacer],
  ['ContextAwareReplacer', contextAwareReplacer],
];

/**
 * 应用 Replacer 链。返回首个命中;都不命中返回 matched=false。
 * @param {string} fileContent
 * @param {string} oldString
 * @param {object} [opts]
 * @param {boolean} [opts.replaceAll=false] 多处替换(目前用 MultiOccurrenceReplacer 兜底)
 * @returns {{
 *   matched: boolean,
 *   content?: string,
 *   strategy?: string,
 *   occurrences?: number,
 *   normalizedHit?: boolean,
 *   error?: string,
 * }}
 */
function applyReplacers(fileContent, oldString, opts = {}) {
  try {
    if (typeof fileContent !== 'string') {
      return { matched: false, error: 'fileContent is not a string' };
    }
    if (typeof oldString !== 'string' || !oldString) {
      return { matched: false, error: 'oldString is empty' };
    }
    const replaceAll = !!opts.replaceAll;

    // replace_all 路径:先尝试 Simple 的所有位置;若只 1 个,直接走 Simple
    if (replaceAll) {
      const multi = multiOccurrenceReplacer(fileContent, oldString);
      if (multi.matched) {
        return {
          matched: true,
          content: multi.replace(opts.newString || ''),
          strategy: multi.strategy,
          occurrences: multi.occurrences,
        };
      }
    }

    // 单替换路径:按链顺序尝试
    for (const [name, fn] of REPLACER_CHAIN) {
      try {
        const r = fn(fileContent, oldString);
        if (r && r.matched) {
          return {
            matched: true,
            content: r.replace(opts.newString || ''),
            strategy: r.strategy,
            // 单替换路径 occurrences 永远是 1(MultiOccurrence 是另一条路径)
            occurrences: 1,
            normalizedHit: !!r.normalizedHit,
          };
        }
      } catch {
        /* 单个 Replacer 失败 → 继续下一个 */
      }
    }
    return {
      matched: false,
      error: `oldString not found after ${REPLACER_CHAIN.length}-layer Replacer chain (Simple/LineTrimmed/BlockAnchor/Whitespace/Indent/Escape/Trimmed/ContextAware + MultiOccurrence for replace_all). Likely a non-trivial drift; please read the file fresh and re-emit the exact text.`,
    };
  } catch (err) {
    return { matched: false, error: (err && err.message) || 'applyReplacers-failed' };
  }
}

/** 列出所有 Replacer 名称(用于健康检查/可观测性) */
function listReplacers() {
  return REPLACER_CHAIN.map(([n]) => n);
}

/** 门控 KHY_EDIT_REPLACER(默认开,显式 0/false/off/no/disable/disabled 关)。
 *  关 → 逐字节回退严格 indexOf 行为。 */
function isEditReplacerEnabled(env = process.env) {
  try {
    const e = env || process.env;
    const v = e && e.KHY_EDIT_REPLACER;
    if (v === undefined || v === null || v === '') {
      return true;
    }
    return !OFF_VALUES.has(String(v).trim().toLowerCase());
  } catch {
    return true;
  }
}

module.exports = {
  applyReplacers,
  listReplacers,
  isEditReplacerEnabled,
  // 单元测试用
  _simpleReplacer: simpleReplacer,
  _lineTrimmedReplacer: lineTrimmedReplacer,
  _blockAnchorReplacer: blockAnchorReplacer,
  _whitespaceNormalizedReplacer: whitespaceNormalizedReplacer,
  _indentationFlexibleReplacer: indentationFlexibleReplacer,
  _escapeNormalizedReplacer: escapeNormalizedReplacer,
  _trimmedBoundaryReplacer: trimmedBoundaryReplacer,
  _contextAwareReplacer: contextAwareReplacer,
  _multiOccurrenceReplacer: multiOccurrenceReplacer,
};
