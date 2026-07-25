'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const guard = require('../lib/leafContractGuard');

const repoRoot = path.resolve(__dirname, '..', '..');
function readSrc(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

// 冲突标记用拼接构造,确保**本测试文件**源码里不出现 7 连字符的字面 marker
// (否则守卫扫测试文件本身会误报,且违背「测试里别写真冲突」纪律)。
const C_START = '<'.repeat(7) + ' Updated upstream';
const C_MID = '='.repeat(7);
const C_END = '>'.repeat(7) + ' Stashed changes';

const LEAF_HEADER = "'use strict';\n/**\n * demo.js — 纯叶子:零 IO、确定性、绝不抛。env 门控 KHY_DEMO_GATE(默认开)。\n */\n";

// ── 门控 ────────────────────────────────────────────────────────────
test('isEnabled: 默认开', () => {
  assert.strictEqual(guard.isEnabled({}), true);
});
test('isEnabled: 0/false/off/no 关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(guard.isEnabled({ KHY_LEAF_CONTRACT_GUARD: v }), false);
  }
});
test('门控关闭 → assessFile 返回空 findings(即便有冲突标记)', () => {
  const src = `${C_START}\nx\n${C_MID}\ny\n${C_END}\n`;
  const r = guard.assessFile({ relPath: 'x.js', source: src, env: { KHY_LEAF_CONTRACT_GUARD: '0' } });
  assert.deepStrictEqual(r.findings, []);
});

// ── 纯叶子检测 ───────────────────────────────────────────────────────
test('declaresLeaf: 首块注释含「纯叶子」→ true', () => {
  assert.strictEqual(guard.declaresLeaf(LEAF_HEADER), true);
});
test('declaresLeaf: 仅 // 行提到纯叶子(描述依赖)→ false', () => {
  const src = "'use strict';\n// 复用单一真源 foo 纯叶子,fail-soft require。\nconst x = 1;\n";
  assert.strictEqual(guard.declaresLeaf(src), false);
});
test('declaresLeaf: 真叶子识别 / 编排器不识别', () => {
  assert.strictEqual(guard.declaresLeaf(readSrc('services/backend/src/services/search/searchNecessity.js')), true);
  assert.strictEqual(guard.declaresLeaf(readSrc('services/backend/src/services/memoryTier.js')), true);
  assert.strictEqual(guard.declaresLeaf(readSrc('services/backend/src/services/toolUseLoop.js')), false);
  assert.strictEqual(guard.declaresLeaf(readSrc('services/backend/src/services/webSearchService.js')), false);
});
test('declaresLeaf: 「契约词…委托给纯叶子 <模块名>」式委派(模块名尾随 marker)→ false', () => {
  // after 分支排除「纯叶子 vaultCore(单一真源)」(模块名夹在中间);此为对称缺口:
  // 委派时契约词在前、模块名落在 marker **之后**——同样是描述别处的具名叶子,非自声明。
  const src = "'use strict';\n/**\n * fooService.js —— 本壳做所有 IO。\n"
    + " * 确定性文案与路径数学全部委托给纯叶子 fooCore.js。\n */\nconst fs = require('fs');\n";
  assert.strictEqual(guard.declaresLeaf(src), false);
  // 真自声明(标记后是标点/契约词,非模块名)仍为 true。
  const real = "'use strict';\n/**\n * bar.js — 确定性路径数学,单一真源(纯叶子)。\n */\nconst x = 1;\n";
  assert.strictEqual(guard.declaresLeaf(real), true);
  // selfEditAdvisoryService.js 是本缺口的真实触发者:壳,必须 false。
  assert.strictEqual(guard.declaresLeaf(readSrc('services/backend/src/services/selfEditAdvisoryService.js')), false);
});

// ── 规则 1:冲突标记 ─────────────────────────────────────────────────
test('conflict-marker: 同时含起止标记 → 逐行 error', () => {
  const src = `'use strict';\n${C_START}\nconst a = 1;\n${C_MID}\nconst a = 2;\n${C_END}\n`;
  const r = guard.assessFile({ relPath: 'x.js', source: src });
  const cm = r.findings.filter(f => f.rule === 'conflict-marker');
  assert.strictEqual(cm.length, 3);
  assert.ok(cm.every(f => f.severity === 'error'));
});
test('conflict-marker: 仅起始标记(markdown 孤立)→ 不误报', () => {
  const src = `# Diff 教程\n示例:\n${C_START}\n普通文本,无结束标记。\n`;
  const r = guard.assessFile({ relPath: 'README.md', source: src });
  assert.strictEqual(r.findings.filter(f => f.rule === 'conflict-marker').length, 0);
});
test('conflict-marker: 非叶子文件也覆盖(C 源)', () => {
  const src = `int main(){\n${C_START}\nreturn 0;\n${C_MID}\nreturn 1;\n${C_END}\n}\n`;
  const r = guard.assessFile({ relPath: 'kernel/src/x.c', source: src });
  assert.ok(r.findings.some(f => f.rule === 'conflict-marker'));
});

// ── 规则 2:leaf-io ──────────────────────────────────────────────────
test('leaf-io: 叶子里 require(fs) → error', () => {
  const src = LEAF_HEADER + "const fs = require('fs');\nmodule.exports = {};\n";
  const r = guard.assessFile({ relPath: 'demo.js', source: src });
  const io = r.findings.filter(f => f.rule === 'leaf-io');
  assert.strictEqual(io.length, 1);
  assert.strictEqual(io[0].severity, 'error');
});
test('leaf-io: child_process / execSync / process.exit 均抓', () => {
  for (const bad of ["require('child_process')", 'execSync("ls")', 'process.exit(1)', "require('net')", "require('https')"]) {
    const src = LEAF_HEADER + `function f(){ ${bad}; }\n`;
    const r = guard.assessFile({ relPath: 'demo.js', source: src });
    assert.ok(r.findings.some(f => f.rule === 'leaf-io'), `应抓: ${bad}`);
  }
});
test('leaf-io: 相对 require(叶子→叶子)放行', () => {
  const src = LEAF_HEADER + "const sib = require('./searchFreshness');\n";
  const r = guard.assessFile({ relPath: 'demo.js', source: src });
  assert.strictEqual(r.findings.filter(f => f.rule === 'leaf-io').length, 0);
});
test('leaf-io: crypto / path / util 放行(纯/确定性)', () => {
  const src = LEAF_HEADER + "const c = require('crypto');\nconst p = require('path');\n";
  const r = guard.assessFile({ relPath: 'demo.js', source: src });
  assert.strictEqual(r.findings.filter(f => f.rule === 'leaf-io').length, 0);
});
test('leaf-io: 注释里的 require(fs) 不误报', () => {
  const src = LEAF_HEADER + "// 历史上这里曾 require('fs'),已下沉到调用方。\nconst x = 1;\n";
  const r = guard.assessFile({ relPath: 'demo.js', source: src });
  assert.strictEqual(r.findings.filter(f => f.rule === 'leaf-io').length, 0);
});
test('leaf-io: 非叶子文件做 IO 不适用本规则', () => {
  const src = "'use strict';\n// 普通模块\nconst fs = require('fs');\n";
  const r = guard.assessFile({ relPath: 'plain.js', source: src });
  assert.strictEqual(r.findings.filter(f => f.rule === 'leaf-io').length, 0);
});
test('leaf-io: markdown 红线文档含 /* */ 与 IO 反例 → 不误报(GUARDS.md 回归)', () => {
  // 复现真实误报:散文里出现字面 `/*`(如 `scripts/lib/*Gu`、`trajectoryReplay/*`)
  // + 描述「纯叶子:零 IO」+ 引用 require('fs')/execSync(...) 作反面教材。leaf-* 规则
  // 必须只对 JS 风格代码扩展名生效,markdown 一律放行(仍受冲突标记规则约束)。
  const md = [
    '# GUARDS',
    '- 守卫覆盖 `scripts/lib/*Gu...`(IMMUTABLE)。',
    '- 纯叶子:零 IO、确定性 —— 绝不在叶子里 `require(\'fs\')`。',
    '- 真缺口:`case update` 曾用 `execSync(\'pip install --upgrade pkg 2>&1\')` 自升级。',
    '- `trajectoryReplay/*`、`spawn()` 缺二进制是 ENOENT。',
  ].join('\n');
  const r = guard.assessFile({ relPath: '.ai/GUARDS.md', source: md });
  assert.strictEqual(r.findings.filter(f => f.rule === 'leaf-io').length, 0);
  assert.strictEqual(r.findings.filter(f => f.rule === 'leaf-gate-orphan').length, 0);
});
test('fileExt: 取小写扩展名 / 无扩展返回空', () => {
  assert.strictEqual(guard.fileExt('a/b/GUARDS.md'), '.md');
  assert.strictEqual(guard.fileExt('x.JS'), '.js');
  assert.strictEqual(guard.fileExt('Makefile'), '');
  assert.strictEqual(guard.fileExt('dir.d/file'), '');
});

// ── 规则 3:leaf-gate-orphan ─────────────────────────────────────────
test('claimedGateTokens: 门控/主闸 关键词锚定本文件门控', () => {
  assert.deepStrictEqual(guard.claimedGateTokens('env 门控 KHY_DEMO_GATE(默认开)'), ['KHY_DEMO_GATE']);
  assert.deepStrictEqual(guard.claimedGateTokens('KHY_FOO = off|on 主闸(默认 on)'), ['KHY_FOO']);
});
test('claimedGateTokens: 跨引用兄弟门控不算本文件声明', () => {
  assert.deepStrictEqual(guard.claimedGateTokens('与 [[KHY_SIBLING]] 正交;复用 KHY_OTHER 门控'), []);
});
test('leaf-gate-orphan: 声明门控但代码不引用 → warning', () => {
  const src = LEAF_HEADER + 'module.exports = { f(){ return 1; } };\n';
  const r = guard.assessFile({ relPath: 'demo.js', source: src });
  const orphan = r.findings.filter(f => f.rule === 'leaf-gate-orphan');
  assert.strictEqual(orphan.length, 1);
  assert.strictEqual(orphan[0].severity, 'warning');
});
test('leaf-gate-orphan: 代码引用了门控 token → 无 finding', () => {
  const src = LEAF_HEADER + "function on(env){ return env.KHY_DEMO_GATE !== 'off'; }\n";
  const r = guard.assessFile({ relPath: 'demo.js', source: src });
  assert.strictEqual(r.findings.filter(f => f.rule === 'leaf-gate-orphan').length, 0);
});

// ── 自洁 / 全树零误报 ────────────────────────────────────────────────
test('守卫扫自身源码:零 finding', () => {
  for (const rel of ['scripts/lib/leafContractGuard.js', 'scripts/check-leaf-contract.js']) {
    const r = guard.assessFile({ relPath: rel, source: readSrc(rel) });
    assert.deepStrictEqual(r.findings, [], `${rel} 应零 finding,实得 ${JSON.stringify(r.findings)}`);
  }
});
test('全部自声明纯叶子:零 error(现树基线)', () => {
  const dir = path.join(repoRoot, 'services/backend/src');
  const stack = [dir];
  let leafCount = 0;
  const errors = [];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'node_modules') stack.push(full); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (!guard.declaresLeaf(source)) continue;
      leafCount++;
      const rel = path.relative(repoRoot, full);
      const r = guard.assessFile({ relPath: rel, source });
      for (const f of r.findings) if (f.severity === 'error') errors.push(`${rel}:${f.line} ${f.rule}`);
    }
  }
  assert.ok(leafCount >= 20, `应检测到 ≥20 个纯叶子,实得 ${leafCount}`);
  assert.deepStrictEqual(errors, [], `现树纯叶子应零 error,实得:\n${errors.join('\n')}`);
});
