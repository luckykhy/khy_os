'use strict';

/**
 * deviceAppListParsers.js — 包管理器 list 原始输出的纯解析叶子(从 deviceAppsPolicy.js 行为保真抽出)。
 *
 * 记录形状:{ name, id, version }。id 为包管理器稳定标识(winget Id / dpkg 包名 / …);无独立
 * id 者令 id === name。解析尽量宽松、绝不抛;无法解析的行跳过。零 IO、确定性、不引用
 * deviceAppsPolicy 的任何符号(无 back-edge、不成环)。deviceAppsPolicy 重新 require 再导出
 * parseListOutput,公共面与抽取前逐字节一致。
 */

// ── list 输出解析器(纯字符串 → 记录)────────────────────────────────────────────
// 记录形状:{ name, id, version }。id 为包管理器稳定标识(winget Id / dpkg 包名 / …);
// 无独立 id 的包管理器令 id === name。解析尽量宽松、绝不抛;无法解析的行跳过。

function _parseDpkg(text) {
  // dpkg -l:数据行以 `ii ` 起(已安装)。列:Desired/Status name version arch desc。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^ii\s+(\S+)\s+(\S+)/.exec(line);
    if (!m) {
      continue;
    }
    const name = m[1].replace(/:.*/, ''); // 去架构后缀 name:amd64
    out.push({ name, id: name, version: m[2] });
  }
  return out;
}

function _parseBrew(text) {
  // brew list --versions:`name 1.2.3 [1.2.2]`,每行一个;首 token=名,其余为版本。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    const parts = t.split(/\s+/);
    const name = parts[0];
    if (!name) {
      continue;
    }
    out.push({ name, id: name, version: parts.slice(1).join(' ') || '' });
  }
  return out;
}

function _parsePacman(text) {
  // pacman -Q:`name 1.2.3-1`,每行一个。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    const parts = t.split(/\s+/);
    if (parts.length < 1) {
      continue;
    }
    out.push({ name: parts[0], id: parts[0], version: parts[1] || '' });
  }
  return out;
}

function _parseChoco(text) {
  // choco list --local-only --limit-output:`name|version`。也宽松兼容空格分隔。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    if (/packages installed/i.test(t)) {
      continue;
    } // 汇总行
    let name, version;
    if (t.includes('|')) {
      [name, version] = t.split('|');
    } else {
      const parts = t.split(/\s+/);
      name = parts[0];
      version = parts[1] || '';
    }
    name = (name || '').trim();
    if (!name) {
      continue;
    }
    out.push({ name, id: name, version: (version || '').trim() });
  }
  return out;
}

function _parseDnf(text) {
  // dnf list installed:`name.arch  version  repo`。跳过标题行 "Installed Packages"。
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^installed packages/i.test(t)) {
      continue;
    }
    const parts = t.split(/\s+/);
    if (parts.length < 2) {
      continue;
    }
    const name = parts[0].replace(/\.[^.]+$/, ''); // 去 .x86_64 架构
    if (!name) {
      continue;
    }
    out.push({ name, id: parts[0], version: parts[1] });
  }
  return out;
}

function _parseWinget(text) {
  // winget list:表格,含标题行(Name Id Version …)+ 分隔线,列宽随内容变化。
  // 稳健策略:定位标题行的 Id/Version 列起始偏移,按偏移切列。定位失败 → 回退 2+ 空格切分。
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (
      /(^|\s)Name(\s)/.test(lines[i]) &&
      /\bId\b/.test(lines[i]) &&
      /\bVersion\b/.test(lines[i])
    ) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx >= 0) {
    const header = lines[headerIdx];
    const idCol = header.indexOf('Id');
    const verCol = header.indexOf('Version');
    if (idCol > 0 && verCol > idCol) {
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) {
          continue;
        }
        if (/^[-─\s]+$/.test(line)) {
          continue;
        } // 分隔线
        const name = line.slice(0, idCol).trim();
        const id = line.slice(idCol, verCol).trim();
        const version = line.slice(verCol).trim().split(/\s+/)[0] || '';
        if (!name && !id) {
          continue;
        }
        out.push({ name: name || id, id: id || name, version });
      }
      return out;
    }
  }
  // 回退:无法定位列 → 尽力按 2+ 空格切分(honest best-effort)。
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^[-─\s]+$/.test(t)) {
      continue;
    }
    if (/(^|\s)Name(\s)/.test(t) && /\bId\b/.test(t)) {
      continue;
    } // 跳标题
    const parts = t.split(/\s{2,}/);
    if (parts.length < 2) {
      continue;
    }
    out.push({ name: parts[0], id: parts[1], version: parts[2] || '' });
  }
  return out;
}

const _PARSERS = Object.freeze({
  dpkg: _parseDpkg,
  brew: _parseBrew,
  pacman: _parsePacman,
  choco: _parseChoco,
  dnf: _parseDnf,
  winget: _parseWinget,
});

/**
 * 把某包管理器的 list 原始输出解析为记录数组。解析器缺失/异常 → 返回 [](绝不抛)。
 * @param {string} parserId pm.parse
 * @param {string} text 原始 stdout
 * @returns {Array<{name:string,id:string,version:string}>}
 */
function parseListOutput(parserId, text) {
  const fn = _PARSERS[parserId];
  if (typeof fn !== 'function') {
    return [];
  }
  try {
    return fn(text) || [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  parseListOutput,
};
