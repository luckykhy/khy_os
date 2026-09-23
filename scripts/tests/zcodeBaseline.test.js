'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { collect, summarize, DEFAULT_TARGETS, STAGE } = require('../ci/check-zcode-baseline.js');

const CHECKER = path.join(__dirname, '..', 'ci', 'check-zcode-baseline.js');

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

// 构造一个可控 fixture 根：源文件行数、守护脚本、日志编码、发布链都精确已知。
function buildFixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcb-'));
  mkdir(path.join(root, 'services', 'backend', 'src'));
  // 两个源文件：一个大（可配置）、一个小。
  const bigLines = 'a'.repeat(10) + '\n';
  const big = new Array(opts.bigFileLines || 10).fill(bigLines.trimEnd()).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'services', 'backend', 'src', 'big.js'), big);
  fs.writeFileSync(path.join(root, 'services', 'backend', 'src', 'small.js'), 'x = 1;\n');
  // 测试文件应被排除（不应拉高 p99）。
  mkdir(path.join(root, 'services', 'backend', 'src', '__tests__'));
  fs.writeFileSync(path.join(root, 'services', 'backend', 'src', 'big.test.js'), big);
  // node_modules 应被排除。
  mkdir(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'junk.js'), big.repeat(200));

  // 守护脚本：是否把 workflow require 包在 try 内（M2），是否含在途工作探针
  // anyProbeActive()（M3 防抖信号之一），由 opts 决定。
  mkdir(path.join(root, 'services', 'backend', 'scripts'));
  const probe = opts.probe ? "\nif (sessions.size > 0 || anyProbeActive()) return;\n" : '';
  const daemon = opts.guarded
    ? "const x = 1;\ntry {\n  const { w } = require('../src/services/workflow');\n} catch {}\n" + probe
    : "const x = 1;\nconst { w } = require('../src/services/workflow');\n// startup-timeout branch present\nif (idle) shutdown('startup-timeout');\nconst limit = Math.max(lastActiveAt, lastRequestAt);\n" + probe;
  fs.writeFileSync(path.join(root, 'services', 'backend', 'scripts', 'ai-manage-daemon.js'), daemon);

  // 日志：一个合法 UTF-8，一个非法字节（0xff 0xfe 非 UTF-8 序）。
  mkdir(path.join(root, '.khy', 'logs'));
  fs.writeFileSync(path.join(root, '.khy', 'logs', 'ok.log'), Buffer.from('正常中文日志\n', 'utf8'));
  if (opts.badLog) fs.writeFileSync(path.join(root, '.khy', 'logs', 'bad.log'), Buffer.from([0xff, 0xfe, 0x41]));

  // 发布链：SHA256 / SBOM 可分别落在脚本里或 workflow 里。
  mkdir(path.join(root, 'scripts', 'release'));
  const rel = opts.fullRelease
    ? 'sha256sum dist/* > SHA256SUMS\ncyclonedx sbom > sbom.json\n'
    : (opts.shaOnlyRelease ? 'sha256sum dist/* > SHA256SUMS\n' : 'echo build\n');
  fs.writeFileSync(path.join(root, 'scripts', 'release', 'publish.sh'), rel);
  // SBOM 步骤写在 release workflow 里（真实项目即如此）。
  if (opts.workflowSbom) {
    mkdir(path.join(root, '.github', 'workflows'));
    fs.writeFileSync(
      path.join(root, '.github', 'workflows', 'dual-channel-release.yml'),
      "      - name: Generate SBOM (npm)\n        run: npx @cyclonedx/cyclonedx-npm --output-file sbom.json .\n"
    );
  }
  return root;
}

test('STAGE 常量必须是合法阶段（S1–S4）', () => {
  assert.ok(['S1', 'S2', 'S3', 'S4'].includes(STAGE), `STAGE=${STAGE}`);
});

test('collect 返回七项指标且字段齐全', () => {
  const root = buildFixture({});
  const metrics = collect(root, DEFAULT_TARGETS);
  assert.strictEqual(metrics.length, 7);
  const ids = metrics.map((m) => m.id);
  for (const want of ['M1-architecture-size', 'M2-daemon-shim', 'M6-import-cycles', 'M7-deep-imports']) {
    assert.ok(ids.includes(want), '缺指标 ' + want);
  }
  for (const m of metrics) {
    assert.ok(m.id && m.label && m.target && m.current, '缺字段: ' + JSON.stringify(m));
    assert.ok(['PASS', 'PARTIAL', 'GAP', 'OBSERVE'].includes(m.status), `非法状态: ${m.status}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('无 policy 时 M6/M7 为 OBSERVE（不误判）', () => {
  const root = buildFixture({});
  const metrics = collect(root, DEFAULT_TARGETS);
  assert.strictEqual(metrics.find((m) => m.id === 'M6-import-cycles').status, 'OBSERVE');
  assert.strictEqual(metrics.find((m) => m.id === 'M7-deep-imports').status, 'OBSERVE');
  fs.rmSync(root, { recursive: true, force: true });
});

test('M1: 超硬顶大文件判 GAP；测试文件与 node_modules 被排除', () => {
  const root = buildFixture({ bigFileLines: 2000 }); // big.js 超 1500 硬顶
  const m = collect(root, DEFAULT_TARGETS).find((x) => x.id === 'M1-architecture-size');
  assert.strictEqual(m.status, 'GAP');
  // big.test.js 与 node_modules/junk.js 都不该计入 → 超硬顶只有 big.js 一个。
  assert.match(m.current, /超硬顶 1/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('M1: 文件都在阈值内判 PASS', () => {
  const root = buildFixture({ bigFileLines: 50 });
  const m = collect(root, DEFAULT_TARGETS).find((x) => x.id === 'M1-architecture-size');
  assert.strictEqual(m.status, 'PASS');
  fs.rmSync(root, { recursive: true, force: true });
});

test('M2: 顶层裸 require 判 GAP；try/catch fail-soft 包裹后判 PASS', () => {
  const bare = buildFixture({});
  const mBare = collect(bare, DEFAULT_TARGETS).find((x) => x.id === 'M2-daemon-shim');
  assert.strictEqual(mBare.status, 'GAP');
  fs.rmSync(bare, { recursive: true, force: true });

  const guarded = buildFixture({ guarded: true });
  const mG = collect(guarded, DEFAULT_TARGETS).find((x) => x.id === 'M2-daemon-shim');
  assert.strictEqual(mG.status, 'PASS');
  fs.rmSync(guarded, { recursive: true, force: true });
});

test('M3: startup-timeout 有请求存活但缺在途探针判 PARTIAL；两者齐全判 PASS', () => {
  // 只有 Math.max(...lastRequestAt)（无 anyProbeActive）→ 单一存活信号 → PARTIAL
  const partial = buildFixture({});
  const mP = collect(partial, DEFAULT_TARGETS).find((x) => x.id === 'M3-daemon-liveness');
  assert.strictEqual(mP.status, 'PARTIAL');
  fs.rmSync(partial, { recursive: true, force: true });

  // 请求存活 + 在途工作探针都在 → 只在真空闲触发 → PASS
  const good = buildFixture({ probe: true });
  const mG = collect(good, DEFAULT_TARGETS).find((x) => x.id === 'M3-daemon-liveness');
  assert.strictEqual(mG.status, 'PASS');
  fs.rmSync(good, { recursive: true, force: true });
});

test('M4: 无非法日志判 PASS，含非法字节判 GAP', () => {
  const good = buildFixture({});
  const mGood = collect(good, DEFAULT_TARGETS).find((x) => x.id === 'M4-log-encoding');
  assert.strictEqual(mGood.status, 'PASS');
  fs.rmSync(good, { recursive: true, force: true });

  const bad = buildFixture({ badLog: true });
  const mBad = collect(bad, DEFAULT_TARGETS).find((x) => x.id === 'M4-log-encoding');
  assert.strictEqual(mBad.status, 'GAP');
  assert.match(mBad.current, /异常 1/);
  fs.rmSync(bad, { recursive: true, force: true });
});

test('M5: 发布链含 SHA256+SBOM 判 PASS', () => {
  const full = buildFixture({ fullRelease: true });
  const m = collect(full, DEFAULT_TARGETS).find((x) => x.id === 'M5-distribution-integrity');
  assert.strictEqual(m.status, 'PASS');
  fs.rmSync(full, { recursive: true, force: true });
});

test('M5: SBOM 只写在 release workflow 里也算发布链（扩检 scope）', () => {
  // 脚本仅有校验和，SBOM 步骤在 workflow YAML —— 真实项目即此形态。
  const wf = buildFixture({ shaOnlyRelease: true, workflowSbom: true });
  const m = collect(wf, DEFAULT_TARGETS).find((x) => x.id === 'M5-distribution-integrity');
  assert.strictEqual(m.status, 'PASS');
  assert.match(m.current, /含 release workflow=true/);
  fs.rmSync(wf, { recursive: true, force: true });
});

test('M5: 有校验和无 SBOM（脚本与 workflow 皆无）判 PARTIAL', () => {
  const shaOnly = buildFixture({ shaOnlyRelease: true });
  const m = collect(shaOnly, DEFAULT_TARGETS).find((x) => x.id === 'M5-distribution-integrity');
  assert.strictEqual(m.status, 'PARTIAL');
  assert.match(m.current, /SBOM=false/);
  fs.rmSync(shaOnly, { recursive: true, force: true });
});

test('summarize 计数与状态一致', () => {
  const root = buildFixture({});
  const metrics = collect(root, DEFAULT_TARGETS);
  const s = summarize(metrics);
  const total = s.PASS + s.PARTIAL + s.GAP + s.OBSERVE;
  assert.strictEqual(total, metrics.length);
  fs.rmSync(root, { recursive: true, force: true });
});

test('S1 非阻断：即便存在 GAP，脚本仍恒 exit 0', () => {
  const root = buildFixture({}); // 有 GAP（M2/M4 部分）
  const r = cp.spawnSync(process.execPath, [CHECKER, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, KHY_ZCODE_BASELINE_ROOT: root },
    timeout: 15000,
  });
  assert.strictEqual(r.status, 0, '观察者档必须恒返回 0');
  const report = JSON.parse(r.stdout);
  assert.strictEqual(report.stage, STAGE);
  assert.strictEqual(report.blocking, false);
  assert.ok(Array.isArray(report.metrics) && report.metrics.length === 7);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── policy 驱动的架构契约测试 ────────────────────────────────────────────────
const POLICY_PATH = path.join('docs', '10_规范', 'registry', 'ARCHITECTURE-POLICY.json');

// 建一个带 ARCHITECTURE-POLICY.json 的 fixture：两个纳管模块 a/b，可配置成环与超长。
function buildPolicyFixture({ cycle = false, bigManaged = false, deepImport = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcbp-'));
  mkdir(path.join(root, 'services', 'backend', 'src', 'a'));
  mkdir(path.join(root, 'services', 'backend', 'src', 'b'));
  const policy = {
    global: { maxFileLines: 400, forbidCycles: true, forbidDeepImports: true, managedOnly: true },
    modules: [
      { id: 'a', roots: ['services/backend/src/a'], managed: true },
      { id: 'b', roots: ['services/backend/src/b'], managed: true },
    ],
  };
  if (deepImport) {
    policy.modules.push({ id: 'c', roots: ['services/backend/src/c'], managed: false, publicEntrypoints: ['services/backend/src/c/index.js'] });
    mkdir(path.join(root, 'services', 'backend', 'src', 'c'));
    fs.writeFileSync(path.join(root, 'services', 'backend', 'src', 'c', 'index.js'), 'exports.x = 1;\n');
    fs.writeFileSync(path.join(root, 'services', 'backend', 'src', 'c', 'inner.js'), 'exports.y = 2;\n');
  }
  mkdir(path.join(root, 'docs', '10_规范', 'registry'));
  fs.writeFileSync(path.join(root, POLICY_PATH), JSON.stringify(policy));
  const aBody = bigManaged ? Array.from({ length: 500 }, () => 'a=1;').join('\n') + '\n' : 'const b = require("../b/b.js");\n';
  let aCode = aBody;
  if (deepImport) aCode += 'const inner = require("../c/inner.js");\n';
  fs.writeFileSync(path.join(root, 'services', 'backend', 'src', 'a', 'a.js'), aCode);
  fs.writeFileSync(path.join(root, 'services', 'backend', 'src', 'b', 'b.js'),
    cycle ? 'const a = require("../a/a.js");\n' : 'const x = 1;\n');
  return root;
}

test('M1 policy: 纳管模块含超长文件判 GAP', () => {
  const root = buildPolicyFixture({ bigManaged: true });
  const m = collect(root, DEFAULT_TARGETS).find((x) => x.id === 'M1-architecture-size');
  assert.strictEqual(m.status, 'GAP');
  assert.match(m.current, /违规 1/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('M6 policy: 纳管模块互相 import 成环判 GAP；单向依赖判 PASS', () => {
  const cyc = buildPolicyFixture({ cycle: true });
  const mCyc = collect(cyc, DEFAULT_TARGETS).find((x) => x.id === 'M6-import-cycles');
  assert.strictEqual(mCyc.status, 'GAP');
  assert.match(mCyc.current, /纳管间环 1/);
  fs.rmSync(cyc, { recursive: true, force: true });

  const noCyc = buildPolicyFixture({}); // a→b 单向
  const mNo = collect(noCyc, DEFAULT_TARGETS).find((x) => x.id === 'M6-import-cycles');
  assert.strictEqual(mNo.status, 'PASS');
  fs.rmSync(noCyc, { recursive: true, force: true });
});

test('M7 policy: 纳管模块深引用非入口文件判 GAP', () => {
  const root = buildPolicyFixture({ deepImport: true });
  const m = collect(root, DEFAULT_TARGETS).find((x) => x.id === 'M7-deep-imports');
  assert.strictEqual(m.status, 'GAP');
  assert.match(m.current, /深引用违规 1/);
  fs.rmSync(root, { recursive: true, force: true });
});
