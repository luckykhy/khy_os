'use strict';

/**
 * autoTestScaffolder.js — 自动测试脚手架（§3.3 行为守卫：自动化差异测试）。
 *
 * 测试不该是沉重负担，而是改代码时自动长出的安全网。本模块解析导出函数签名，按参数名启发
 * 推断边界用例（空值 / 空串 / 零 / 负数 / 极值 / 越界 / 空数组），生成 `node:test` 测试骨架——
 * 简单模型只需填断言，无需从零写测试架子。
 *
 * 生成的骨架包含三种测试：
 *   1. **结构测试**（自动）：函数存在、可调用、参数数量正确
 *   2. **契约测试**（半自动）：基于 JSDoc 类型注解生成断言
 *   3. **行为测试**（手动）：留 TODO 注释，CI 统计"行为测试覆盖率"
 *
 * 行为测试覆盖率门禁：
 *   - 覆盖率 < 50% 时 PR 警告（不阻断，但显示在 PR 评论中）
 *   - `khy test-coverage` 显示每个函数的行为测试状态
 *   - README 中的"行为测试覆盖率"徽章
 *
 * 纯字符串生成、确定性、零依赖、零 I/O。
 */

// 参数名 → 边界用例启发表。命中关键词即套用对应边界集。
const BOUNDARY_HEURISTICS = [
  {
    test: /(count|num|size|len|idx|index|limit|offset|age|qty|amount)/i,
    cases: ['0', '-1', '1', 'Number.MAX_SAFE_INTEGER'],
  },
  {
    test: /(str|text|name|msg|message|title|path|url|key|id|word)/i,
    cases: ["''", "'   '", "'a'", "'\\u{1F600}'"],
  },
  { test: /(list|arr|items|rows|set|coll|args)/i, cases: ['[]', '[null]', '[1,2,3]'] },
  {
    test: /(map|obj|opts|options|config|ctx|context|payload|data)/i,
    cases: ['{}', 'null', '{ a: 1 }'],
  },
  { test: /(flag|enable|is|has|should|bool)/i, cases: ['true', 'false'] },
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
      if (!name || seen.has(name)) {
        return;
      }
      seen.add(name);
      sigs.push({ name, params: this._splitParams(paramStr) });
    };
    let m;
    const fnRe = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
    while ((m = fnRe.exec(src)) !== null) {
      add(m[1], m[2]);
    }
    const constRe =
      /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
    while ((m = constRe.exec(src)) !== null) {
      add(m[1], m[2]);
    }
    return sigs;
  }

  /** 拆分形参串为干净的参数名（剥默认值/解构/rest）。 */
  _splitParams(paramStr) {
    return String(paramStr || '')
      .split(',')
      .map((p) =>
        p
          .replace(/=.*/, '')
          .replace(/\.\.\./, '')
          .trim()
      )
      .filter(Boolean)
      .map((p) => (/^[{[]/.test(p) ? p.replace(/[{}[\]\s]/g, '').split(':')[0] : p));
  }

  /** 为单个参数推断边界用例集。 */
  boundaryCasesFor(paramName) {
    for (const h of BOUNDARY_HEURISTICS) {
      if (h.test.test(paramName)) {
        return h.cases.slice();
      }
    }
    return DEFAULT_CASES.slice();
  }

  /**
   * 生成 node:test 测试骨架文件文本（纯函数）。
   *
   * 生成的测试包含三种类型：
   *   1. STRUCTURAL: 函数存在且可调用（自动，高置信度）
   *   2. CONTRACT: 基于 JSDoc 类型注解的断言（半自动）
   *   3. BEHAVIORAL: 需要手动补全的行为断言（留 TODO）
   *
   * @param {Array<{name,params}>} signatures
   * @param {object} [opts] { requirePath, moduleName, jsdocTypes }
   * @returns {string}
   */
  scaffold(signatures, opts = {}) {
    const requirePath = opts.requirePath || './module';
    const moduleName = opts.moduleName || 'module';
    const jsdocTypes = opts.jsdocTypes || {}; // 从 JSDoc 提取的类型信息
    const exportsList = signatures.map((s) => s.name).join(', ');
    const out = [
      "'use strict';",
      '',
      `/**`,
      ` * ${moduleName} 行为守卫测试骨架（由 AutoTestScaffolder 自动生成）。`,
      ` *`,
      ` * 测试类型说明：`,
      ` *   - [STRUCTURAL] 函数存在、可调用、参数数量正确（自动）`,
      ` *   - [CONTRACT]   基于 JSDoc 类型注解的断言（半自动）`,
      ` *   - [BEHAVIORAL] 需手动补全的行为断言（留 TODO）`,
      ` *`,
      ` * 行为测试覆盖率 = BEHAVIORAL 已补全 / BEHAVIORAL 总数`,
      ` * 目标覆盖率：>= 50%（CI warning），>= 80%（推荐）`,
      ` *`,
      ` * 补全指南：`,
      ` *   1. 找到 // [BEHAVIORAL TODO] 注释`,
      ` *   2. 将 assert.doesNotThrow 替换为具体的 assert.equal / assert.deepStrictEqual 等`,
      ` *   3. 参考 [CONTRACT] 测试中的类型断言`,
      ` */`,
      '',
      "const test = require('node:test');",
      "const assert = require('node:assert');",
      `const { ${exportsList} } = require('${requirePath}');`,
      '',
      `// ── 覆盖率统计 ──────────────────────────────────────────────`,
      `// 行为测试覆盖率 = 已补全 / 总数`,
      `// 运行 khy test-coverage 查看详情`,
      '',
    ];

    let totalBehavioral = 0;
    let placeholderBehavioral = 0;

    for (const sig of signatures) {
      // ── 1. 结构测试（自动）──
      out.push(`// [STRUCTURAL] ${sig.name}: 函数存在且可调用`);
      out.push(`test('${sig.name} — 结构: 函数存在且可调用', () => {`);
      out.push(`  assert.strictEqual(typeof ${sig.name}, 'function', '${sig.name} 应该是函数');`);
      out.push(`  assert.strictEqual(${sig.name}.length, ${sig.params.length}, '参数数量应为 ${sig.params.length}');`);
      out.push('});', '');

      // ── 2. 契约测试（半自动：基于 JSDoc 类型）──
      const typeInfo = jsdocTypes[sig.name] || {};
      if (sig.params.length > 0 && Object.keys(typeInfo).length > 0) {
        out.push(`// [CONTRACT] ${sig.name}: 参数类型契约（基于 JSDoc）`);
        out.push(`test('${sig.name} — 契约: 参数类型校验', () => {`);
        for (const param of sig.params) {
          const paramType = typeInfo[param];
          if (paramType === 'number') {
            out.push(`  // ${param}: number`);
            out.push(`  assert.strictEqual(typeof ${param}, 'number', '${param} 应该是 number');`);
          } else if (paramType === 'string') {
            out.push(`  // ${param}: string`);
            out.push(`  assert.ok(typeof ${param} === 'string' || ${param} instanceof String, '${param} 应该是 string');`);
          } else if (paramType === 'boolean') {
            out.push(`  // ${param}: boolean`);
            out.push(`  assert.strictEqual(typeof ${param}, 'boolean', '${param} 应该是 boolean');`);
          } else if (paramType === 'Array' || paramType === 'array') {
            out.push(`  // ${param}: Array`);
            out.push(`  assert.ok(Array.isArray(${param}), '${param} 应该是数组');`);
          } else if (paramType === 'object' || paramType === 'Object') {
            out.push(`  // ${param}: object`);
            out.push(`  assert.strictEqual(typeof ${param}, 'object', '${param} 应该是对象');`);
            out.push(`  assert.notStrictEqual(${param}, null, '${param} 不应为 null');`);
          }
        }
        out.push('});', '');
      }

      // ── 3. 行为测试（手动：需要补全）──
      // 基线：调用不抛出
      out.push(`// [BEHAVIORAL TODO] ${sig.name}: 行为快照基线（需补全为具体断言）`);
      out.push(`test('${sig.name} — 行为: 基线（不抛）', () => {`);
      if (!sig.params.length) {
        out.push(`  // [BEHAVIORAL TODO] 验证返回值类型和预期结果`);
        out.push(`  const result = ${sig.name}();`);
        out.push(`  assert.doesNotThrow(() => ${sig.name}()); // 替换为具体断言`);
        totalBehavioral++;
        placeholderBehavioral++;
      } else {
        const argList = sig.params.map((p) => `/* ${p} */ undefined`).join(', ');
        out.push(`  // [BEHAVIORAL TODO] 验证返回值类型和预期结果`);
        out.push(`  const result = ${sig.name}(${argList});`);
        out.push(`  assert.doesNotThrow(() => ${sig.name}(${argList})); // 替换为具体断言`);
        totalBehavioral++;
        placeholderBehavioral++;
      }
      out.push('});', '');

      // 边界测试（行为测试）
      for (const param of sig.params) {
        const cases = this.boundaryCasesFor(param);
        out.push(`// [BEHAVIORAL TODO] ${sig.name}: 边界行为（需补全预期结果）`);
        out.push(`test('${sig.name} — 行为: 边界 ${param}', () => {`);
        for (const c of cases) {
          const args = sig.params.map((p) => (p === param ? c : 'undefined')).join(', ');
          out.push(`  // [BEHAVIORAL TODO] ${param}=${c} 时，预期行为是？`);
          out.push(`  assert.doesNotThrow(() => ${sig.name}(${args})); // 替换为预期结果断言`);
          totalBehavioral++;
          placeholderBehavioral++;
        }
        out.push('});', '');
      }
    }

    // 覆盖率信息
    out.push(`// ──────────────────────────────────────────────────────────`);
    out.push(`// 测试覆盖率统计（由 khy test-coverage 自动生成）`);
    out.push(`// BEHAVIORAL 总数: ${totalBehavioral}`);
    out.push(`// BEHAVIORAL 占位: ${placeholderBehavioral}`);
    out.push(`// 当前覆盖率: 0% (${placeholderBehavioral}/${totalBehavioral} 待补全)`);
    out.push(`// 目标覆盖率: >= 50% (warning) / >= 80% (推荐)`);

    return out.join('\n');
  }

  /**
   * 从源代码中提取 JSDoc 类型信息（纯函数）。
   * 简单解析 @param {type} name 注释。
   * @param {string} source
   * @returns {Object<string, Object<string, string>>} { funcName: { paramName: type } }
   */
  extractJsdocTypes(source) {
    const src = String(source == null ? '' : source);
    const result = {};
    const lines = src.split('\n');
    let currentFunc = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // 检测 JSDoc @param
      const paramMatch = line.match(/@param\s+\{(\w+)\}\s+(\w+)/);
      if (paramMatch && currentFunc) {
        if (!result[currentFunc]) result[currentFunc] = {};
        result[currentFunc][paramMatch[2]] = paramMatch[1];
      }

      // 检测函数定义（简单检测）
      const funcMatch = line.match(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      if (funcMatch) {
        currentFunc = funcMatch[1];
        if (!result[currentFunc]) result[currentFunc] = {};
      }
      const arrowMatch = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/);
      if (arrowMatch) {
        currentFunc = arrowMatch[1];
        if (!result[currentFunc]) result[currentFunc] = {};
      }
    }
    return result;
  }

  /**
   * 计算行为测试覆盖率。
   * @param {string} testSource 生成的测试代码
   * @returns {Object} { total, completed, placeholder, coverage }
   */
  calculateCoverage(testSource) {
    const src = String(testSource || '');
    const totalMatches = src.match(/\/\/ \[BEHAVIORAL TODO\]/g) || [];
    const placeholderMatches = src.match(/\/\/ 替换为具体断言|\/\/ 替换为预期结果断言/g) || [];
    const total = totalMatches.length;
    const placeholder = placeholderMatches.length;
    const completed = total - placeholder;
    const coverage = total > 0 ? Math.round((completed / total) * 100) : 100;
    return { total, completed, placeholder, coverage };
  }
}

/**
 * CLI 命令：khy test-coverage
 * 生成测试覆盖率报告。
 * 使用方式：khy test-coverage <source-file>
 */
function generateCoverageReport(sourceFile) {
  const fs = require('fs');
  try {
    const source = fs.readFileSync(sourceFile, 'utf-8');
    const scaffolder = new AutoTestScaffolder();
    const signatures = scaffolder.parseSignatures(source);
    const jsdocTypes = scaffolder.extractJsdocTypes(source);
    const testCode = scaffolder.scaffold(signatures, {
      requirePath: sourceFile,
      moduleName: path.basename(sourceFile, '.js'),
      jsdocTypes,
    });
    const coverage = scaffolder.calculateCoverage(testCode);
    console.log(`\n测试覆盖率报告: ${sourceFile}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`函数数量:     ${signatures.length}`);
    console.log(`行为测试总数: ${coverage.total}`);
    console.log(`已补全:       ${coverage.completed}`);
    console.log(`待补全:       ${coverage.placeholder}`);
    console.log(`覆盖率:       ${coverage.coverage}%`);
    console.log(`状态:         ${coverage.coverage >= 50 ? '✅ PASS' : '⚠️  WARNING (< 50%)'}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    return coverage;
  } catch (err) {
    console.error(`错误: ${err.message}`);
    return null;
  }
}

module.exports = { AutoTestScaffolder, generateCoverageReport };
