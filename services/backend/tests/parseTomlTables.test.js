'use strict';
/**
 * parseTomlTables â€?pins the tolerant TOML **subset** parser that lets khy reuse
 * Codex CLI's MCP servers (`~/.codex/config.toml` â†?`[mcp_servers.<name>]`),
 * the one ecosystem in the registry that is not JSON/JSON5. Zero-IO: text in,
 * object out, so the suite is deterministic. Covers: table headers, dotted
 * headers, table arrays, every supported value form, multi-line arrays/inline
 * tables, comment stripping, and fail-soft on junk (never throws, unsupported
 * lines skipped rather than losing the whole file).
 */
const parseTomlTables = require('../src/utils/parseTomlTables');

describe('Parse Toml Tables', () => {
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
      expect(out.model).toBe('gpt-5');
      assert.deepStrictEqual(out.mcp_servers.everything, {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
      });
      expect(out.mcp_servers.github.env).toEqual({ GITHUB_TOKEN: 't0ken' });
      expect(out.mcp_servers.github.startup_timeout_sec).toBe(20);
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
      expect(out.s.dq).toBe('double');
      expect(out.s.sq).toBe('single');
      expect(out.s.esc).toBe('a\nb');
      expect(out.s.int).toBe(42);
      expect(out.s.neg).toBe(-7);
      expect(out.s.float).toBe(1.5);
      expect(out.s.expo).toBe(2000);
      expect(out.s.yes).toBe(true);
      expect(out.s.no).toBe(false);
      expect(out.s.empty).toEqual([]);
      expect(out.s.nested).toEqual([['a'], ['b']]);
      expect(out.s.inline).toEqual({ a: 1, b: { c: 'd' } });
  });

  test('multi-line arrays and inline tables are joined before parsing', () => {
      const out = parseTomlTables(
        ['[m]', 'args = [', '  "one",', '  "two",', ']', 'env = {', '  A = "1",', '  B = "2"', '}'].join(
          '\n'
        )
      );
      expect(out.m.args).toEqual(['one', 'two']);
      expect(out.m.env).toEqual({ A: '1', B: '2' });
  });

  test('comments are stripped outside quotes, kept inside', () => {
      const out = parseTomlTables(
        ['# leading', '[c] # trailing on header', 'a = "x" # trailing', 'h = "a#b"'].join('\n')
      );
      expect(out.c.a).toBe('x');
      expect(out.c.h).toBe('a#b');
  });

  test('dotted headers nest; quoted segments keep dots/spaces', () => {
      const out = parseTomlTables(['[a.b.c]', 'x = 1', '[a."d.e"]', 'y = 2'].join('\n'));
      expect(out.a.b.c.x).toBe(1);
      expect(out.a['d.e'].y).toBe(2);
  });

  test('table arrays [[x]] append entries', () => {
      const out = parseTomlTables(['[[p]]', 'n = 1', '[[p]]', 'n = 2'].join('\n'));
      expect(out.p).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test('dotted keys inside a table nest under it', () => {
      const out = parseTomlTables(['[t]', 'a.b = "v"'].join('\n'));
      expect(out.t.a).toEqual({ b: 'v' });
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
      expect(out.u.ok).toBe('kept');
      expect(out.u.after).toBe('also kept');
  });

});

