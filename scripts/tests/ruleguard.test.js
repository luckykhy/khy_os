'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { globToRegExp, matchesAny, splitScope } = require('../ruleguard/lib/glob');
const { loadRegistry, gateIncluded, gateStrength, pathsFromScope, execFromEnforcement } = require('../ruleguard/lib/registry');
const { buildManifest } = require('../ruleguard/lib/manifest');
const { applyToPath, applyToPaths } = require('../ruleguard/lib/apply');
const { parseFindings, mapToRules } = require('../ruleguard/lib/run');
const { load, evaluate, write } = require('../ruleguard/lib/baseline');
const { readSuppressions } = require('../ruleguard/lib/suppression');
const { buildCoverage, coverageCode, renderCoverage } = require('../ruleguard/lib/coverage');
const { run } = require('../ruleguard/lib/run');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ─── glob ───────────────────────────────────────────────────────────────────

test('glob: 单星不跨目录', () => {
  assert.equal(matchesAny(['services/*'], 'services/backend'), true);
  assert.equal(matchesAny(['services/*'], 'services/backend/src/x.js'), false);
});

test('glob: 双星跨任意深度且可匹配零层', () => {
  assert.equal(matchesAny(['services/**'], 'services/a.js'), true);
  assert.equal(matchesAny(['services/**'], 'services/backend/src/deep/a.js'), true);
  assert.equal(matchesAny(['services/**'], 'apps/ai-frontend/x.js'), false);
});

test('glob: 问号匹配单字符', () => {
  assert.equal(matchesAny(['package.json5?'], 'package.json51'), true);
  assert.equal(matchesAny(['package.json?'], 'package.json'), false);
});

test('glob: 否定模式优先否决', () => {
  assert.equal(matchesAny(['scripts/**/*.js', '!scripts/tests/**'], 'scripts/ci/a.js'), true);
  assert.equal(matchesAny(['scripts/**/*.js', '!scripts/tests/**'], 'scripts/tests/a.test.js'), false);
});

test('glob: 空模式列表永不命中', () => {
  assert.equal(matchesAny([], 'services/a.js'), false);
  assert.equal(matchesAny(['   '], 'services/a.js'), false);
});

test('glob: 反斜杠归一为斜杠（Windows 路径）', () => {
  assert.equal(matchesAny(['services/**'], 'services\\backend\\src\\a.js'), true);
});

test('glob: 正则元字符被转义而非解释', () => {
  assert.equal(matchesAny(['a.b.js'], 'aXb.js'), false);
  assert.equal(matchesAny(['a.b.js'], 'a.b.js'), true);
});

test('splitScope: 中英文逗号都能切分', () => {
  assert.deepEqual(splitScope('services/**, apps/**'), ['services/**', 'apps/**']);
  assert.deepEqual(splitScope('services/**，apps/**'), ['services/**', 'apps/**']);
});

test('pathsFromScope: 丢弃散文描述只留路径形态', () => {
  const scope = 'services/**, 面向用户的错误消息, CLI 输出';
  assert.deepEqual(pathsFromScope(scope), ['services/**']);
});

// ─── registry 派生 ──────────────────────────────────────────────────────────

test('gateIncluded: commit ⊂ pr ⊂ release', () => {
  assert.equal(gateIncluded('commit', 'commit'), true);
  assert.equal(gateIncluded('pr', 'commit'), false);
  assert.equal(gateIncluded('pr', 'pr'), true);
  assert.equal(gateIncluded('release', 'pr'), false);
  assert.equal(gateIncluded('release', 'release'), true);
  assert.equal(gateIncluded('manual', 'release'), false);
  assert.equal(gateIncluded('advisory', 'release'), false);
  assert.equal(gateIncluded('advisory', 'advisory-all'), true);
});

test('gateStrength: 优先级派生且可被 severity 覆盖', () => {
  assert.equal(gateStrength({ priority: 'P0' }), 'blocking');
  assert.equal(gateStrength({ priority: 'P1' }), 'blocking');
  assert.equal(gateStrength({ priority: 'P2' }), 'ratchet');
  assert.equal(gateStrength({ priority: 'P3' }), 'advisory');
  assert.equal(gateStrength({ priority: 'P1', severity: 'ratchet' }), 'ratchet');
});

test('execFromEnforcement: 区分检查器、载体与锚点', () => {
  const exists = (p) => fs.existsSync(path.join(REPO_ROOT, p));

  const parsed = execFromEnforcement(
    'docs/_规范/RULES-REGISTRY.json / scripts/ci/check-gov-rules.js checkRulesRegistry',
    exists,
  );
  assert.equal(parsed.script, 'scripts/ci/check-gov-rules.js');
  // 函数名与数据文件都留作出处，只有检查器进 script。
  assert.ok(parsed.anchors.includes('checkRulesRegistry'));
  assert.ok(parsed.anchors.some((a) => a.endsWith('.json')));
  assert.equal(parsed.carriers.length, 0);
  // .json 不得被误当成 .js 脚本。
  assert.ok(!parsed.script.endsWith('.json'));

  // 运行时代码不进 exec.script —— 否则 ruleguard 会把服务模块当检查器去 spawn。
  const runtime = execFromEnforcement('services/backend/src/permissions/rules.js', exists);
  assert.equal(runtime.script, null);
  assert.deepEqual(runtime.carriers, ['services/backend/src/permissions/rules.js']);
});

// ─── finding 解析 ───────────────────────────────────────────────────────────

test('parseFindings: 解析 [ERROR] id file:line 及其缩进正文', () => {
  const output = [
    '[ruleguard] action=start target=x',
    '[ERROR] no-hardcoded-endpoint services/backend/src/a.js:42',
    '  检测到硬编码端点 http://localhost:3000',
    '  const url = "http://localhost:3000/api"',
    '[WARN ] no-opaque-status services/backend/src/b.js:7',
    '  含糊状态文本',
    '',
    'Summary: 1 error(s), 1 warning(s)',
  ].join('\n');

  const findings = parseFindings(output);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    { id: findings[0].finding, file: findings[0].file, line: findings[0].line, sev: findings[0].severity },
    { id: 'no-hardcoded-endpoint', file: 'services/backend/src/a.js', line: 42, sev: 'error' },
  );
  assert.match(findings[0].message, /硬编码端点/);
  assert.equal(findings[1].severity, 'warning');
});

test('parseFindings: 聚合方言（check-repo-layout）按 id 认领且不带位置', () => {
  // check-repo-layout 与多数检查器不同：项目符号列表 + 行尾 (id: …)，
  // 报告的是聚合计数而非 file:line。这条必须解析出来，否则整个层级守卫
  // 只剩一个「退出码非零」的黑盒记录。
  const output = [
    'check-repo-layout: 层级/结构守卫',
    ' - [error] (promoted from warning) 87 个被引用的 npm run 目标没有对应脚本定义。 (id: dangling-task)',
    '   分布：bench, deploy, dev:frontend',
    ' - [warn] 1 处拓展契约缺失。 (id: extension-contract)',
    '',
    'Summary: 1 error(s), 1 warning(s)',
  ].join('\n');

  const findings = parseFindings(output);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    { id: findings[0].finding, sev: findings[0].severity, file: findings[0].file, line: findings[0].line },
    { id: 'dangling-task', sev: 'error', file: '', line: 0 },
  );
  assert.match(findings[0].message, /npm run 目标/);
  assert.equal(findings[1].severity, 'warning');
  // 缩进正文照常被吸收（check-repo-layout 用 3 空格缩进分布明细）。
  assert.match(findings[0].message, /bench, deploy/);
});

test('ownerStrengths: 按 finding id 反查规则强度，决定失败是否闭合', () => {
  const { ownerStrengths } = require('../ruleguard/lib/run');
  const manifest = {
    rules: [
      { id: 'LAYOUT-001', strength: 'blocking', findings: ['cross-layer-require'] },
      { id: 'LAYOUT-002', strength: 'advisory', findings: ['god-file'] },
      { id: 'SOURCING-005', strength: 'ratchet', findings: ['duplicate-block'] },
      { id: 'UNRELATED', strength: 'blocking', findings: [] },
    ],
  };
  assert.deepEqual(ownerStrengths(['cross-layer-require'], manifest), ['blocking']);
  assert.deepEqual(ownerStrengths(['god-file'], manifest), ['advisory']);
  // findings 为空时回退到规则 id 本身。
  assert.deepEqual(ownerStrengths(['UNRELATED'], manifest), ['blocking']);
  assert.deepEqual(ownerStrengths(['not-a-known-id'], manifest), []);
});

test('mapToRules: 未登记的 finding 单列而非静默丢弃', () => {
  const manifest = {
    rules: [{ id: 'RUNTIME-001', findings: ['no-hardcoded-endpoint'] }],
  };
  const { mapped, unmapped } = mapToRules(
    [
      { finding: 'no-hardcoded-endpoint', file: 'a.js', line: 1, severity: 'error' },
      { finding: 'unknown-id', file: 'b.js', line: 2, severity: 'error' },
    ],
    manifest,
  );
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].rule, 'RUNTIME-001');
  assert.deepEqual(unmapped.map((f) => f.finding), ['unknown-id']);
});

// ─── 基线棘轮 ───────────────────────────────────────────────────────────────

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('baseline: 基线内放行，超量阻断', () => {
  const root = tmpDir('ruleguard-baseline-');
  const baselinePath = path.join(root, 'baseline.json');
  process.env.KHY_RULEGUARD_BASELINE = baselinePath;
  try {
    const written = write(root, { 'RULE-1': 5 });
    assert.equal(written.counts['RULE-1'], 5);

    const baseline = load(root);
    assert.equal(evaluate({ 'RULE-1': 5 }, baseline).blocking['RULE-1'], undefined);
    assert.equal(evaluate({ 'RULE-1': 6 }, baseline).blocking['RULE-1'], 6);
    assert.equal(evaluate({ 'RULE-1': 6 }, baseline).over['RULE-1'], 1);
  } finally {
    delete process.env.KHY_RULEGUARD_BASELINE;
  }
});

test('baseline: 只降不升，回退不能悄悄放宽额度', () => {
  const root = tmpDir('ruleguard-baseline-ratchet-');
  process.env.KHY_RULEGUARD_BASELINE = path.join(root, 'baseline.json');
  try {
    write(root, { 'RULE-1': 10 });
    // 观测值从 10 升到 15：棘轮不许把基线抬到 15，否则等于默许回退。
    const widened = write(root, { 'RULE-1': 15 });
    assert.equal(widened.counts['RULE-1'], 10);

    // 观测值下降到 3：基线收紧到 3。
    const tightened = write(root, { 'RULE-1': 3 });
    assert.equal(tightened.counts['RULE-1'], 3);
  } finally {
    delete process.env.KHY_RULEGUARD_BASELINE;
  }
});

// ─── 抑制约定 ───────────────────────────────────────────────────────────────

test('suppression: 带理由生效，空理由无效', () => {
  const root = tmpDir('ruleguard-suppress-');
  const file = path.join(root, 'a.js');
  fs.writeFileSync(
    file,
    ['// khy-allow-RUNTIME-001: 端点探测夹具', 'const u = "http://localhost:3000";', ''].join('\n'),
  );
  const { suppressions, invalid } = readSuppressions(file);
  assert.equal(invalid.length, 0);
  assert.equal(suppressions.get('RUNTIME-001').length, 1);
  assert.match(suppressions.get('RUNTIME-001')[0].reason, /夹具/);

  fs.writeFileSync(file, ['// khy-allow-RUNTIME-001:', 'const u = "http://x";', ''].join('\n'));
  const empty = readSuppressions(file);
  assert.equal(empty.suppressions.get('RUNTIME-001'), undefined);
  assert.equal(empty.invalid.length, 1);
  assert.equal(empty.invalid[0].ruleId, 'RUNTIME-001');
});

test('suppression: 检查器输出绝对路径时仍能在同一文件里找到抑制', () => {
  // Windows 上 path.join(root, 'C:\\...\\a.js') 会拼成一条死路径，抑制文件就
  // 静默读不到——被抑制的违规仍会阻断。resolveSuppression 必须容忍两种写法。
  const root = tmpDir('ruleguard-suppress-abs-');
  const file = path.join(root, 'a.js');
  fs.writeFileSync(
    file,
    ['// khy-allow-RUNTIME-001: 端点探测夹具', 'const u = "http://localhost:3000";'].join('\n'),
  );

  const { resolveSuppression } = require('../ruleguard/lib/run');
  const finding = { rule: 'RUNTIME-001', file, line: 2 };

  const byAbsolute = resolveSuppression(root, finding);
  assert.equal(byAbsolute.state, 'suppressed', '绝对路径的 finding 必须解析到本文件的抑制');
  assert.match(byAbsolute.reason, /夹具/);

  // 反斜杠写法（Windows 真实输出形态）同样必须生效。
  const byBackslash = resolveSuppression(root, { ...finding, file: file.split(path.sep).join('/') });
  assert.equal(byBackslash.state, 'suppressed');

  // 前向斜杠归一：Linux 风格的输出也指向同一文件。
  const byForward = resolveSuppression(root, { ...finding, file: path.join('services', 'a.js') });
  assert.equal(byForward.state, 'active', '路径不匹配时不得误判为已抑制');
});

// ─── 端到端：夹具仓库负例 ───────────────────────────────────────────────────

function makeFixture({ deadPointer = false } = {}) {
  const root = tmpDir('ruleguard-e2e-');
  const secondScript = deadPointer ? 'check-missing.js' : 'check-second.js';
  fs.mkdirSync(path.join(root, 'docs', '_规范'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
  fs.mkdirSync(path.join(root, 'services', 'backend', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        'check:fixture': 'node scripts/ci/check-fixture.js',
        'check:other': `node scripts/ci/${secondScript}`,
      },
    }),
  );
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'pr.yml'), 'run: node scripts/ci/check-fixture.js\n');

  fs.writeFileSync(
    path.join(root, 'docs', '_规范', 'rules-registry.json'),
    JSON.stringify({
      meta: { name: 'fixture', version: '1.0.0', domains: ['RUNTIME', 'TOOLING'], ruleCount: 2 },
      rules: [
        {
          id: 'RUNTIME-001', name: '零硬编码', domain: 'RUNTIME', nature: '约束为主',
          scope: 'services/**', priority: 'P1', status: 'active',
          trigger: '新增端点时', constraint: '禁止字面量端点', grants: '无新增权力',
          benefit: '域名迁移不分叉', exception: '测试夹具', version: '1.0.0',
          formerly: '无', ssot: 'docs/_规范/a.md', owner: 'test',
          gate: 'pr',
          paths: ['services/**'],
          exec: { script: 'scripts/ci/check-fixture.js', args: [], findings: ['no-hardcoded-endpoint'] },
        },
        {
          id: 'TOOLING-005', name: '本地与 CI 双注册', domain: 'TOOLING', nature: '约束为主',
          scope: 'scripts/**', priority: 'P1', status: 'active',
          trigger: '新增检查器时', constraint: '必须接线', grants: '无新增权力',
          benefit: '检查器不会静默失效', exception: '见豁免登记', version: '1.0.0',
          formerly: '无', ssot: 'docs/_规范/b.md', owner: 'test',
          gate: 'pr',
          paths: ['scripts/**'],
          exec: { script: `scripts/ci/${secondScript}`, args: [], findings: [] },
        },
      ],
    }, null, 2),
  );

  fs.writeFileSync(
    path.join(root, 'scripts', 'ci', 'check-fixture.js'),
    [
      "const fs = require('fs');",
      "const target = process.env.FIXTURE_TARGET;",
      "if (target && fs.existsSync(target)) {",
      "  const lines = fs.readFileSync(target, 'utf8').split('\\n');",
      "  const hit = lines.findIndex((l) => l.includes('http://localhost:3000'));",
      "  if (hit >= 0) console.log(`[ERROR] no-hardcoded-endpoint ${target}:${hit + 1}`);",
      "  console.log('Summary: ' + (hit >= 0 ? 1 : 0) + ' error(s), 0 warning(s)');",
      "  process.exitCode = hit >= 0 ? 1 : 0;",
      "} else { console.log('Summary: 0 error(s), 0 warning(s)'); }",
    ].join('\n'),
  );

  // 非死指针夹具提供一个真实存在的第二个检查器，避免它因路径缺失而
  // 额外贡献一条 checker-failure 阻断，干扰对被测行为的断言。
  if (!deadPointer) {
    fs.writeFileSync(path.join(root, 'scripts', 'ci', secondScript), 'console.log("Summary: 0 error(s), 0 warning(s)");\n');
  }

  return root;
}

test('e2e: 违规被抓、可映射到规则 ID 且阻断', () => {
  const root = makeFixture();
  const violating = path.join(root, 'services', 'backend', 'src', 'api.js');
  fs.writeFileSync(violating, 'const url = "http://localhost:3000/api";\n');
  process.env.FIXTURE_TARGET = violating;

  try {
    const { code, report } = run({ repoRoot: root, mode: 'pr', ledger: false });
    assert.equal(code, 1);
    const violation = report.violations.find((v) => v.rule === 'RUNTIME-001');
    assert.ok(violation, '必须产出 RUNTIME-001 违规');
    assert.equal(violation.blocking, true);
    assert.equal(violation.finding, 'no-hardcoded-endpoint');
    assert.equal(report.summary.blocking, 1);
  } finally {
    delete process.env.FIXTURE_TARGET;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('e2e: 带理由的抑制放行且留痕', () => {
  const root = makeFixture();
  const violating = path.join(root, 'services', 'backend', 'src', 'api.js');
  fs.writeFileSync(
    violating,
    ['// khy-allow-RUNTIME-001: 端点探测夹具', 'const url = "http://localhost:3000/api";'].join('\n'),
  );
  process.env.FIXTURE_TARGET = violating;

  try {
    const { code, report } = run({ repoRoot: root, mode: 'pr', ledger: false });
    assert.equal(code, 0, '已抑制的违规不得阻断');
    const violation = report.violations.find((v) => v.rule === 'RUNTIME-001');
    assert.ok(violation, '被抑制的违规仍须记录');
    assert.equal(violation.suppressed, true);
    assert.equal(violation.blocking, false);
    assert.match(violation.suppressionReason, /夹具/);
  } finally {
    delete process.env.FIXTURE_TARGET;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('e2e: 空理由抑制无效，违规仍阻断', () => {
  const root = makeFixture();
  const violating = path.join(root, 'services', 'backend', 'src', 'api.js');
  fs.writeFileSync(violating, ['// khy-allow-RUNTIME-001:', 'const url = "http://localhost:3000/api";'].join('\n'));
  process.env.FIXTURE_TARGET = violating;

  try {
    const { code, report } = run({ repoRoot: root, mode: 'pr', ledger: false });
    assert.equal(code, 1, '空理由抑制必须无效');
    assert.equal(report.invalidSuppressions.length, 1);
    assert.match(report.invalidSuppressions[0].message, /缺少理由/);
    const violation = report.violations.find((v) => v.rule === 'RUNTIME-001');
    assert.equal(violation.blocking, true);
  } finally {
    delete process.env.FIXTURE_TARGET;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('e2e: 执行器路径不存在的规则构成死指针红线', () => {
  const root = makeFixture({ deadPointer: true });
  try {
    const cov = buildCoverage(root);
    const dead = cov.redLines.find((line) => line.code === 'dead-pointer' && line.rule === 'TOOLING-005');
    assert.ok(dead, 'check-missing.js 不存在必须被记为死指针');
    assert.equal(coverageCode(cov), 1, '死指针必须使覆盖率检查失败');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── 真实仓库不变量（golden，但只断言结构性质不锁死计数） ─────────────────────

test('registry: 真实登记表可加载且每条规则都有明确归类', () => {
  const registry = loadRegistry(REPO_ROOT);
  assert.equal(registry.errors.length, 0, `登记表结构问题：${registry.errors.map((e) => e.message).join(' | ')}`);
  assert.ok(registry.rules.length > 0);

  const kinds = new Set(['enforced', 'declared', 'declared-uwired', 'dead-pointer', 'carrier', 'manual', 'unenforced']);
  for (const rule of registry.rules) {
    assert.ok(kinds.has(rule.kind), `规则 ${rule.id} 归类为未知值 ${rule.kind}`);
    assert.ok(['commit', 'pr', 'release', 'manual', 'advisory'].includes(rule.gate));
    assert.ok(['blocking', 'ratchet', 'advisory'].includes(rule.strength));
    assert.notEqual(rule.kind, 'unknown', '不允许出现 unknown 归类');
  }
});

test('manifest: enforced 规则必须声明真实存在的执行器', () => {
  const { loadBinding } = require('../ruleguard/lib/registry');
  const { registry, wiring } = loadBinding(REPO_ROOT);
  const manifest = buildManifest(registry, wiring);

  for (const rule of manifest.rules.filter((r) => r.kind === 'enforced')) {
    assert.ok(rule.script, `${rule.id} 归类 enforced 但无执行器`);
    assert.ok(rule.wired, `${rule.id} 归类 enforced 但未接线`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rule.script)), `${rule.id} 执行器不存在`);
  }
  assert.ok((manifest.summary.byKind.enforced || 0) >= 20, 'enforced 数量异常偏低，检查登记表补登是否回退');
});

test('apply: 按路径查规则且按优先级排序', () => {
  const registry = loadRegistry(REPO_ROOT);
  const matched = applyToPath(registry.rules, 'services/backend/src/api/foo.js');
  assert.ok(matched.some((r) => r.id === 'RUNTIME-001'));
  const priorities = matched.map((r) => r.priority);
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  assert.deepEqual(
    priorities,
    [...priorities].sort((a, b) => order[a] - order[b]),
    '适用规则必须按优先级升序',
  );

  const outside = applyToPaths(registry.rules, ['非存在目录/x.js']);
  assert.equal(outside.length, 0, '未命中任何 paths 的路径不得返回规则');
});

test('registry: check-repo-layout 声明的每一类计数都被某条规则认领', () => {
  // 该检查器的基线文件枚举了它报告的全部类别。若登记表漏认领其中一类，
  // 那一类的违规会以 unmapped 出现而不是归到具体规则上——静默脱钩。
  const { loadRegistry } = require('../ruleguard/lib/registry');
  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'ci', 'repo-layout-baseline.json'), 'utf8'),
  );
  const registry = loadRegistry(REPO_ROOT);

  const claimed = new Set();
  for (const rule of registry.rules) {
    for (const f of (rule.exec && rule.exec.findings) || []) claimed.add(f);
  }

  const missing = Object.keys(baseline.counts).filter((k) => !claimed.has(k));
  assert.deepEqual(missing, [], 'check-repo-layout 有未被规则认领的计数类别');
});

test('coverage: 渲染包含覆盖率与红线结论', () => {
  const data = buildCoverage(REPO_ROOT);
  const text = renderCoverage(data);
  assert.match(text, /规则遵守覆盖率/);
  assert.match(text, /已执行 \d+ 条/);
  assert.ok(Number(data.summary.total) > 0);
  assert.ok(data.rate <= 100);
});
