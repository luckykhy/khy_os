'use strict';

/**
 * autoTestScaffolder.js — 自动测试脚手架（§3.3 行为守卫：自动化差异测试）。
 *
 * 测试不该是沉重负担，而是改代码时自动长出的安全网。本模块解析导出函数签名，按参数名启发
 * 推断边界用例（空值 / 空串 / 零 / 负数 / 极值 / 越界 / 空数组），生成 `node:test` 测试骨架——
 * 简单模型只需填断言，无需从零写测试架子。
 *
 * 生成的骨架对每个边界默认断言「调用不抛异常」作为契约快照基线（behavioral snapshot），
 * 并以 `// TODO: 补全行为断言` 标记需人/模型确认的行为定义点（§3.3 强制补全行为）。
 *
 * 纯字符串生成、确定性、零依赖、零 I/O。
 */

// 参数名 → 边界用例启发表。命中关键词即套用对应边界集。
const BOUNDARY_HEURISTICS = [
  { test: /(count|num|size|len|idx|index|limit|offset|age|qty|amount)/i,
    cases: ['0', '-1', '1', 'Number.MAX_SAFE_INTEGER'] },
  { test: /(str|text|name|msg|message|title|path|url|key|id|word)/i,
    cases: ["''", "'   '", "'a'", "'\\u{1F600}'"] },
  { test: /(list|arr|items|rows|set|coll|args)/i,
    cases: ['[]', '[null]', '[1,2,3]'] },
  { test: /(map|obj|opts|options|config|ctx|context|payload|data)/i,
    cases: ['{}', 'null', '{ a: 1 }'] },
  { test: /(flag|enable|is|has|should|bool)/i,
    cases: ['true', 'false'] },
];
const DEFAULT_CASES = ['null', 'undefined', "''", '0'];

class AutoTestScaffolder {
  /**
   * 解析源码导出的函数签名（纯函数）。
   * @param {string} source
   * @returns {Array<{name:string, params:string[]}>}
   */
  parseSignatures(source) {
    const src = String(source == null ? '' : source);
    const sigs = [];
    const seen = new Set();
    const add = (name, paramStr) => {
      if (!name || seen.has(name)) return;
      seen.add(name);
      sigs.push({ name, params: this._splitParams(paramStr) });
    };
    let m;
    const fnRe = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
    while ((m = fnRe.exec(src)) !== null) add(m[1], m[2]);
    const constRe = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
    while ((m = constRe.exec(src)) !== null) add(m[1], m[2]);
    return sigs;
  }

  /** 拆分形参串为干净的参数名（剥默认值/解构/rest）。 */
  _splitParams(paramStr) {
    return String(paramStr || '')
      .split(',')
      .map((p) => p.replace(/=.*/, '').replace(/\.\.\./, '').trim())
      .filter(Boolean)
      .map((p) => (/^[{[]/.test(p) ? p.replace(/[{}[\]\s]/g, '').split(':')[0] : p));
  }

  /** 为单个参数推断边界用例集。 */
  boundaryCasesFor(paramName) {
    for (const h of BOUNDARY_HEURISTICS) if (h.test.test(paramName)) return h.cases.slice();
    return DEFAULT_CASES.slice();
  }

  /**
   * 生成 node:test 测试骨架文件文本（纯函数）。
   * @param {Array<{name,params}>} signatures
   * @param {object} [opts] { requirePath, moduleName }
   * @returns {string}
   */
  scaffold(signatures, opts = {}) {
    const requirePath = opts.requirePath || './module';
    const moduleName = opts.moduleName || 'module';
    const exportsList = signatures.map((s) => s.name).join(', ');
    const out = [
      "'use strict';",
      '',
      `/**`,
      ` * ${moduleName} 行为守卫测试骨架（由 AutoTestScaffolder 自动生成）。`,
      ` * 默认断言「调用不抛」作为行为快照基线；请补全 TODO 处的行为断言（§3.3）。`,
      ` */`,
      '',
      "const test = require('node:test');",
      "const assert = require('node:assert');",
      `const { ${exportsList} } = require('${requirePath}');`,
      '',
    ];
    for (const sig of signatures) {
      out.push(`test('${sig.name} — 行为快照基线（不抛）', () => {`);
      if (!sig.params.length) {
        out.push(`  assert.doesNotThrow(() => ${sig.name}());`);
      } else {
        const argList = sig.params.map((p) => `/* ${p} */ undefined`).join(', ');
        out.push(`  // TODO: 补全行为断言`);
        out.push(`  assert.doesNotThrow(() => ${sig.name}(${argList}));`);
      }
      out.push('});', '');

      for (const param of sig.params) {
        const cases = this.boundaryCasesFor(param);
        out.push(`test('${sig.name} — 边界: ${param} ∈ {${cases.join(', ')}}', () => {`);
        for (const c of cases) {
          const args = sig.params.map((p) => (p === param ? c : 'undefined')).join(', ');
          out.push(`  assert.doesNotThrow(() => ${sig.name}(${args})); // TODO: 断言 ${param}=${c} 的预期行为`);
        }
        out.push('});', '');
      }
    }
    return out.join('\n');
  }
}

module.exports = { AutoTestScaffolder };
