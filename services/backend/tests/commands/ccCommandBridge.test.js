'use strict';

/**
 * ccCommandBridge / ccUserCommands — Claude Code custom slash-command bridge.
 *
 * Goal (「khy 缺少生态,希望能用其他开发者做的生态扩展 …工具市场等」):
 *   Community slash-command packs ship as `.claude/commands/*.md` (CC format).
 *   khy read only its own ~/.khy/skills and never consumed CC command packs.
 *   This bridge feeds CC's on-disk command roots into khy's slash-command
 *   surface — mirroring the proven ccSkillBridge / ccAgentBridge pattern.
 *
 * Guard invariants:
 *   ① gate KHY_CC_COMMAND_BRIDGE default ON; {0,false,off,no} → OFF (byte-revert)
 *   ② search dirs point at `.claude/commands` (project before user)
 *   ③ leaf never throws on bad input → []
 *   ④ E2E: a real temp `.md` command file is discovered with correct cmd/desc
 *   ⑤ gate OFF → listCcCommands returns [] (byte-revert)
 *   ⑥ frontmatter description/argument-hint parsed; body stripped of frontmatter
 *   ⑦ $ARGUMENTS / $1..$9 substitution honored; no-placeholder append fallback
 *   ⑧ subdir namespacing → /ns:name (CC semantics)
 *   ⑨ LIVE wiring: router.js calls registerCcCommands; commandRegistry preserves
 *      _commandFile so REPL/TUI dispatch can find the command body
 *
 * node:test (jest via rtk proxy reports Exec format error and is unavailable).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bridge = require('../../src/commands/ccCommandBridge');
const ccCmds = require('../../src/cli/repl/ccUserCommands');

const BACKEND_ROOT = path.resolve(__dirname, '../../');

// ── ① gate default ON; falsy words → OFF ──────────────────────────────────
test('KHY_CC_COMMAND_BRIDGE defaults ON and reverts on falsy words', () => {
  assert.strictEqual(bridge.isCcCommandBridgeEnabled({}), true);
  assert.strictEqual(bridge.isCcCommandBridgeEnabled({ KHY_CC_COMMAND_BRIDGE: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' False ']) {
    assert.strictEqual(
      bridge.isCcCommandBridgeEnabled({ KHY_CC_COMMAND_BRIDGE: off }), false,
      `'${off}' should disable the bridge`);
  }
  // Non-falsy → stays ON.
  assert.strictEqual(bridge.isCcCommandBridgeEnabled({ KHY_CC_COMMAND_BRIDGE: '1' }), true);
  assert.strictEqual(bridge.isCcCommandBridgeEnabled({ KHY_CC_COMMAND_BRIDGE: 'yes' }), true);
});

// ── ② search dirs: project before user, both under .claude/commands ────────
test('ccCommandSearchDirs lists project before user under .claude/commands', () => {
  const dirs = bridge.ccCommandSearchDirs({ homedir: '/home/u', projectDir: '/proj' });
  assert.deepStrictEqual(dirs, [
    { dir: path.join('/proj', '.claude', 'commands'), source: 'cc-project' },
    { dir: path.join('/home/u', '.claude', 'commands'), source: 'cc-user' },
  ]);
  // homedir only
  const userOnly = bridge.ccCommandSearchDirs({ homedir: '/home/u' });
  assert.strictEqual(userOnly.length, 1);
  assert.strictEqual(userOnly[0].source, 'cc-user');
});

// ── ③ leaf never throws on bad input ──────────────────────────────────────
test('ccCommandSearchDirs is fail-soft on bad input', () => {
  assert.deepStrictEqual(bridge.ccCommandSearchDirs(), []);
  assert.deepStrictEqual(bridge.ccCommandSearchDirs({}), []);
  assert.deepStrictEqual(bridge.ccCommandSearchDirs({ homedir: null, projectDir: null }), []);
});

// ── ④/⑥/⑧ E2E discovery from a real temp project ──────────────────────────
test('listCcCommands discovers .claude/commands/*.md with frontmatter + namespacing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cc-cmd-'));
  try {
    const cmdDir = path.join(tmp, '.claude', 'commands');
    fs.mkdirSync(path.join(cmdDir, 'git'), { recursive: true });
    // root-level command with frontmatter
    fs.writeFileSync(path.join(cmdDir, 'review.md'),
      '---\ndescription: Review the current diff\nargument-hint: "[file]"\n---\nReview this code: $ARGUMENTS\n');
    // namespaced command (subdir → /git:commit)
    fs.writeFileSync(path.join(cmdDir, 'git', 'commit.md'),
      '---\ndescription: Write a commit message\n---\nDraft a commit.\n');
    // non-md file ignored
    fs.writeFileSync(path.join(cmdDir, 'README.txt'), 'not a command');

    const home = path.join(tmp, 'home-empty');
    const list = ccCmds.listCcCommands({ env: {}, cwd: tmp, home });
    const byCmd = Object.fromEntries(list.map((c) => [c.cmd, c]));

    assert.ok(byCmd['/review'], '/review command should be discovered');
    assert.strictEqual(byCmd['/review'].desc, 'Review the current diff');
    assert.strictEqual(byCmd['/review']._argumentHint, '[file]');
    assert.strictEqual(byCmd['/review'].source, 'cc-command');
    assert.ok(byCmd['/review']._commandFile.endsWith(path.join('commands', 'review.md')));

    assert.ok(byCmd['/git:commit'], 'namespaced /git:commit should be discovered');
    assert.strictEqual(byCmd['/git:commit'].desc, 'Write a commit message');

    assert.ok(!byCmd['/README'], 'non-md files must be ignored');

    // ⑥ body stripped of frontmatter
    const body = ccCmds.loadCcCommandBody(byCmd['/review']._commandFile);
    assert.strictEqual(body, 'Review this code: $ARGUMENTS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── ⑤ gate OFF → [] (byte-revert) ─────────────────────────────────────────
test('gate OFF → listCcCommands returns []', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cc-cmd-off-'));
  try {
    const cmdDir = path.join(tmp, '.claude', 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'x.md'), '---\ndescription: X\n---\nDo X.\n');
    const off = ccCmds.listCcCommands({ env: { KHY_CC_COMMAND_BRIDGE: 'off' }, cwd: tmp, home: tmp });
    assert.deepStrictEqual(off, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── ⑦ $ARGUMENTS / $1..$9 substitution + append fallback ──────────────────
test('renderCcCommandBody honors $ARGUMENTS, positional, and no-placeholder append', () => {
  assert.strictEqual(
    ccCmds.renderCcCommandBody('Review: $ARGUMENTS', 'a.js b.js'),
    'Review: a.js b.js');
  assert.strictEqual(
    ccCmds.renderCcCommandBody('First=$1 Second=$2', 'foo bar'),
    'First=foo Second=bar');
  // missing positional → empty
  assert.strictEqual(
    ccCmds.renderCcCommandBody('Only=$1 Missing=$3', 'x'),
    'Only=x Missing=');
  // no placeholder + args → appended (skill-parity)
  assert.strictEqual(
    ccCmds.renderCcCommandBody('Static prompt.', 'extra'),
    'Static prompt.\n\nextra');
  // no placeholder + no args → unchanged
  assert.strictEqual(
    ccCmds.renderCcCommandBody('Static prompt.', ''),
    'Static prompt.');
});

// ── ⑦b _cmdFromRelPath pure mapping ───────────────────────────────────────
test('_cmdFromRelPath maps rel paths to CC-namespaced slash commands', () => {
  assert.strictEqual(ccCmds._cmdFromRelPath('review.md'), '/review');
  assert.strictEqual(ccCmds._cmdFromRelPath('git/commit.md'), '/git:commit');
  assert.strictEqual(ccCmds._cmdFromRelPath(''), '');
});

// ── ⑨ LIVE wiring: router registers CC commands; registry preserves _commandFile ──
test('router.js calls registerCcCommands after registerUserSkills', () => {
  const src = fs.readFileSync(path.join(BACKEND_ROOT, 'src/cli/router.js'), 'utf8');
  assert.ok(/cmdReg\.registerCcCommands\(\)/.test(src),
    'router.js must call cmdReg.registerCcCommands() (wiring drift)');
});

test('commandRegistry preserves _commandFile for dispatch and exports registerCcCommands', () => {
  const reg = require('../../src/cli/commandRegistry');
  assert.strictEqual(typeof reg.registerCcCommands, 'function',
    'registerCcCommands must be exported');
  reg.register({
    cmd: '/__cc_test__', label: 'x', desc: 'd',
    _commandFile: '/abs/path/x.md', _commandName: '__cc_test__', _argumentHint: '[a]',
  }, 'user');
  const found = reg.getAll().find((c) => c.cmd === '/__cc_test__');
  assert.ok(found, 'registered CC command should be retrievable');
  assert.strictEqual(found._commandFile, '/abs/path/x.md',
    '_commandFile must survive register() field whitelist (dispatch depends on it)');
  reg.unregister('/__cc_test__');
});

// ── determinism ───────────────────────────────────────────────────────────
test('ccCommandSearchDirs is deterministic for given input', () => {
  const a = bridge.ccCommandSearchDirs({ homedir: '/h', projectDir: '/p' });
  const b = bridge.ccCommandSearchDirs({ homedir: '/h', projectDir: '/p' });
  assert.deepStrictEqual(a, b);
});
