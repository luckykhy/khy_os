'use strict';

/**
 * parseTomlTables — pins the tolerant TOML **subset** parser that lets khy reuse
 * Codex CLI's MCP servers (`~/.codex/config.toml` → `[mcp_servers.<name>]`),
 * the one ecosystem in the registry that is not JSON/JSON5. Zero-IO: text in,
 * object out, so the suite is deterministic. Covers: table headers, dotted
 * headers, table arrays, every supported value form, multi-line arrays/inline
 * tables, comment stripping, and fail-soft on junk (never throws, unsupported
 * lines skipped rather than losing the whole file).
 */

const assert = require('node:assert');
const { test } = require('node:test');

const parseTomlTables = require('../src/utils/parseTomlTables');

test('parses the real Codex mcp_servers shape', () => {
  const out = parseTomlTables(
    [
      '# Codex config',
      'model = "gpt-5"',
      '',
      '[mcp_servers.everything]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-everything"]',
      '',
      '[mcp_servers.github]',
      'command = "docker"',
      'args = ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"]',
      'env = { GITHUB_TOKEN = "t0ken" }',
      'startup_timeout_sec = 20',
    ].join('\n')
  );
  assert.strictEqual(out.model, 'gpt-5');
  assert.deepStrictEqual(out.mcp_servers.everything, {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
  });
  assert.deepStrictEqual(out.mcp_servers.github.env, { GITHUB_TOKEN: 't0ken' });
  assert.strictEqual(out.mcp_servers.github.startup_timeout_sec, 20);
});

test('value forms: strings, numbers, booleans, arrays, inline tables', () => {
  const out = parseTomlTables(
    [
      '[s]',
      'dq = "double"',
      "sq = 'single'",
      'esc = "a\\nb"',
      'int = 42',
      'neg = -7',
      'float = 1.5',
      'expo = 2e3',
      'yes = true',
      'no = false',
      'empty = []',
      'nested = [["a"], ["b"]]',
      'inline = { a = 1, b = { c = "d" } }',
    ].join('\n')
  );
  assert.strictEqual(out.s.dq, 'double');
  assert.strictEqual(out.s.sq, 'single');
  assert.strictEqual(out.s.esc, 'a\nb');
  assert.strictEqual(out.s.int, 42);
  assert.strictEqual(out.s.neg, -7);
  assert.strictEqual(out.s.float, 1.5);
  assert.strictEqual(out.s.expo, 2000);
  assert.strictEqual(out.s.yes, true);
  assert.strictEqual(out.s.no, false);
  assert.deepStrictEqual(out.s.empty, []);
  assert.deepStrictEqual(out.s.nested, [['a'], ['b']]);
  assert.deepStrictEqual(out.s.inline, { a: 1, b: { c: 'd' } });
});

test('multi-line arrays and inline tables are joined before parsing', () => {
  const out = parseTomlTables(
    ['[m]', 'args = [', '  "one",', '  "two",', ']', 'env = {', '  A = "1",', '  B = "2"', '}'].join(
      '\n'
    )
  );
  assert.deepStrictEqual(out.m.args, ['one', 'two']);
  assert.deepStrictEqual(out.m.env, { A: '1', B: '2' });
});

test('comments are stripped outside quotes, kept inside', () => {
  const out = parseTomlTables(
    ['# leading', '[c] # trailing on header', 'a = "x" # trailing', 'h = "a#b"'].join('\n')
  );
  assert.strictEqual(out.c.a, 'x');
  assert.strictEqual(out.c.h, 'a#b');
});

test('dotted headers nest; quoted segments keep dots/spaces', () => {
  const out = parseTomlTables(['[a.b.c]', 'x = 1', '[a."d.e"]', 'y = 2'].join('\n'));
  assert.strictEqual(out.a.b.c.x, 1);
  assert.strictEqual(out.a['d.e'].y, 2);
});

test('table arrays [[x]] append entries', () => {
  const out = parseTomlTables(['[[p]]', 'n = 1', '[[p]]', 'n = 2'].join('\n'));
  assert.deepStrictEqual(out.p, [{ n: 1 }, { n: 2 }]);
});

test('dotted keys inside a table nest under it', () => {
  const out = parseTomlTables(['[t]', 'a.b = "v"'].join('\n'));
  assert.deepStrictEqual(out.t.a, { b: 'v' });
});

test('unsupported lines are skipped, the rest of the file survives', () => {
  const out = parseTomlTables(
    [
      '[u]',
      'ok = "kept"',
      'multi = """triple',
      'quoted"""',
      'when = 1979-05-27T07:32:00Z',
      'after = "also kept"',
    ].join('\n')
  );
  assert.strictEqual(out.u.ok, 'kept');
  assert.strictEqual(out.u.after, 'also kept');
});

test('fail-soft: junk / empty / non-string never throws', () => {
  assert.strictEqual(parseTomlTables(''), null);
  assert.strictEqual(parseTomlTables(null), null);
  assert.strictEqual(parseTomlTables(undefined), null);
  assert.strictEqual(parseTomlTables(42), null);
  assert.strictEqual(parseTomlTables({}), null);
  // Unterminated structures / garbage: object returned, no throw.
  for (const junk of ['[', '[[', 'a = [1, 2', 'x = {y =', '===', '[a]\n= 1']) {
    const out = parseTomlTables(junk);
    assert.strictEqual(typeof out, 'object', `expected object for ${JSON.stringify(junk)}`);
  }
});

test('bad table header does not pollute the root', () => {
  const out = parseTomlTables(['[ ]', 'orphan = 1', '[good]', 'v = 2'].join('\n'));
  assert.strictEqual(out.orphan, undefined);
  assert.strictEqual(out.good.v, 2);
});
