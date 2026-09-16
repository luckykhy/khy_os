'use strict';

const fs = require('fs');
const path = require('path');

/**
 * externalRules.js — 找出「检查器在执行、但登记表从未收录」的规则 ID。
 *
 * 为什么需要这个视角：覆盖率的分母只有登记表里的 44 条规则，所以一个检查器
 * 可以稳稳地执行着 26 条写在设计文档里的规则（SEC-001 / NAM-001 / UPLOAD-001 …），
 * 而 `rules:coverage` 对它完全看不见——既不进分母，也不进「未挂载执行器」清单。
 * 那是比「规则没有检查器」更大的一类盲区：门在跑、规则在生效，但没有任何一处
 * 记录「这个门保护的是哪条规则」。
 *
 * 本模块只报告事实，不判定这 26 条该不该进登记表——那是人工裁决。它是 advisory，
 * `--ci` 下也不阻断：这些规则是真的在被执行，缺的是登记，不是执行。
 */

// 规则 ID 的形状：<PREFIX>-<NNN>，与登记表 ID（RUNTIME-001 / SECURITY-002）同形。
const RULE_ID_SHAPE = /\b[A-Z]{2,10}-\d{3}\b/g;

// 形状相同但不是规则的编码族。必须显式排除，否则把提示词分类编号当成
// 「登记表外的规则」，报告会被 35 条 PTX-* 淹没而丢掉真正的信号。
const CODE_FAMILIES = new Set([
  'PTX-', // check-prompt-taxonomy.js 的提示词分类编号（PTX-000 … PTX-103）
]);

/**
 * 扫描 scripts/ci/check-*.js，按检查器收集其自述的规则 ID，拆成登记表内/外两组。
 *
 * @param {string} repoRoot
 * @param {Set<string>} registryIds 登记表已有 ID
 * @returns {{ checkers: Array<{checker:string, registryIds:string[], externalIds:string[]}>,
 *             externalIds: Array<{id:string, checkers:string[]}>,
 *             codeFamilies: string[] }}
 */
function scanExternalRules(repoRoot, registryIds) {
  const dir = path.join(repoRoot, 'scripts', 'ci');
  const checkers = [];
  const byId = new Map();
  const codeFamilies = new Set();

  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { checkers, externalIds: [], codeFamilies: [] };
  }

  for (const file of files) {
    if (!/^check-.*\.js$/.test(file)) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }

    const tokens = new Set(text.match(RULE_ID_SHAPE) || []);
    const known = [];
    const external = [];
    for (const token of tokens) {
      if (CODE_FAMILIES.has(token.slice(0, token.indexOf('-') + 1))) {
        codeFamilies.add(token.slice(0, token.indexOf('-') + 1));
        continue;
      }
      if (registryIds.has(token)) known.push(token);
      else external.push(token);
    }
    if (!known.length && !external.length) continue;

    checkers.push({
      checker: file,
      registryIds: known.sort(),
      externalIds: external.sort(),
    });
    for (const id of external) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(file);
    }
  }

  checkers.sort((a, b) => a.checker.localeCompare(b.checker));
  const externalIds = [...byId.entries()]
    .map(([id, list]) => ({ id, checkers: list.sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { checkers, externalIds, codeFamilies: [...codeFamilies].sort() };
}

module.exports = { scanExternalRules, RULE_ID_SHAPE, CODE_FAMILIES };
