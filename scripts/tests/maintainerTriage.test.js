'use strict';

/**
 * maintainerTriage.test.js — 症状分诊器契约测试
 *
 *   node --test scripts/tests/maintainerTriage.test.js
 *
 * 硬保证：典型症状命中正确子系统、确定性排序、幂等、畸形输入绝不抛、
 * 返回结构含 paths/docs/verify、中英症状皆命中、真实映射表可加载。
 */

const test = require('node:test');
const assert = require('node:assert');

const t = require('../lib/maintainerTriage');

// 内联 fixture：贴近真实映射表的 id，使打分逻辑与登记步骤解耦、可独立断言。
const FIXTURE = [
  {
    id: 'bootstrap-packaging',
    label: 'Bootstrap and Packaging',
    whenToUse: ['CLI does not start', 'pip package layout is broken', 'version numbers drift'],
    paths: ['platform/khy_platform/cli.py', 'pyproject.toml'],
    docs: ['README.md'],
    verify: ['npm run check:maintainer:bootstrap'],
  },
  {
    id: 'cli-routing',
    label: 'CLI Routing and Help Surface',
    whenToUse: ['command not recognized', 'alias routes to wrong command', 'slash command missing'],
    paths: ['services/backend/src/cli/router.js'],
    docs: ['docs/07_OPS_运维/[OPS-MAN-013] khy-os-开发者指南.md'],
    verify: ['npm run test:maintainer:cli-routing'],
  },
  {
    id: 'gateway-adapters',
    label: 'AI Gateway and Adapter Layer',
    whenToUse: ['adapter selection is wrong', 'streaming breaks', 'model fallback is wrong'],
    paths: ['services/backend/src/services/gateway/aiGateway.js'],
    docs: [],
    verify: ['npm run test:maintainer:gateway', 'khy doctor'],
  },
  {
    id: 'proxy-daemon-runtime',
    label: 'Proxy, Daemon, and Runtime Port Discovery',
    whenToUse: ['daemon starts on wrong port', 'port drift appears after restart'],
    paths: ['services/backend/src/services/daemonManager.js'],
    docs: [],
    verify: ['npm run test:maintainer:runtime'],
  },
  {
    id: 'release-rollback',
    label: 'Release and Rollback',
    whenToUse: ['roll back to the last known-good version'],
    paths: ['maintenance/stable-release.json'],
    docs: [],
    verify: ['npm run check:version-sync'],
  },
];

function topId(text) {
  const r = t.triageSymptom(text, { map: FIXTURE, limit: 1 });
  return r.length ? r[0].id : null;
}

test('英文症状:CLI does not start → bootstrap-packaging', () => {
  assert.strictEqual(topId('the CLI does not start at all'), 'bootstrap-packaging');
});

test('中文症状:识图 404 兜底 → gateway-adapters', () => {
  assert.strictEqual(topId('识图老是404还落剪贴板兜底'), 'gateway-adapters');
});

test('中文症状:守护进程端口漂移 → proxy-daemon-runtime', () => {
  assert.strictEqual(topId('守护进程端口漂移连不上'), 'proxy-daemon-runtime');
});

test('英文症状:slash command missing → cli-routing', () => {
  assert.strictEqual(topId('my slash command is missing'), 'cli-routing');
});

test('中文症状:回滚稳定版 → release-rollback', () => {
  assert.strictEqual(topId('我要回滚到上一个稳定版 rollback'), 'release-rollback');
});

test('无关文本 → 空数组（不硬塞）', () => {
  const r = t.triageSymptom('今天天气不错适合散步喝咖啡', { map: FIXTURE });
  assert.strictEqual(Array.isArray(r), true);
  assert.strictEqual(r.length, 0);
});

test('返回结构含 paths/docs/verify/firstFile/firstVerify', () => {
  const r = t.triageSymptom('识图 model fallback 出错', { map: FIXTURE, limit: 1 });
  assert.ok(r.length >= 1);
  const top = r[0];
  assert.ok(Array.isArray(top.paths));
  assert.ok(Array.isArray(top.docs));
  assert.ok(Array.isArray(top.verify));
  assert.strictEqual(typeof top.firstFile, 'string');
  assert.strictEqual(typeof top.firstVerify, 'string');
  assert.ok(top.firstVerify.length > 0);
  assert.ok(Array.isArray(top.hits));
});

test('确定性排序 + 幂等：同输入逐字节一致', () => {
  const a = JSON.stringify(t.triageSymptom('port drift daemon', { map: FIXTURE }));
  const b = JSON.stringify(t.triageSymptom('port drift daemon', { map: FIXTURE }));
  assert.strictEqual(a, b);
});

test('limit 生效:默认 3，可调', () => {
  const r1 = t.triageSymptom('cli command model port version', { map: FIXTURE });
  assert.ok(r1.length <= 3);
  const r2 = t.triageSymptom('cli command model port version', { map: FIXTURE, limit: 1 });
  assert.ok(r2.length <= 1);
});

test('畸形输入绝不抛，恒返回数组', () => {
  const bads = [null, undefined, 42, '', {}, [], NaN, Symbol.iterator, () => {}];
  for (const b of bads) {
    let r;
    assert.doesNotThrow(() => { r = t.triageSymptom(b, { map: FIXTURE }); }, `throw on ${String(b)}`);
    assert.ok(Array.isArray(r), `not array for ${String(b)}`);
  }
});

test('畸形 opts / map 绝不抛', () => {
  assert.doesNotThrow(() => t.triageSymptom('cli', undefined));
  assert.doesNotThrow(() => t.triageSymptom('cli', { map: null }));
  assert.doesNotThrow(() => t.triageSymptom('cli', { map: 'nope' }));
  assert.doesNotThrow(() => t.triageSymptom('cli', { map: [null, 42, {}] }));
});

test('_normalizeArea 补空字段不抛', () => {
  const n = t._normalizeArea({});
  assert.strictEqual(n.id, '');
  assert.ok(Array.isArray(n.whenToUse) && Array.isArray(n.paths) && Array.isArray(n.verify));
  assert.doesNotThrow(() => t._normalizeArea(null));
});

test('SYMPTOM_HINTS 的 area 都是字符串且有 words 数组', () => {
  assert.ok(Array.isArray(t.SYMPTOM_HINTS) && t.SYMPTOM_HINTS.length > 0);
  for (const h of t.SYMPTOM_HINTS) {
    assert.strictEqual(typeof h.area, 'string');
    assert.ok(h.area.length > 0);
    assert.ok(Array.isArray(h.words) && h.words.length > 0);
  }
});

test('真实映射表可加载且分诊命中(集成)', () => {
  const map = t.loadMap();
  assert.ok(map.length >= 5, `真实映射表应有多个 area，实际 ${map.length}`);
  const r = t.triageSymptom('识图 404 vision adapter fallback', { map });
  assert.ok(r.length >= 1, '真实映射表下识图症状应命中');
  assert.strictEqual(r[0].id, 'gateway-adapters');
});

test('速查表 OPS-MAN-067 已落盘且与生成器输出一致(防手改漂移)', (ctx) => {
  const fs = require('node:fs');
  const { requireExtensionModule } = require('../lib/ext-run');
  const cli = requireExtensionModule('khy-diagnostics', { command: 'triage' });
  if (!cli) return ctx.skip('拓展 khy-diagnostics 未安装 —— 这份文档由它生成，没有生成器就没有可比对的基准（删目录即卸载）');
  assert.ok(fs.existsSync(cli.DOC_PATH), '速查表未生成，先跑 npm run maintenance:triage-doc');
  // 行尾先归一再比：这份文档是**被跟踪**的（git 里存 LF），而本仓 core.autocrlf=true
  // 会把它检出成 CRLF，生成器则始终吐 LF。逐字节比对在任何 Windows 检出上都必然失败，
  // 而这条断言要防的是「有人手改了内容」，不是行尾风格。
  const eol = (text) => text.replace(/\r\n/g, '\n');
  const disk = fs.readFileSync(cli.DOC_PATH, 'utf8');
  assert.strictEqual(
    eol(disk),
    eol(cli.buildDoc()),
    '落盘速查表与生成器输出不一致，请重跑 npm run maintenance:triage-doc'
  );
  // 每个子系统一节、含 triage 用法与红线
  const map = t.loadMap();
  const sections = (disk.match(/^### /gm) || []).length;
  assert.strictEqual(sections, map.length, `子系统节数应等于 area 数 ${map.length}，实际 ${sections}`);
  assert.ok(disk.includes('npm run maintainer:triage'), '缺 triage 用法');
  assert.ok(disk.includes('commit/push'), '缺红线');
});
