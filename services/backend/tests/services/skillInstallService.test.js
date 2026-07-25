'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const installer = require('../../src/services/skillInstallService');

// 每个测试用独立的 KHY_DATA_HOME,避免污染真实 ~/.khy/skills。
function _withDataHome(fn) {
  const prev = process.env.KHY_DATA_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-data-'));
  process.env.KHY_DATA_HOME = home;
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (prev === undefined) delete process.env.KHY_DATA_HOME;
      else process.env.KHY_DATA_HOME = prev;
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    });
}

// 用一个「假克隆」把预置的 fixture 目录拷进克隆根,模拟 git clone(离线)。
function _fakeCloneFrom(fixtureDir) {
  return (url, dest, ref) => {
    fs.mkdirSync(dest, { recursive: true });
    _copyTree(fixtureDir, dest);
  };
}

function _copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) _copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function _mkFixture(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fix-'));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

// ── 门控关 → 拒绝 ─────────────────────────────────────────────────────────────
test('addFromSource: gated off → throws not-enabled', async () => {
  await assert.rejects(
    () => installer.addFromSource('a/b', { env: { KHY_SKILL_ADD: 'off' }, _clone: () => {} }),
    /未启用|KHY_SKILL_ADD/,
  );
});

// ── 根即 skill(单-skill 仓库)via injected clone ──────────────────────────────
test('addFromSource: root-level SKILL.md installs to <dataHome>/skills/<name>', async () => {
  const fix = _mkFixture({
    'SKILL.md': '---\nname: my-root-skill\ndescription: a root skill\n---\nBody here.\n',
  });
  await _withDataHome(async () => {
    const res = await installer.addFromSource('someone/my-root-skill', {
      _clone: _fakeCloneFrom(fix),
    });
    assert.strictEqual(res.name, 'my-root-skill');
    assert.ok(fs.existsSync(path.join(res.dest, 'SKILL.md')));
    assert.strictEqual(res.source, 'https://github.com/someone/my-root-skill.git');
  });
  fs.rmSync(fix, { recursive: true, force: true });
});

// ── --skill 指定子目录 ────────────────────────────────────────────────────────
test('addFromSource: --skill picks a subdir skill', async () => {
  const fix = _mkFixture({
    'README.md': 'top-level repo\n',
    'doc-coauthoring/SKILL.md': '---\nname: doc-coauthoring\ndescription: co-author docs\n---\nBody.\n',
    'find-skills/manifest.json': JSON.stringify({ name: 'find-skills', description: 'find skills' }),
  });
  await _withDataHome(async () => {
    const res = await installer.addFromSource('anthropics/skills', {
      skill: 'doc-coauthoring',
      _clone: _fakeCloneFrom(fix),
    });
    assert.strictEqual(res.name, 'doc-coauthoring');
    assert.strictEqual(res.subdir, 'doc-coauthoring');
    assert.ok(fs.existsSync(path.join(res.dest, 'SKILL.md')));
  });
  fs.rmSync(fix, { recursive: true, force: true });
});

// ── 多 skill 且未指定 → 提示需 --skill ────────────────────────────────────────
test('addFromSource: multiple skills under container without --skill → asks for --skill', async () => {
  const fix = _mkFixture({
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: a\n---\nx\n',
    'skills/beta/SKILL.md': '---\nname: beta\ndescription: b\n---\ny\n',
  });
  await _withDataHome(async () => {
    await assert.rejects(
      () => installer.addFromSource('x/y', { _clone: _fakeCloneFrom(fix) }),
      /多个 skill|--skill/,
    );
  });
  fs.rmSync(fix, { recursive: true, force: true });
});

// ── 无 skill 标记 → 明确报错 ──────────────────────────────────────────────────
test('addFromSource: no SKILL.md/manifest anywhere → clear error', async () => {
  const fix = _mkFixture({ 'README.md': 'nothing here\n' });
  await _withDataHome(async () => {
    await assert.rejects(
      () => installer.addFromSource('x/y', { _clone: _fakeCloneFrom(fix) }),
      /没找到 SKILL\.md|manifest/,
    );
  });
  fs.rmSync(fix, { recursive: true, force: true });
});

// ── 临时目录被清理 ────────────────────────────────────────────────────────────
test('addFromSource: cleans up its temp clone dir', async () => {
  const fix = _mkFixture({
    'SKILL.md': '---\nname: cleanup-skill\ndescription: d\n---\nb\n',
  });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-tmproot-'));
  await _withDataHome(async () => {
    await installer.addFromSource('x/cleanup-skill', {
      _clone: _fakeCloneFrom(fix),
      _tmpRoot: tmpRoot,
    });
    const leftovers = fs.readdirSync(tmpRoot).filter((n) => n.startsWith('khy-skill-'));
    assert.strictEqual(leftovers.length, 0, `expected no leftover clone dirs, found: ${leftovers}`);
  });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(fix, { recursive: true, force: true });
});

// ── _locateSkillDir 越界保护 ──────────────────────────────────────────────────
test('_isSkillDir: detects SKILL.md / manifest.json', () => {
  const d = _mkFixture({ 'SKILL.md': 'x' });
  assert.strictEqual(installer._isSkillDir(d), true);
  const d2 = _mkFixture({ 'manifest.json': '{}' });
  assert.strictEqual(installer._isSkillDir(d2), true);
  const d3 = _mkFixture({ 'README.md': 'x' });
  assert.strictEqual(installer._isSkillDir(d3), false);
  for (const x of [d, d2, d3]) fs.rmSync(x, { recursive: true, force: true });
});

// ── 真·离线 E2E:用本地 file:// git 仓库(不触网)走默认 _defaultClone ──────────
test('addFromSource: real local file:// git clone (offline E2E)', async () => {
  let gitOk = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitOk = false; }
  if (!gitOk) return; // 无 git → 跳过

  // 建一个本地 git 仓库当「远端」。
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gitrepo-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env });
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore', env });
  g(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'SKILL.md'),
    '---\nname: offline-e2e-skill\ndescription: proves offline clone works\n---\nHello.\n', 'utf-8');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);

  const fileUrl = `file://${repo}`;
  await _withDataHome(async () => {
    // 直接把 file:// url 塞进 spec:用 https 形态解析器不认 file://,故走注入 clone 调 _defaultClone。
    const res = await installer.addFromSource('local/offline-e2e-skill', {
      _clone: (url, dest, ref) => installer._defaultClone(fileUrl, dest, ref),
    });
    assert.strictEqual(res.name, 'offline-e2e-skill');
    assert.ok(fs.existsSync(path.join(res.dest, 'SKILL.md')));
    const body = fs.readFileSync(path.join(res.dest, 'SKILL.md'), 'utf-8');
    assert.match(body, /offline-e2e-skill/);
  });
  fs.rmSync(repo, { recursive: true, force: true });
});
