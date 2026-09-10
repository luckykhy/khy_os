'use strict';
/**
 * skillSourceDistiller.test.js �?pure-leaf contract lock for the `/learn` source
 * distiller (Hermes v0.18.0 `/learn` reference, adapted to Khy-OS's deterministic
 * engine model).
 *
 * Locks the HARDLINE guarantees:
 *   - description clamped to <=60 chars, ends with a period, marketing words stripped;
 *   - name lowercase-hyphenated <=64 (dir basename / url host+path);
 *   - commands + headings extracted VERBATIM (never invented);
 *   - deterministic (same input �?byte-identical output);
 *   - never throws on null / garbage / empty;
 *   - empty documents �?{ ok:false }.
 */
const L = require('../../../src/services/domain/skills/skills/skillSourceDistiller.js');
const DOC = {
  name: 'README.md',
  text: [
    '# Arxiv Search',
    '',
    'Search papers by keyword.',
    '',
    '## When to Use',
    '- find academic papers',
    '',
    '## Quick Reference',
    '```bash',
    '$ arxiv-search --q neural',
    'npm run build',
    '# a comment that must be skipped',
    '```',
  ].join('\n'),
};

describe('Skill Source Distiller', () => {
  test('description: <=60 chars, ends with period, marketing words stripped', () => {
      const d = L.clampDescription(
        'A powerful comprehensive seamless advanced robust tool for searching arxiv papers by keyword and author quickly'
      );
      expect(d.length <= 60).toBeTruthy();
      expect(d.endsWith('.').toBeTruthy());
      expect(!/powerful|comprehensive|seamless|advanced|robust/i.test(d)).toBeTruthy();
  });

  test('description: empty / null �?safe default', () => {
      expect(L.clampDescription('')).toBe('Learned skill from source.');
      expect(L.clampDescription(null)).toBe('Learned skill from source.');
  });

  test('name: directory basename �?lowercase-hyphenated, extension dropped', () => {
      expect(L.deriveSkillName('/tmp/foo/My_Cool Tool/', 'directory')).toBe('my-cool-tool');
      expect(L.deriveSkillName('/a/b/parser.js', 'directory')).toBe('parser');
  });

  test('name: url �?hostname + last path segment', () => {
      expect(L.deriveSkillName('https://www.example.com/docs/auth-flow?x=1', 'url')).toBe('example-auth-flow');
      expect(L.deriveSkillName('http://api.site.io/', 'url')).toBe('api');
  });

  test('name: empty / garbage �?learned-skill fallback', () => {
      expect(L.deriveSkillName('', 'directory')).toBe('learned-skill');
      expect(L.deriveSkillName('////', 'directory')).toBe('learned-skill');
      expect(L.deriveSkillName(null, 'url')).toBe('learned-skill');
  });

  test('commands: extracted verbatim, prompt stripped, comments skipped, deduped', () => {
      const cmds = L.extractCommands(DOC.text);
      expect(cmds).toEqual(['arxiv-search --q neural', 'npm run build']);
      expect(!cmds.some((c) => c).toContain('comment'), 'comment line skipped');
  });

  test('headings: extracted verbatim, deduped, order preserved', () => {
      const hs = L.extractHeadings(DOC.text);
      expect(hs).toEqual(['Arxiv Search', 'When to Use', 'Quick Reference']);
  });

  test('distill: happy path shape + verbatim content + no invention', () => {
      const r = L.distillSkillFromSources({ sourceType: 'directory', sourceRef: '/x/arxiv', documents: [DOC] });
      expect(r.ok).toBe(true);
      expect(r.name).toBe('arxiv');
      expect(r.description.length <= 60 && r.description.endsWith('.').toBeTruthy());
      expect(r.category).toBe('reference');
      expect(r.commands).toEqual(['arxiv-search --q neural', 'npm run build']);
      expect(r.sources).toEqual(['README.md']);
      // Body only contains verbatim commands �?nothing invented.
      expect(r.body).toContain('arxiv-search --q neural');
      expect(!/invent/i.test(r.commands.join(' ').toBeTruthy()));
  });

  test('distill: deterministic �?same input �?byte-identical output', () => {
      const input = { sourceType: 'directory', sourceRef: '/x/arxiv', documents: [DOC] };
      const a = L.distillSkillFromSources(input);
      const b = L.distillSkillFromSources(input);
      expect(a).toEqual(b);
      expect(a.body).toBe(b.body);
  });

  test('distill: empty docs / null / garbage �?ok:false, never throws', () => {
      expect(L.distillSkillFromSources({ documents: [] }).ok).toBe(false);
      expect(L.distillSkillFromSources(null).ok).toBe(false);
      expect(L.distillSkillFromSources({ documents: [{ text: '   ' }] }).ok).toBe(false);
      expect(() => L.distillSkillFromSources({ documents: [{ text: 123 }] }).not.toThrow());
  });

  test('distill: source with no headings/commands �?ok with warning', () => {
      const r = L.distillSkillFromSources({
        sourceType: 'url', sourceRef: 'https://x.io/notes', documents: [{ name: 'notes', text: 'just some prose here' }],
      });
      expect(r.ok).toBe(true);
      expect(r.warnings.length >= 1).toBeTruthy();
  });

  test('MAX_DESCRIPTION_CHARS constant is 60', () => {
      expect(L.MAX_DESCRIPTION_CHARS).toBe(60);
  });

});

