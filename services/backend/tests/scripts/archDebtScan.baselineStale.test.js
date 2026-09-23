'use strict';

/**
 * archDebtScan 基线诚实性 — 两个「静默失真」缺陷的回归锁。
 *
 * 背景（2026-09-22 核查）：这套扫描器的棘轮语义曾以两个方向同时失真，
 * 而两个方向都**不报错、只是悄悄地判错**：
 *
 *   ① **基线悬空**：域迁移（`src/services/x.js` → `src/services/domain/<域>/…/x.js`）
 *      后基线未刷新 ⇒ 旧条目永不匹配（该文件被误判为「新增」），
 *      同时该文件的存量增长不再受棘轮约束。实测 38 条 layering 里 12 条悬空。
 *   ② **未跟踪漏扫**：`listChangedFiles()` 没有 `ls-files --others` ⇒ 新建的
 *      `??` 文件在体积门禁里完全不可见 —— 而这条规则拦的恰恰该是新增文件。
 *
 * 这两个缺陷是「工具本身不够诚实」，比它们想检测的代码缺陷危害更大：
 * 维护者会照着失真的读数归因。故各自锁一条断言，防止回归。
 * node:test。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const scan = require('../../scripts/archDebtScan');

// ── ① 基线悬空检测 ────────────────────────────────────────────────────────────

test('findStaleBaselineEntries: flags entries whose file no longer exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-stale-'));
  try {
    // 只造一个真实存在的文件；另一条指向不存在路径 = 悬空。
    fs.mkdirSync(path.join(tmp, 'src', 'real'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'real', 'exists.js'), '// ok\n');

    const baseline = {
      layering: [
        { file: 'src/real/exists.js', target: '../../cli/ai' },
        { file: 'src/ghost/moved-away.js', target: '../../cli/ai' },
      ],
      godFiles: [{ file: 'src/ghost/also-gone.js', loc: 3000 }],
      cycles: [],
    };
    const stale = scan.findStaleBaselineEntries(baseline, tmp);

    assert.strictEqual(stale.length, 2, 'exactly the two non-existent paths are stale');
    const files = stale.map((s) => s.file).sort();
    assert.deepStrictEqual(files, ['src/ghost/also-gone.js', 'src/ghost/moved-away.js']);
    for (const s of stale) {
      assert.ok(['layering', 'godFiles'].includes(s.kind), 'kind is a known dimension');
      assert.ok(typeof s.reason === 'string' && s.reason.length > 0);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findStaleBaselineEntries: an all-live baseline reports zero stale', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-stale-ok-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'live.js'), '// ok\n');
    const baseline = { layering: [{ file: 'src/live.js', target: 'x' }], godFiles: [], cycles: [] };
    assert.deepStrictEqual(scan.findStaleBaselineEntries(baseline, tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findStaleBaselineEntries: tolerates empty / malformed baselines', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-stale-empty-'));
  try {
    assert.deepStrictEqual(scan.findStaleBaselineEntries({}, tmp), []);
    assert.deepStrictEqual(
      scan.findStaleBaselineEntries({ layering: [null, {}, { file: '' }], godFiles: null }, tmp),
      [],
      'entries without a usable file path are skipped, not thrown on'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('formatStaleBaselineReport: all-clear vs warning wording', () => {
  assert.match(scan.formatStaleBaselineReport([]), /基线全部指向现存文件/);
  const text = scan.formatStaleBaselineReport([{ kind: 'layering', file: 'src/gone.js', reason: 'r' }]);
  assert.match(text, /悬空条目: 1 条/);
  assert.match(text, /src\/gone\.js/);
  assert.match(text, /update-baseline/, 'must point the maintainer at the fix');
});

test('main(--baseline-stale): read-only, exits 0', () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  let code;
  try {
    code = scan.main(['--baseline-stale']);
  } finally {
    process.stdout.write = orig;
  }
  assert.strictEqual(code, 0, 'staleness is a signal, never a blocking gate');
  assert.match(chunks.join(''), /基线悬空检测/);
});

test('main(--baseline-stale --json): machine-readable shape', () => {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  let code;
  try {
    code = scan.main(['--baseline-stale', '--json']);
  } finally {
    process.stdout.write = orig;
  }
  assert.strictEqual(code, 0);
  const parsed = JSON.parse(chunks.join(''));
  assert.ok(Array.isArray(parsed.baselineStale));
  assert.strictEqual(parsed.count, parsed.baselineStale.length);
});

// ── ② 未跟踪文件必须进入改动集 ────────────────────────────────────────────────

test('mergeUnique: order-preserving dedupe', () => {
  assert.deepStrictEqual(scan.mergeUnique(['b', 'a'], ['a', 'c']), ['b', 'a', 'c']);
  assert.deepStrictEqual(scan.mergeUnique([], ['x']), ['x']);
  assert.deepStrictEqual(scan.mergeUnique(['x'], []), ['x']);
});

test('listChangedFiles: includes untracked files, as repo-root-relative paths', () => {
  // 在一个一次性临时 git 仓库里验证取数契约，不污染本仓、不依赖本仓的脏工作区。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-changed-'));
  const backend = path.join(tmp, 'services', 'backend');
  try {
    fs.mkdirSync(path.join(backend, 'src'), { recursive: true });
    fs.writeFileSync(path.join(backend, 'src', 'tracked.js'), '// tracked\n');
    fs.writeFileSync(path.join(backend, 'src', 'brand-new.js'), '// untracked\n');

    const g = (args) => cp.execSync(`git ${args}`, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    g('init -q');
    g('config user.email t@t.t');
    g('config user.name t');
    g('add services/backend/src/tracked.js');
    g('commit -q -m init');

    // 制造一个已暂存的修改，确认「staged 分支」也会并入未跟踪文件。
    fs.writeFileSync(path.join(backend, 'src', 'tracked.js'), '// tracked changed\n');
    g('add services/backend/src/tracked.js');

    const list = listChangedFilesAt(backend);
    assert.ok(Array.isArray(list), 'must resolve, not return null, when git works');
    assert.ok(
      list.includes('services/backend/src/brand-new.js'),
      'untracked file must appear — this is the bug that let ?? files escape the gate'
    );
    assert.ok(
      list.includes('services/backend/src/tracked.js'),
      'staged modification must still appear'
    );
    for (const p of list) {
      assert.ok(
        p.startsWith('services/backend/'),
        `path must be repo-root-relative, got ${p} — mixing bases silently drops files`
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * 在**另一个 cwd** 上跑 listChangedFiles。
 * 模块把 BACKEND_ROOT 钉在自身位置，故这里复刻同一段取数逻辑并显式传入 cwd 与
 * 前缀，确保测试验证的是「契约」而不是本仓恰好干净的工作区。
 * （若将来该函数支持注入 root，可改为直接调用。）
 */
function listChangedFilesAt(backendRoot) {
  const git = 'git -c core.quotePath=false';
  const opts = { cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' };
  const run = (cmd) => {
    try {
      return cp.execSync(cmd, opts).trim();
    } catch {
      return '';
    }
  };
  const split = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean);
  const prefix = run(`${git} rev-parse --show-prefix`);
  const others = () => split(run(`${git} ls-files --others --exclude-standard`)).map((p) => prefix + p);
  const staged = run(`${git} diff --name-only --cached --diff-filter=ACMR`);
  if (staged) return Array.from(new Set([...split(staged), ...others()]));
  const head = run(`${git} diff --name-only --diff-filter=ACMR HEAD`);
  if (head) return Array.from(new Set([...split(head), ...others()]));
  const u = others();
  return u.length ? u : null;
}
