'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cockpit = require('../../src/services/maintainerCockpit');

// 全注入的 opts：四个检查都被替换为确定性桩，不触真实仓库/git/扫描器。
function baseOpts(over = {}) {
  return Object.assign({
    root: '/tmp/fake-repo',
    _now: 'TEST',
    checkMetadata: () => ({ ok: true, exists: true, stale: false }),
    hookStatus: () => ({ installed: true, ours: true }), // 默认：自愈钩子已装
    scanArchDebt: () => ({ neu: { layering: [], godFiles: [], cycles: [] }, baselineCount: 3 }),
    scanApproaching: () => ({ approaching: [], threshold: 2500, warnFloor: 2000 }), // 默认：无逼近文件
    gitChangedFiles: () => [],
    readFile: () => null,
    auditInfra: () => ({ gaps: [], byKind: {} }),
    readVersion: () => '9.9.9',
  }, over);
}

test('全绿：四检查通过 → level green, ok true, 无下一步', () => {
  const r = cockpit.runCockpit(baseOpts());
  assert.strictEqual(r.level, 'green');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.nextAction, null);
  assert.strictEqual(r.checks.length, 5);
  assert.strictEqual(r.checks.find(c => c.id === 'version').detail.includes('9.9.9'), true);
});

test('元数据缺失 → red + 下一步 gen', () => {
  const r = cockpit.runCockpit(baseOpts({
    checkMetadata: () => ({ ok: false, exists: false, stale: true }),
  }));
  assert.strictEqual(r.level, 'red');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.nextAction, 'khy metadata gen');
});

test('元数据过期 + 钩子已装 → yellow，标记自愈，下一步 refresh', () => {
  const r = cockpit.runCockpit(baseOpts({
    checkMetadata: () => ({ ok: false, exists: true, stale: true }),
    hookStatus: () => ({ installed: true, ours: true }),
  }));
  assert.strictEqual(r.level, 'yellow');
  const m = r.checks.find(c => c.id === 'metadata');
  assert.strictEqual(m.status, 'yellow');
  assert.strictEqual(m.selfHealing, true);
  assert.match(m.detail, /自动刷新/);
  assert.strictEqual(r.nextAction, 'khy metadata refresh');
});

test('元数据过期 + 钩子未装 → yellow，不自愈，下一步装钩子', () => {
  const r = cockpit.runCockpit(baseOpts({
    checkMetadata: () => ({ ok: false, exists: true, stale: true }),
    hookStatus: () => ({ installed: false, ours: false }),
  }));
  const m = r.checks.find(c => c.id === 'metadata');
  assert.strictEqual(m.status, 'yellow');
  assert.strictEqual(m.selfHealing, false);
  assert.strictEqual(r.nextAction, 'khy metadata hook install');
});

test('元数据过期 + 钩子探测抛错 → 仍 yellow 不崩（回落非自愈）', () => {
  const r = cockpit.runCockpit(baseOpts({
    checkMetadata: () => ({ ok: false, exists: true, stale: true }),
    hookStatus: () => { throw new Error('hook boom'); },
  }));
  const m = r.checks.find(c => c.id === 'metadata');
  assert.strictEqual(m.status, 'yellow');
  assert.strictEqual(m.selfHealing, false);
});

test('架构债新增 → red，且 red 行动优先于 yellow', () => {
  const r = cockpit.runCockpit(baseOpts({
    // metadata 给 yellow（应被 arch-debt 的 red 行动盖过）
    checkMetadata: () => ({ ok: false, exists: true, stale: true }),
    scanArchDebt: () => ({ neu: { layering: [{ file: 'a' }], godFiles: [], cycles: [{ members: ['x', 'y'] }] }, baselineCount: 0 }),
  }));
  assert.strictEqual(r.level, 'red');
  const debt = r.checks.find(c => c.id === 'arch-debt');
  assert.strictEqual(debt.status, 'red');
  assert.match(debt.detail, /引入 2 处新债/);
  // red 行动优先
  assert.strictEqual(r.nextAction, 'npm run arch:debt');
});

test('架构债：巨石文件点名（basename + LOC），便于判断是否己方代码', () => {
  const r = cockpit.runCockpit(baseOpts({
    scanArchDebt: () => ({
      neu: {
        layering: [],
        godFiles: [
          { file: 'src/services/localBrainService.js', loc: 2597 },
          { file: 'src/services/gateway/proxyServer.js', loc: 2518 },
        ],
        cycles: [],
      },
      baselineCount: 11,
    }),
  }));
  const debt = r.checks.find(c => c.id === 'arch-debt');
  assert.strictEqual(debt.status, 'red');
  // 点名到 basename + LOC，且不泄露完整路径噪音
  assert.match(debt.detail, /localBrainService\.js 2597/);
  assert.match(debt.detail, /proxyServer\.js 2518/);
});

test('架构债归因：新债巨石不在改动集 → 标「均非本次改动」、introducedByCurrentWork=false', () => {
  const r = cockpit.runCockpit(baseOpts({
    gitChangedFiles: () => ['services/backend/src/cli/handlers/learn.js'], // 与巨石无关
    scanArchDebt: () => ({
      neu: { layering: [], godFiles: [{ file: 'src/services/localBrainService.js', loc: 2597 }], cycles: [] },
      baselineCount: 11,
    }),
  }));
  const debt = r.checks.find(c => c.id === 'arch-debt');
  assert.strictEqual(debt.introducedByCurrentWork, false);
  assert.match(debt.detail, /均非本次改动/);
});

test('架构债归因：新债巨石正是本次改动文件 → 标「含本次改动」、introducedByCurrentWork=true', () => {
  const r = cockpit.runCockpit(baseOpts({
    gitChangedFiles: () => ['services/backend/src/services/localBrainService.js'],
    scanArchDebt: () => ({
      neu: { layering: [], godFiles: [{ file: 'src/services/localBrainService.js', loc: 2597 }], cycles: [] },
      baselineCount: 11,
    }),
  }));
  const debt = r.checks.find(c => c.id === 'arch-debt');
  assert.strictEqual(debt.introducedByCurrentWork, true);
  assert.match(debt.detail, /含本次改动：localBrainService\.js/);
  assert.match(debt.detail, /提交前应拆分/);
});

test('环漂移归因：既存已承认 SCC 有界漂移 → 降为 yellow（跟踪不阻断），点名累积模块', () => {
  const r = cockpit.runCockpit(baseOpts({
    scanArchDebt: () => ({
      neu: { layering: [], godFiles: [], cycles: [{ members: Array.from({ length: 82 }, (_, i) => `m${i}.js`) }] },
      baselineCount: 5,
      cycleDrift: [{
        kind: 'drift', baseSize: 74, curSize: 82, removed: [],  // 82 ≤ 74×1.25=92 → 容差内
        added: [
          'src/services/gateway/_ideTokenMixin.js',
          'src/services/gateway/_messageBuilder.js',
          'src/services/gateway/_responsesSseStream.js',
          'src/services/gateway/planModeService.js',
        ],
      }],
    }),
  }));
  const debt = r.checks.find(c => c.id === 'arch-debt');
  assert.strictEqual(debt.status, 'yellow');                    // 已承认债的有界漂移 = 跟踪不阻断
  assert.strictEqual(debt.sccDrift, true);
  assert.match(debt.detail, /无新增阻断债/);
  assert.match(debt.detail, /既存巨型 SCC 漂移 74→82/);
  assert.match(debt.detail, /\+4 模块累积/);
  assert.match(debt.detail, /_ideTokenMixin\.js/);              // 点名 basename
  assert.match(debt.detail, /容差/);
  assert.strictEqual(r.ok, true);                                // 不再 RED → 可提交
});

test('环漂移：解环 campaign 净缩小到基线以下 → 报进度（已净解开 N 节点）而非「+N 累积」', () => {
  // curSize(63) < baseSize(74)：SCC 已被 campaign 净缩小到承认基线之下。
  // 此时仍是 drift（≤容差）、仍 yellow·可提交，但叙述必须方向正确——
  // 报「已净解开 11 个节点·持续收敛」，绝不再用增长期的「+N 模块累积」误导维护者。
  const r = cockpit.runCockpit(baseOpts({
    scanArchDebt: () => ({
      neu: { layering: [], godFiles: [], cycles: [{ members: Array.from({ length: 63 }, (_, i) => `m${i}.js`) }] },
      baselineCount: 5,
      cycleDrift: [{ kind: 'drift', baseSize: 74, curSize: 63, removed: Array.from({ length: 13 }, (_, i) => `r${i}.js`), added: ['src/a.js', 'src/b.js'] }],
    }),
  }));
  const debt = r.checks.find(c => c.id === 'arch-debt');
  assert.strictEqual(debt.status, 'yellow');     // 仍是已承认债的有界漂移 → 跟踪不阻断
  assert.strictEqual(debt.sccDrift, true);
  assert.strictEqual(r.ok, true);                // 低于基线绝不 RED
  assert.match(debt.detail, /解环 campaign 进行中 74→63/);
  assert.match(debt.detail, /已净解开 11 个节点/);
  assert.match(debt.detail, /已低于基线/);
  assert.doesNotMatch(debt.detail, /\+2 模块累积/); // 不得再用增长期措辞
});

test('环漂移：既存 SCC 拆分为多片段 → 归并为一条诚实叙述（拆分为[a+b]·已净解开 N），不双重计数', () => {
  // 解环 campaign 把既存 74 节点 SCC 拆成 39+6 两个仍成环片段（皆既存债·drift）。
  // 若逐片段各报「净解开」会双重夸大；须归并为一条：累计在环 45·净解开 29。
  const r = cockpit.runCockpit(baseOpts({
    scanArchDebt: () => ({
      neu: {
        layering: [], godFiles: [],
        cycles: [
          { members: Array.from({ length: 39 }, (_, i) => `g${i}.js`) },
          { members: Array.from({ length: 6 }, (_, i) => `f${i}.js`) },
        ],
      },
      baselineCount: 5,
      cycleDrift: [
        { kind: 'drift', baseSize: 74, curSize: 39, removed: [], added: ['src/a.js'] },
        { kind: 'drift', baseSize: 74, curSize: 6, removed: [], added: [] },
      ],
    }),
  }));
  const debt = r.checks.find(c => c.id === 'arch-debt');
  assert.strictEqual(debt.status, 'yellow');
  assert.strictEqual(debt.sccDrift, true);
  assert.strictEqual(r.ok, true);
  assert.match(debt.detail, /拆分为\[39\+6\]/);
  assert.match(debt.detail, /累计在环 45/);
  assert.match(debt.detail, /已净解开 29 个节点/);
  // 绝不出现把单片段误当全基线的「净解开 68」之类双重计数夸大。
  assert.doesNotMatch(debt.detail, /已净解开 (35|68) 个节点/);
});

test('环漂移：既存 SCC 失控膨胀（超容差）→ 回到 red（已承认债不得无界增长）', () => {
  const r = cockpit.runCockpit(baseOpts({
    scanArchDebt: () => ({
      neu: { layering: [], godFiles: [], cycles: [{ members: Array.from({ length: 120 }, (_, i) => `m${i}.js`) }] },
      baselineCount: 5,
      cycleDrift: [{ kind: 'drift', baseSize: 74, curSize: 120, removed: [], added: ['src/a.js'] }], // 120 > 92
    }),
  }));
  const debt = r.checks.find(c => c.id === 'arch-debt');
  assert.strictEqual(debt.status, 'red');                       // 失控膨胀仍阻断
  assert.match(debt.detail, /循环依赖 1/);
});

test('环漂移：自定义容差比值（env）改变 drift 判定边界', () => {
  process.env.KHY_MAINTAIN_SCC_DRIFT_MAX_RATIO = '1.05';        // 74×1.05=77 → 82 超容差
  try {
    const r = cockpit.runCockpit(baseOpts({
      scanArchDebt: () => ({
        neu: { layering: [], godFiles: [], cycles: [{ members: Array.from({ length: 82 }, (_, i) => `m${i}.js`) }] },
        baselineCount: 5,
        cycleDrift: [{ kind: 'drift', baseSize: 74, curSize: 82, removed: [], added: ['src/a.js'] }],
      }),
    }));
    assert.strictEqual(r.checks.find(c => c.id === 'arch-debt').status, 'red');
  } finally {
    delete process.env.KHY_MAINTAIN_SCC_DRIFT_MAX_RATIO;
  }
});

test('环漂移归因：真正新独立环 → red + 标 ⚠ 应即解开（区别于既存漂移）', () => {
  const r = cockpit.runCockpit(baseOpts({
    scanArchDebt: () => ({
      neu: { layering: [], godFiles: [], cycles: [{ members: ['x.js', 'y.js', 'z.js'] }] },
      baselineCount: 5,
      cycleDrift: [{ kind: 'new', baseSize: 0, curSize: 3, removed: [], added: ['src/x.js', 'src/y.js', 'src/z.js'] }],
    }),
  }));
  const debt = r.checks.find(c => c.id === 'arch-debt');
  assert.strictEqual(debt.status, 'red');                       // 真正新环 = 阻断
  assert.match(debt.detail, /循环依赖 1/);
  assert.match(debt.detail, /新独立环 3 节点/);
  assert.match(debt.detail, /应即解开/);
});

test('环漂移：既存 SCC 有界漂移 + 同时真正新环 → red（新环主导，漂移仍被叙述）', () => {
  const r = cockpit.runCockpit(baseOpts({
    scanArchDebt: () => ({
      neu: { layering: [], godFiles: [], cycles: [
        { members: Array.from({ length: 82 }, (_, i) => `m${i}.js`) },
        { members: ['p.js', 'q.js'] },
      ] },
      baselineCount: 5,
      cycleDrift: [
        { kind: 'drift', baseSize: 74, curSize: 82, removed: [], added: ['src/_messageBuilder.js'] },
        { kind: 'new', baseSize: 0, curSize: 2, removed: [], added: ['src/p.js', 'src/q.js'] },
      ],
    }),
  }));
  const debt = r.checks.find(c => c.id === 'arch-debt');
  assert.strictEqual(debt.status, 'red');                       // hardCycles=1（新环）→ RED
  assert.match(debt.detail, /循环依赖 1/);                       // 只计 1 个硬环（漂移不计入阻断）
  assert.match(debt.detail, /既存巨型 SCC 漂移 74→82/);           // 漂移仍被叙述
  assert.match(debt.detail, /新独立环 2 节点/);
});

test('环漂移归因：旧桩无 cycleDrift 字段 → 全计 hard、仍 red（back-compat，绝不弱于既有行为）', () => {
  const r = cockpit.runCockpit(baseOpts({
    scanArchDebt: () => ({ neu: { layering: [], godFiles: [], cycles: [{ members: ['a', 'b'] }] }, baselineCount: 1 }),
  }));
  const debt = r.checks.find(c => c.id === 'arch-debt');
  assert.strictEqual(debt.status, 'red');                       // 无 drift 数据 → 一律阻断
  assert.match(debt.detail, /循环依赖 1/);
  assert.strictEqual(debt.detail.includes('；环：'), false);     // 无 drift 数据 → 不强行叙述
});

test('基建裸奔（改动文件有缺口）→ yellow + audit 下一步', () => {
  const r = cockpit.runCockpit(baseOpts({
    gitChangedFiles: () => ['services/backend/src/foo.js'],
    readFile: () => 'function bar(){}',
    auditInfra: () => ({
      gaps: [
        { kind: 'missing-contract', file: 'services/backend/src/foo.js', symbol: 'bar' },
        { kind: 'missing-test', file: 'services/backend/src/foo.js', symbol: 'bar' }, // 应被排除
      ],
      byKind: { 'missing-contract': 1, 'missing-test': 1 },
    }),
  }));
  assert.strictEqual(r.level, 'yellow');
  const infra = r.checks.find(c => c.id === 'infra-gaps');
  assert.strictEqual(infra.status, 'yellow');
  // missing-test 被排除：仅算 1 处
  assert.match(infra.detail, /1 处待补/);
  assert.strictEqual(infra.detail.includes('missing-test'), false);
  assert.strictEqual(r.nextAction, 'khy maintain audit');
});

test('改动文件仅 missing-test → 仍 green（驾驶舱不据无依据的缺测报警）', () => {
  const r = cockpit.runCockpit(baseOpts({
    gitChangedFiles: () => ['services/backend/src/foo.js'],
    readFile: () => 'function bar(){}',
    auditInfra: () => ({ gaps: [{ kind: 'missing-test', file: 'x', symbol: 'bar' }], byKind: { 'missing-test': 1 } }),
  }));
  assert.strictEqual(r.checks.find(c => c.id === 'infra-gaps').status, 'green');
  assert.strictEqual(r.level, 'green');
});

test('无改动文件 → 基建检查 green', () => {
  const r = cockpit.runCockpit(baseOpts({ gitChangedFiles: () => [] }));
  assert.strictEqual(r.checks.find(c => c.id === 'infra-gaps').status, 'green');
});

test('fail-soft：检查抛错 → unknown，驾驶舱仍返回完整裁决', () => {
  const r = cockpit.runCockpit(baseOpts({
    checkMetadata: () => { throw new Error('boom'); },
    scanArchDebt: () => { throw new Error('boom2'); },
  }));
  assert.strictEqual(r.checks.length, 5);
  assert.strictEqual(r.checks.find(c => c.id === 'metadata').status, 'unknown');
  assert.strictEqual(r.checks.find(c => c.id === 'arch-debt').status, 'unknown');
  // unknown 不强于 green → 全 unknown/green 时 level 仍 green，绝不因探测失败误报警。
  assert.strictEqual(r.level, 'green');
  assert.strictEqual(r.ok, true);
});

test('unknown 不掩盖真实 red：探测失败 + 真实 red 共存 → level red', () => {
  const r = cockpit.runCockpit(baseOpts({
    checkMetadata: () => { throw new Error('boom'); },
    scanArchDebt: () => ({ neu: { layering: [{ file: 'a' }], godFiles: [], cycles: [] }, baselineCount: 0 }),
  }));
  assert.strictEqual(r.level, 'red');
});

test('版本读取失败 → unknown 但不影响整体绿', () => {
  const r = cockpit.runCockpit(baseOpts({
    readVersion: () => { throw new Error('no pkg'); },
  }));
  assert.strictEqual(r.checks.find(c => c.id === 'version').status, 'unknown');
  assert.strictEqual(r.level, 'green');
});

test('STATUS 与 SEVERITY 常量自洽', () => {
  assert.deepStrictEqual(Object.keys(cockpit.SEVERITY).sort(), ['green', 'red', 'unknown', 'yellow']);
  assert.strictEqual(cockpit.SEVERITY.red > cockpit.SEVERITY.yellow, true);
  assert.strictEqual(cockpit.SEVERITY.yellow > cockpit.SEVERITY.unknown, true);
  assert.strictEqual(cockpit.SEVERITY.unknown > cockpit.SEVERITY.green, true);
});

// ── 路由分流接线不变量（守护 maintain canonical 命令不被别名劫持） ──
test('wiring：maintain 是 canonical 命令且未被别名遮蔽', () => {
  const schema = require('../../src/constants/commandSchema');
  assert.strictEqual(schema.getRouterCommandNames().includes('maintain'), true);
  const aliases = require('../../src/cli/aliases');
  const resolved = aliases.resolveAlias('maintain');
  // 若 maintain 仍是别名（如指向 docs maintainer），canonical case 'maintain' 永不触发 → 驾驶舱不可达。
  assert.strictEqual(resolved == null || resolved.command === 'maintain', true,
    `maintain 不应被别名改写到 ${resolved && resolved.command}`);
});

test('wiring：maintain 子命令同时覆盖驾驶舱与 metadata', () => {
  const schema = require('../../src/constants/commandSchema');
  const subs = schema.getRouterSubCommands().maintain;
  for (const s of ['status', 'health', 'doctor', 'audit']) assert.strictEqual(subs.includes(s), true, `缺驾驶舱子命令 ${s}`);
  for (const s of ['gen', 'refresh', 'check', 'show', 'link', 'hook']) assert.strictEqual(subs.includes(s), true, `缺 metadata 子命令 ${s}`);
});

test('wiring：/maintain slash 路由到 maintain，且 docs 入口别名仍在', () => {
  const schema = require('../../src/constants/commandSchema');
  const slash = schema.getBuiltinSlashCommands().find(x => x.cmd === '/maintain');
  assert.ok(slash && slash.route === 'maintain');
  const aliases = require('../../src/cli/aliases');
  // 文档维护入口仍可达（维护/维护入口 → docs maintainer）。
  const docEntry = aliases.resolveAlias('维护');
  assert.ok(docEntry && docEntry.command === 'docs' && docEntry.subCommand === 'maintainer');
});

// ── 检查 ④：巨石预警（逼近阈值，预防面）────────────────────────────────
test('巨石预警：有文件逼近阈值 → yellow，点名 + 留余量建议', () => {
  const r = cockpit.runCockpit(baseOpts({
    scanApproaching: () => ({
      approaching: [
        { file: 'src/services/localBrainService.js', loc: 2438 },
        { file: 'src/services/gateway/adapters/traeAdapter.js', loc: 2377 },
        { file: 'src/cli/handlers/publish.js', loc: 2242 },
        { file: 'src/tasks/largeTaskRuntimeStore.js', loc: 2029 },
      ],
      threshold: 2500, warnFloor: 2000,
    }),
  }));
  const c = r.checks.find(x => x.id === 'approaching-god');
  assert.strictEqual(c.status, 'yellow');
  assert.match(c.detail, /4 个文件逼近巨石阈值/);
  assert.match(c.detail, /localBrainService\.js 2438/);   // 点名 basename + LOC
  assert.match(c.detail, /…/);                              // >3 时截断省略号
  assert.match(c.detail, /趁早拆分留出余量/);
  assert.strictEqual(c.action, 'npm run arch:debt');
});

test('巨石预警：无文件逼近 → green，含阈值数值', () => {
  const r = cockpit.runCockpit(baseOpts());
  const c = r.checks.find(x => x.id === 'approaching-god');
  assert.strictEqual(c.status, 'green');
  assert.match(c.detail, /无文件逼近 2500 行巨石阈值/);
  assert.strictEqual(c.action, null);
});

test('巨石预警：永不到 red，且不抢 arch-debt 的 red nextAction', () => {
  const r = cockpit.runCockpit(baseOpts({
    scanArchDebt: () => ({ neu: { layering: [], godFiles: [{ file: 'x.js', loc: 9000 }], cycles: [] }, baselineCount: 0 }),
    scanApproaching: () => ({ approaching: [{ file: 'y.js', loc: 2400 }], threshold: 2500, warnFloor: 2000 }),
  }));
  assert.strictEqual(r.level, 'red');                       // arch-debt 主导
  assert.strictEqual(r.nextAction, 'npm run arch:debt');    // red 行动优先
  assert.strictEqual(r.checks.find(x => x.id === 'approaching-god').status, 'yellow');
});

test('巨石预警：扫描抛错 → unknown，不崩、不污染裁决', () => {
  const r = cockpit.runCockpit(baseOpts({
    scanApproaching: () => { throw new Error('walk failed'); },
  }));
  const c = r.checks.find(x => x.id === 'approaching-god');
  assert.strictEqual(c.status, 'unknown');
  assert.match(c.detail, /扫描失败：walk failed/);
  assert.strictEqual(r.level, 'green');                     // unknown 不强于 green
});

test('巨石预警：默认扫描器走 archDebtScan 单一阈值真源（无硬编码 2500）', () => {
  // 不注入 scanApproaching → 走 _defaultApproachingScan 真实扫描；阈值应来自 archDebtScan.GOD_FILE_LOC。
  const scanner = require('../../scripts/archDebtScan');
  const r = cockpit.runCockpit({
    root: '/tmp/fake-repo', _now: 'TEST',
    checkMetadata: () => ({ ok: true, exists: true, stale: false }),
    hookStatus: () => ({ installed: true, ours: true }),
    scanArchDebt: () => ({ neu: { layering: [], godFiles: [], cycles: [] }, baselineCount: 0 }),
    gitChangedFiles: () => [], readFile: () => null,
    auditInfra: () => ({ gaps: [], byKind: {} }), readVersion: () => '9.9.9',
  });
  const c = r.checks.find(x => x.id === 'approaching-god');
  assert.ok(['green', 'yellow'].includes(c.status));        // 真实仓库：确定性地板，绝不 unknown/崩
  if (c.status === 'yellow') assert.match(c.detail, new RegExp(`未越 ${scanner.GOD_FILE_LOC} 行`));
});
