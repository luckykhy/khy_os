'use strict';

/**
 * pipResiduePurgeWiring.test.js — 修② 接线的源级断言(node:test)。
 *
 * routerDispatchOps 无法脱离 CLI 上下文整体执行,故以 readFileSync + 正则断言接线要点:
 *   - 定义了 purgePipResidue IO 壳;
 *   - 在读回版本(readInstalledVersionTraced)之前调用 purgePipResidue(output);
 *   - 惰性 require 纯叶子 pipResiduePolicy 且尊重 isResiduePurgeEnabled 门控;
 *   - 删除走 fs.rmSync(recursive+force),据 buildResiduePurgePlan 的 targets。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'cli', 'routerDispatchOps.js'),
  'utf-8'
);

test('定义了 purgePipResidue IO 壳', () => {
  assert.match(SRC, /const purgePipResidue\s*=\s*\(pipOutput\)\s*=>/);
});

test('惰性 require 纯叶子 pipResiduePolicy', () => {
  assert.match(SRC, /require\(['"]\.\.\/services\/pipResiduePolicy['"]\)/);
});

test('尊重 isResiduePurgeEnabled 门控', () => {
  assert.match(SRC, /isResiduePurgeEnabled\(process\.env\)/);
});

test('据纯叶子计划 buildResiduePurgePlan 收集 targets', () => {
  assert.match(SRC, /buildResiduePurgePlan\(\s*\{[^}]*entries[^}]*\}\s*\)/s);
  assert.match(SRC, /parseInvalidDistResidue\(pipOutput\)/);
});

test('删除走 fs.rmSync recursive+force(受限删除)', () => {
  assert.match(SRC, /fs\.rmSync\(\s*target,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\s*\)/);
});

test('在读回版本之前调用 purgePipResidue(output)', () => {
  const purgeIdx = SRC.indexOf('purgePipResidue(output)');
  const tracedIdx = SRC.indexOf('readInstalledVersionTraced(upgradedPkg)');
  assert.ok(purgeIdx > 0, 'purgePipResidue(output) 调用应存在');
  assert.ok(tracedIdx > 0, 'readInstalledVersionTraced 调用应存在');
  assert.ok(purgeIdx < tracedIdx, '清理残骸须先于读回版本,pip show 才能读到干净真身');
});
