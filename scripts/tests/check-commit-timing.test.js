'use strict';

/**
 * check-commit-timing 测试（`PROCESS-009` / `[DESIGN-GIT-004]`）。
 *
 * 跑法：`npm run test:scripts`（= `node --test "scripts/tests/**\/*.test.js"`）
 * 单跑：`node --test scripts/tests/check-commit-timing.test.js`
 *
 * ⚠ 本仓另一套 runner 是 jest（`tests/**` 同时被两边扫）——
 * 这里用 `node:test`，因为守卫本身是 `scripts/` 下的 Node 脚本，
 * 与同目录既有守卫测试（check-gov-rules / check-rollout-stage 等）保持一致。
 *
 * ## 覆盖重点
 *
 * 1. **阶段真的生效**（最重要）：同一改动集在 S1 与 S3 下的 error 数与退出码**必须不同**。
 *    没有这条，`STAGE` 常量就是装饰 —— S1 与 S3 跑出一样的结果、一样的退出码，
 *    升到 S3 后机制仍不拦截，而所有守卫全绿。这是本仓实测踩过的坑。
 * 2. **不误伤**：干净单元与纯文档单元必须 0 finding（证明不是无脑拦）。
 * 3. **反例命中**：每条判据的触发条件都能真报警。
 * 4. **退出码语义**：S1 恒 0（PP-3 旁路记录），S3 有 error 才 1。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-commit-timing.js');

/**
 * 跑一个场景。`stage` 传非 'S1' 时，临时拷一份改掉 STAGE 常量（模拟升阶）。
 *
 * ⚠ 结果**按 (stage, scenario, files, changed) 缓存**。理由（2026-09-19 实测）：
 * 本文件有 23 个用例、每个 spawn 一个 Node 子进程（冷启动约 1s）。在全量
 * `npm run test:scripts`（1000 个用例）的并发压力下，个别 spawn 会超时/拿不到结果，
 * 表现为**间歇性** `not ok` —— 单独跑必绿、全量跑偶红，是最难归因的一类失败。
 * 缓存把 spawn 次数从 30+ 降到 ~10，并让「同一输入必得同一输出」成为**结构性**保证
 * （判定本身是纯函数，重复 spawn 本就是在测 Node 而不是测判据）。
 */
const _cache = new Map();
function run(scenario, opts = {}) {
  const key = JSON.stringify({ scenario, ...opts });
  if (_cache.has(key)) return _cache.get(key);
  const r = runUncached(scenario, opts);
  _cache.set(key, r);
  return r;
}

function runUncached(scenario, { stage = 'S1', files = '', changed = false, rawArgs = null } = {}) {
  const args = [];
  if (rawArgs) args.push(...rawArgs);
  else {
    if (scenario) args.push(`--scenario=${scenario}`);
    if (files) args.push(`--files=${files}`);
    if (changed) args.push('--changed');
  }

  const result = cp.spawnSync(process.execPath, [scriptFor(stage), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const m = /Summary: (\d+) error\(s\), (\d+) warning\(s\)\./.exec(output);
  return {
    status: result.status,
    output,
    errors: m ? Number(m[1]) : -1,
    warnings: m ? Number(m[2]) : -1,
  };
}

/**
 * 取某个阶段对应的脚本路径。S1 用真身；其余用临时改过常量的副本。
 *
 * ⚠ 副本**不能**落在 `scripts/ci/` 下。实测教训（2026-09-19）：初版把 `_ct-timing-S3.js`
 * 写在 `scripts/ci/`，而 `scripts/ci/*.js` 正是 `check-wiring.js` 的检查器扫描范围 ——
 * 测试跑的那几秒里，另一个终端跑 `npm run check:wiring` 会看到这个临时文件「零接线」
 * 而报 **1 error**。表现是一个人「没改任何东西却突然变红」，极难归因（且是间歇性的）。
 * ⇒ 副本落 `scripts/` 的下级临时目录（`scripts/.ct-timing-tmp/`）：
 *   仍是 `scripts/` 的子目录，`__dirname/../..` 推仓库根的层数不变；
 *   但不在任何守卫的扫描 glob 里。用完即删，并在退出时兜底清理。
 */
const TMP_DIR = path.join(ROOT, 'scripts', '.ct-timing-tmp');

let _tmpCache = new Map();
function scriptFor(stage) {
  if (stage === 'S1') return SCRIPT;
  if (_tmpCache.has(stage)) return _tmpCache.get(stage);
  const fs = require('fs');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const patched = src.replace(/^const STAGE = 'S1';/m, `const STAGE = '${stage}';`);
  assert.notEqual(patched, src, `无法把 STAGE 常量改成 ${stage}（源码形状变了？）`);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, `_ct-timing-${stage}.js`);
  fs.writeFileSync(p, patched, 'utf8');
  _tmpCache.set(stage, p);
  return p;
}

process.on('exit', () => {
  const fs = require('fs');
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('check-commit-timing — 不误伤（不是无脑拦）', () => {
  test('干净单元（单板块 + 有验证证据）0 finding', () => {
    const r = run('clean-unit');
    assert.equal(r.errors, 0, r.output);
    assert.equal(r.warnings, 0, r.output);
  });

  test('纯文档单元 0 finding（T2 可运行对文档不适用）', () => {
    const r = run('docs-only');
    assert.equal(r.errors, 0, r.output);
    assert.equal(r.warnings, 0, r.output);
  });

  test('空改动集 0 finding', () => {
    // ⚠ 不能用 `--files=`（空值）：初版 `argValue('--files')` 返回 ''，与「未提供」不可区分，
    //    会 fall through 去读真实暂存集（本仓数千项）→ 调用方以为在测空集，实际在测仓库现状。
    //    已修为 `filesArgOrNull()` 返回 null，两者可区分。
    const r = run('', { files: '__empty__' });
    assert.equal(r.errors, 0, r.output);
    assert.equal(r.warnings, 0, r.output);
  });

  test('--files= 空值不 fall through 到真实暂存集（曾是真 bug）', () => {
    const r = run('', { rawArgs: ['--files='] });
    // 空集合 → 无 finding；若 fall through 会读到本仓数千项并报 unit-not-rollbackable。
    assert.doesNotMatch(r.output, /unit-not-rollbackable/, '空 --files 被当成了真实暂存集');
    assert.equal(r.warnings, 0, r.output);
  });
});

describe('check-commit-timing — 反例命中（每条判据都能真报警）', () => {
  test('T1 单元闭合：跨 3 个顶层板块 → unit-multi-intent', () => {
    const r = run('unit-multi-intent');
    assert.equal(r.warnings, 1, r.output);
    assert.match(r.output, /unit-multi-intent/);
  });

  test('T2 可运行：改了代码但无验证证据 → unit-unverified', () => {
    const r = run('unit-unverified');
    assert.equal(r.warnings, 1, r.output);
    assert.match(r.output, /unit-unverified/);
  });

  test('T3 仓库自洽：本机态文件被卷入 → unit-sweeps-foreign-changes', () => {
    const r = run('sweeps-foreign');
    assert.equal(r.warnings, 1, r.output);
    assert.match(r.output, /unit-sweeps-foreign-changes/);
  });

  test('T4 无游离产物：tmp-* / probe → unit-stray-artifacts', () => {
    const r = run('unit-stray-artifacts');
    assert.equal(r.warnings, 1, r.output);
    assert.match(r.output, /unit-stray-artifacts/);
  });

  test('T5 可回滚：改动集 > 20 文件 → unit-not-rollbackable', () => {
    const many = Array.from({ length: 25 }, (_, i) => `M:services/backend/src/f${i}.js`).join(',');
    const r = run('', { files: many });
    assert.match(r.output, /unit-not-rollbackable/);
    assert.equal(r.warnings, 1, r.output);
  });

  test('文档 + 代码同批不算多意图（SOURCING-006 要求的同步）', () => {
    const r = run('', {
      files: 'M:docs/10_规范/DESIGN-GIT/[DESIGN-GIT-004] 提交时机规范.md,M:services/backend/src/cli/router.js',
    });
    assert.doesNotMatch(r.output, /unit-multi-intent/);
  });

  test('测试文件 + 被测代码同批不算多意图', () => {
    const r = run('', {
      files: 'M:scripts/tests/check-commit-timing.test.js,M:scripts/ci/check-commit-timing.js',
    });
    assert.doesNotMatch(r.output, /unit-multi-intent/);
  });
});

describe('check-commit-timing — 阶段真的生效（最容易被忽略的一条）', () => {
  test('S1 恒 exit 0（PP-3 旁路记录）', () => {
    const r = run('unit-unverified', { stage: 'S1' });
    assert.equal(r.status, 0, r.output);
    assert.equal(r.errors, 0, r.output);
    assert.equal(r.warnings, 1, r.output);
  });

  test('S3 同类改动升为 error 且 exit 1', () => {
    const r = run('unit-unverified', { stage: 'S3' });
    assert.equal(r.errors, 1, r.output);
    assert.equal(r.status, 1, r.output);
  });

  test('S1 与 S3 对同一改动集的 error 数必须不同（否则 STAGE 是装饰）', () => {
    for (const scenario of ['unit-multi-intent', 'unit-unverified', 'unit-stray-artifacts', 'sweeps-foreign']) {
      const s1 = run(scenario, { stage: 'S1' });
      const s3 = run(scenario, { stage: 'S3' });
      assert.notEqual(s1.errors, s3.errors, `${scenario}: S1 与 S3 的 error 数相同 —— STAGE 常量没生效`);
      assert.equal(s1.errors, 0, `${scenario}: S1 不应有 error`);
      assert.ok(s3.errors > 0, `${scenario}: S3 应有 error`);
    }
  });

  test('S3 下干净单元仍放行（不是无脑拦）', () => {
    const r = run('clean-unit', { stage: 'S3' });
    assert.equal(r.errors, 0, r.output);
    assert.equal(r.status, 0, r.output);
  });

  test('T5 是 S 判据，S3 下仍为 warning（不升 error）', () => {
    const many = Array.from({ length: 25 }, (_, i) => `M:services/backend/src/f${i}.js`).join(',');
    const r = run('', { files: many, stage: 'S3' });
    assert.match(r.output, /\[WARN \] unit-not-rollbackable/, r.output);
    assert.equal(r.errors, 0, r.output);
  });
});

describe('check-commit-timing — 输出契约', () => {
  test('--changed 一票否决 verbose（门里的消费者只认 finding 方言）', () => {
    const r = run('clean-unit', { changed: true });
    assert.doesNotMatch(r.output, /check-commit-timing: 提交时机判据/, '--changed 下不应有讲解头');
    assert.match(r.output, /^Summary: /m);
  });

  test('非 --changed 时有讲解头与 stage 行', () => {
    const r = run('clean-unit');
    assert.match(r.output, /stage: S1/);
  });

  test('finding 行是定宽 6 字符方言（ruleguard 正则要求）', () => {
    const r = run('unit-unverified');
    const line = r.output.split('\n').find((l) => l.includes('unit-unverified'));
    assert.match(line, /^\[(ERROR|WARN )\] unit-unverified .+:\d+$/);
  });

  test('未知场景返回退出码 2 并列出可用场景', () => {
    const r = run('no-such-scenario');
    assert.equal(r.status, 2, r.output);
    assert.match(r.output, /clean-unit/);
  });
});

describe('check-commit-timing — 登记与真源一致', () => {
  test('执行器里的 STAGE 常量与 FEATURE-OWNERSHIP 登记一致', () => {
    const fs = require('fs');
    const ownership = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'docs/10_规范/registry/FEATURE-OWNERSHIP.json'), 'utf8')
    );
    const mech = ownership.rollout.mechanisms.find((m) => m.id === 'commit-timing-contract');
    assert.ok(mech, '未在 FEATURE-OWNERSHIP.json 登记 commit-timing-contract');

    const src = fs.readFileSync(SCRIPT, 'utf8');
    const hit = /const STAGE = '(S[1-4])'/.exec(src);
    assert.ok(hit, '执行器里找不到 STAGE 常量');

    // 比的是**阻断语义**，不是字面相等（与 check-rollout-stage.js 同口径）。
    const ORDER = { S1: 1, S2: 2, S3: 3, S4: 4 };
    const codeBlocks = ORDER[hit[1]] >= 3;
    const stageShouldBlock = ORDER[mech.stage] >= 3;
    assert.equal(codeBlocks, stageShouldBlock, `登记 ${mech.stage} 与执行器 STAGE=${hit[1]} 的阻断语义不一致`);
  });

  test('登记表里的 PROCESS-009 指向本执行器与本文档', () => {
    const fs = require('fs');
    const reg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'docs/10_规范/registry/RULES-REGISTRY.json'), 'utf8')
    );
    const rule = reg.rules.find((r) => r.id === 'PROCESS-009');
    assert.ok(rule, '登记表缺 PROCESS-009');
    assert.equal(rule.exec.script, 'scripts/ci/check-commit-timing.js');
    assert.equal(rule.gate, 'commit');
    assert.equal(rule.severity, 'advisory');

    // finding id 必须与执行器真报的一致（防「登记了不存在的 finding」）。
    const src = fs.readFileSync(SCRIPT, 'utf8');
    for (const fid of rule.exec.findings) {
      assert.ok(src.includes(`'${fid}'`), `执行器里找不到登记的 finding：${fid}`);
    }
  });

  test('ssot 文档存在且带 RULES-REGISTRY 标记行', () => {
    const fs = require('fs');
    const rel = 'docs/10_规范/DESIGN-GIT/[DESIGN-GIT-004] 提交时机规范.md';
    const md = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(md, /<!-- RULES-REGISTRY: PROCESS-009 -->/, 'ssot 文档缺标记行（TOOLING-007 会报断链）');
  });
});
