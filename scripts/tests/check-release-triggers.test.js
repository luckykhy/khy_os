'use strict';

/**
 * scripts/ci/check-release-triggers.js 的规则测试（规则 PROCESS-005）。
 *
 * 测法遵循仓库既有惯例（见 `check-weak-model-guard.test.js` 头部）：
 * **不对着真仓库只跑一次** —— 真仓库上的绿色只说明「今天的 workflow 正好没问题」，
 * 测不出规则逻辑。这里每条断言都用**真 workflow 的定点变异**当负例：
 * fixture 载体直接抄真仓的 `.github/workflows/dual-channel-release.yml` /
 * `sync-gitee.yml`，再用字符串替换改坏**一处**，让失败指向单一原因。
 *
 * 不抄一份平行实现：那样测的是抄错的那份，而不是守卫。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CI = path.join(ROOT, 'scripts', 'ci', 'check-release-triggers.js');
const WF = path.join(ROOT, '.github', 'workflows');

const mod = require(CI);

const RELEASE_REL = 'dual-channel-release.yml';
const MIRROR_REL = 'sync-gitee.yml';

const readWf = (name) => fs.readFileSync(path.join(WF, name), 'utf8');

// 直接调纯函数（`main()` 已由 `require.main` 守卫，import 不会触发全仓扫描）。
// 每个用例独立收集 finding —— 不共享模块级数组，避免用例间互相污染。
function collect(fn) {
  const before = mod.__findings ? mod.__findings.length : 0;
  void before;
  return fn();
}

// 守卫的 findings 是模块私有数组，测试通过「调检查函数后读返回/重跑」不易取。
// 因此这里统一走**子进程 + 场景开关**：既能断言 checks，也顺带验证 CLI 契约。
const cp = require('child_process');

function runScenario(name) {
  const r = cp.spawnSync(process.execPath, [CI, `--scenario=${name}`], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
  return { out: r.stdout || '', err: r.stderr || '', code: r.status };
}

function runRepo() {
  const r = cp.spawnSync(process.execPath, [CI], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
  });
  return { out: r.stdout || '', err: r.stderr || '', code: r.status };
}

/** 从 CLI 输出里取 finding id 列表。 */
function ids(out) {
  return out.split('\n')
    .map((l) => l.match(/^\[(?:ERROR|WARN )\]\s+(\S+)\s/))
    .filter(Boolean)
    .map((m) => m[1]);
}

describe('check-release-triggers：真仓库冒烟', () => {
  test('当前仓库必须判绿（守卫自己不能是永久红灯）', () => {
    const r = runRepo();
    assert.equal(r.code, 0, `期望 exit 0，实际 ${r.code}\n${r.out}\n${r.err}`);
    assert.deepEqual(ids(r.out), []);
    assert.match(r.err, /发布触发链路守卫（PROCESS-005）/);
  });

  test('--json 输出可解析，且含 rule / mode / findings', () => {
    const r = cp.spawnSync(process.execPath, [CI, '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000,
    });
    // ⚠️ `--json` 之后仍会追加一行 `Summary: ...`（`scripts/ci/` 的**既有约定**，
    //    `check-agent-docs.js` 等同样如此）。这是仓库现状，不是本守卫的缺陷 ——
    //    断言时须先剥掉尾部汇总行，别去改守卫迎合测试（那会造成与其余检查器不一致）。
    const jsonPart = r.stdout.split(/\n(?=Summary:)/)[0];
    const payload = JSON.parse(jsonPart);
    assert.equal(payload.rule, 'PROCESS-005');
    assert.equal(payload.mode, 'repo');
    assert.ok(Array.isArray(payload.findings));
  });
});

describe('check-release-triggers：应拦（每条检查的反例）', () => {
  const blocking = [
    ['trigger-missing', 'release-trigger-missing'],
    ['mirror-branch-drift', 'mirror-branch-drift'],
    ['hard-condition-exempt', 'release-hard-condition-exempt'],
    ['hard-condition-step-deleted', 'release-hard-condition-missing'],
    ['hard-condition-exempt-empty', 'release-exempt-empty-reason'],
    ['concurrency-true', 'release-concurrent-publish'],
    ['concurrency-missing', 'release-concurrency-missing'],
  ];

  for (const [scenario, expected] of blocking) {
    test(`${scenario} → ${expected}`, () => {
      const r = runScenario(scenario);
      const got = ids(r.out);
      assert.ok(
        got.includes(expected),
        `期望含 ${expected}，实际 ${JSON.stringify(got)}\n${r.out}`,
      );
    });
  }
});

describe('check-release-triggers：应放行（误报回归锁，依据公理 A4）', () => {
  // 每一条都对应真源 §2.5 明确要求判绿的合法写法。
  // 这些不放行，守卫就会逼着维护者改仓库去满足错误判据。
  const allowed = [
    ['trigger-present', '`tags: [v*]` 通配是合法触发器'],
    ['trigger-dispatch-only', '`workflow_dispatch` 单独存在是合法的'],
    ['mirror-branch-ok', '`branches` 同时列 main 与 master（迁移期兼容）'],
    ['mirror-branch-dispatch-ok', '镜像 workflow 只靠 workflow_dispatch'],
    ['hard-condition-ok', '硬条件 step 无 continue-on-error'],
    ['hard-condition-exempt-ok', '带**非空理由**的豁免注释'],
    ['concurrency-ok', '`cancel-in-progress: false` 且并发组名任意'],
  ];

  for (const [scenario, why] of allowed) {
    test(`${scenario} → 无 finding（${why}）`, () => {
      const r = runScenario(scenario);
      assert.deepEqual(ids(r.out), [], `期望无 finding，实际 ${JSON.stringify(ids(r.out))}\n${r.out}`);
      assert.equal(r.code, 0, `期望 exit 0，实际 ${r.code}`);
    });
  }
});

describe('check-release-triggers：场景定义完备性', () => {
  test('每个场景都有 desc，且 desc 非空', () => {
    for (const [name, sc] of Object.entries(mod.SCENARIOS)) {
      assert.ok(sc.desc && sc.desc.trim(), `场景 ${name} 缺 desc`);
    }
  });

  test('每个场景都能跑通（不抛异常、不 exit 2）', () => {
    for (const name of Object.keys(mod.SCENARIOS)) {
      const r = runScenario(name);
      assert.notEqual(r.code, 2, `场景 ${name} 报用法错误：${r.err}`);
      assert.doesNotMatch(r.out, /未知场景|Error:/, `场景 ${name} 异常：${r.out}${r.err}`);
    }
  });

  test('--list-scenarios 覆盖 SCENARIOS 全集', () => {
    const r = cp.spawnSync(process.execPath, [CI, '--list-scenarios'], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
    });
    const listed = r.stdout.split('\n').map((l) => l.trim().split(/\s{2,}/)[0]).filter(Boolean);
    assert.deepEqual(listed.sort(), Object.keys(mod.SCENARIOS).sort());
  });

  test('未知场景以 exit 2 退出（用法错误契约）', () => {
    const r = runScenario('no-such-scenario');
    assert.equal(r.code, 2);
    assert.match(r.err, /未知场景/);
  });
});

describe('check-release-triggers：纯函数契约', () => {
  test('stepBlocks 能把每个 step 切成独立块', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - name: First',
      '        run: echo one',
      '      - name: Second',
      '        run: echo two',
    ].join('\n');
    const steps = mod.stepBlocks(mod.scanLines(text));
    assert.equal(steps.length, 2);
    assert.ok(steps[0].endIdx <= steps[1].startIdx, '块范围不得重叠');
  });

  test('readTriggers 能认出 on: 的键（兼容引号写法）', () => {
    for (const key of ['on:', "'on':", '"on":']) {
      const lines = mod.scanLines(`${key}\n  push:\n    tags:\n      - 'v*'\n`);
      const t = mod.readTriggers(lines);
      assert.ok(t, `${key} 未被识别`);
      assert.deepEqual(t.keys.map((k) => k.key), ['push']);
    }
  });

  test('readExemptions：空理由 ok=false，非空 ok=true', () => {
    const text = '# release-trigger-exempt:\nfoo\n# release-trigger-exempt: 有理由\n';
    const g = mod.readExemptions(text);
    assert.equal(g.length, 2);
    assert.equal(g[0].ok, false);
    assert.equal(g[1].ok, true);
  });

  test('四条硬条件 step 与三源落点常量非空（防止被清空后静默放行）', () => {
    assert.ok(mod.HARD_CONDITION_STEPS.length >= 4, '硬条件 step 不得少于 4 条');
    assert.ok(mod.BUMP_SOURCES.length >= 3, 'bump 落点不得少于 3 源');
  });
});

describe('check-release-triggers：真 workflow 变异（定点改坏真载体）', () => {
  // 直接对**真文件文本**做变异后调纯函数，测的是「真载体 + 一处坏形态」，
  // 而不是场景里手写的小样本。这条能挡住「场景全绿但真文件判错」的偏差。
  //
  // ⚠️ 真 workflow 是 **CRLF** 行尾（Windows 检出）。变异正则必须用 `\r?\n`，
  //    否则 `\n\s*` 匹配不到行首（实测踩过：变异静默不生效 → 测试报「变异未生效」）。

  test('真 release workflow：给 check-version-sync 加 continue-on-error → 判红', () => {
    const text = readWf(RELEASE_REL);
    const mutated = text.replace(
      /(\r?\n\s*)(- name: Verify version sync\r?\n\s*run: node scripts\/ci\/check-version-sync\.js\r?\n)/,
      '$1$2        continue-on-error: true\r\n',
    );
    assert.notEqual(mutated, text, '变异未生效 —— 真 workflow 结构可能已变，请同步本测试');

    mod.__resetFindingsForTest();
    mod.checkHardConditionSteps(RELEASE_REL, mutated, ['scripts/ci/check-version-sync.js']);
    const got = mod.__collectFindingsForTest();
    const found = got.filter((f) => f.check === 'release-hard-condition-exempt');
    assert.equal(found.length, 1, `期望 1 条，实际 ${JSON.stringify(got)}`);
    assert.ok(found[0].line > 0, '行号必须是真实行（否则 khy-allow 无法锚定）');
  });

  test('真 release workflow：cancel-in-progress 改 true → 判红', () => {
    const text = readWf(RELEASE_REL);
    const mutated = text.replace('cancel-in-progress: false', 'cancel-in-progress: true');
    assert.notEqual(mutated, text, '真 workflow 里没有 cancel-in-progress: false，请同步本测试');

    mod.__resetFindingsForTest();
    mod.checkConcurrency(RELEASE_REL, mutated);
    const got = mod.__collectFindingsForTest();
    assert.equal(got.filter((f) => f.check === 'release-concurrent-publish').length, 1);
  });

  test('真 mirror workflow：把 branches 里的 main 删掉 → 判红（默认分支漂移）', () => {
    const text = readWf(MIRROR_REL);
    // 只删 `branches` 列表里的那一行 `- main`（不是 push: 过滤器的任意 main）
    const mutated = text.replace(/\r?\n(\s*)- main\r?\n/, '\r\n');
    assert.notEqual(mutated, text, '真 mirror workflow 里没有 `- main`，请同步本测试');

    mod.__resetFindingsForTest();
    mod.checkMirrorBranch(MIRROR_REL, mutated, 'main');
    const got = mod.__collectFindingsForTest();
    assert.equal(got.filter((f) => f.check === 'mirror-branch-drift').length, 1, JSON.stringify(got));
  });

  test('真 mirror workflow 原样 → 判绿', () => {
    mod.__resetFindingsForTest();
    mod.checkMirrorBranch(MIRROR_REL, readWf(MIRROR_REL), 'main');
    const got = mod.__collectFindingsForTest();
    assert.deepEqual(got, [], `真文件不该判红：${JSON.stringify(got)}`);
  });
});

void collect;
