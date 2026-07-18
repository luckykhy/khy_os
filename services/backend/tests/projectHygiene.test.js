'use strict';

/**
 * Tests for the project-hygiene subsystem ([DESIGN-ARCH-054]): forbid god files
 * and forbid duplicate-functionality modules when khy authors a project.
 * Pure-unit where possible (injected listFiles/readFile), no disk for the core.
 */

const { assessGodFile, countLines } = require('../src/services/projectHygiene/godFile');
const { extractSymbols, symbolOverlap } = require('../src/services/projectHygiene/symbols');
const { findDuplicateModule, nameStem } = require('../src/services/projectHygiene/duplicateModule');
const hygiene = require('../src/services/projectHygiene');

// Keep env knobs deterministic regardless of the runner's environment.
const SAVED = {};
beforeEach(() => {
  for (const k of [
    'KHY_PROJECT_HYGIENE', 'KHY_PROJECT_GOD_FILE_LOC', 'KHY_ARCH_GOD_FILE_LOC',
    'KHY_PROJECT_DUP_SYMBOL_OVERLAP', 'KHY_PROJECT_DUP_CONTENT_JACCARD',
    'KHY_PROJECT_DUP_MIN_SYMBOLS',
  ]) { SAVED[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of Object.keys(SAVED)) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('godFile', () => {
  test('counts lines as split("\\n").length (archDebtScan parity)', () => {
    expect(countLines('a\nb\nc')).toBe(3);
    expect(countLines('')).toBe(0);
    expect(countLines('one line')).toBe(1);
  });

  test('under the ceiling → no violation', () => {
    const content = Array.from({ length: 100 }, () => 'x').join('\n');
    const r = assessGodFile({ path: 'a.js', content, threshold: 2500 });
    expect(r.violation).toBe(false);
    expect(r.assessable).toBe(true);
  });

  test('over the ceiling → violation', () => {
    const content = Array.from({ length: 2600 }, () => 'x').join('\n');
    const r = assessGodFile({ path: 'a.js', content, threshold: 2500 });
    expect(r.violation).toBe(true);
    expect(r.loc).toBe(2600);
    expect(r.threshold).toBe(2500);
  });

  test('non-code / data / lockfile extensions are not assessed', () => {
    const huge = Array.from({ length: 9999 }, () => 'x').join('\n');
    expect(assessGodFile({ path: 'data.json', content: huge }).assessable).toBe(false);
    expect(assessGodFile({ path: 'data.json', content: huge }).violation).toBe(false);
    expect(assessGodFile({ path: 'package-lock.json', content: huge }).assessable).toBe(false);
    expect(assessGodFile({ path: 'app.min.js', content: huge }).assessable).toBe(false);
  });

  test('threshold defaults from env knobs (project overrides arch)', () => {
    process.env.KHY_ARCH_GOD_FILE_LOC = '50';
    const content = Array.from({ length: 60 }, () => 'x').join('\n');
    expect(assessGodFile({ path: 'a.js', content }).violation).toBe(true);
    process.env.KHY_PROJECT_GOD_FILE_LOC = '100'; // project knob wins
    expect(assessGodFile({ path: 'a.js', content }).violation).toBe(false);
  });
});

describe('symbols', () => {
  test('extracts functions, classes, top-level vars, and exports', () => {
    // Declarations must sit at module scope (column 0) — the extractor
    // deliberately ignores indented (nested) const/var so symbol overlap is not
    // polluted by locals inside functions.
    const src = [
      'function alpha() {}',
      'const beta = () => 1;',
      'class Gamma {}',
      'exports.delta = 1;',
      'module.exports = { alpha, epsilon: beta };',
    ].join('\n');
    const syms = extractSymbols(src, 'm.js');
    expect(syms.has('alpha')).toBe(true);
    expect(syms.has('beta')).toBe(true);
    expect(syms.has('Gamma')).toBe(true);
    expect(syms.has('delta')).toBe(true);
    expect(syms.has('epsilon')).toBe(true);
  });

  test('non-code extension yields an empty set', () => {
    expect(extractSymbols('function x(){}', 'a.json').size).toBe(0);
  });

  test('overlap ratio is |new ∩ existing| / |new|', () => {
    const a = new Set(['x', 'y', 'z', 'w']);
    const b = new Set(['x', 'y', 'q']);
    expect(symbolOverlap(a, b).ratio).toBeCloseTo(0.5, 5); // {x,y} / 4
  });
});

describe('duplicateModule.nameStem', () => {
  test('reduces version/copy variants to a shared stem', () => {
    expect(nameStem('userService.js')).toBe(nameStem('user-service.js'));
    expect(nameStem('userService2.js')).toBe(nameStem('userService.js'));
    expect(nameStem('auth_v2.ts')).toBe(nameStem('auth.ts'));
    expect(nameStem('parser copy.js')).toBe(nameStem('parser.js'));
  });
});

describe('findDuplicateModule', () => {
  const newFile = {
    path: 'src/userService2.js',
    content: 'function getUser(){}\nfunction setUser(){}\nfunction delUser(){}\nmodule.exports={getUser,setUser,delUser};',
  };

  test('name collision (renamed copy) is flagged decisively', () => {
    const r = findDuplicateModule({
      ...newFile,
      siblings: [{ path: 'src/userService.js', content: 'function whatever(){}' }],
    });
    expect(r.duplicate).toBe(true);
    expect(r.reason).toBe('name');
    expect(r.existingPath).toBe('src/userService.js');
  });

  test('high exported-symbol overlap is flagged', () => {
    const r = findDuplicateModule({
      path: 'src/accounts.js',
      content: 'function getUser(){}\nfunction setUser(){}\nfunction delUser(){}\nmodule.exports={getUser,setUser,delUser};',
      siblings: [{
        path: 'src/users.js',
        content: 'function getUser(){return 1;}\nfunction setUser(){return 2;}\nfunction delUser(){return 3;}\nmodule.exports={getUser,setUser,delUser};',
      }],
    });
    expect(r.duplicate).toBe(true);
    expect(['symbols', 'content']).toContain(r.reason);
    expect(r.existingPath).toBe('src/users.js');
  });

  test('unrelated file is NOT flagged', () => {
    const r = findDuplicateModule({
      path: 'src/logger.js',
      content: 'function log(){}\nfunction warn(){}\nfunction error(){}\nmodule.exports={log,warn,error};',
      siblings: [{ path: 'src/math.js', content: 'function add(){}\nfunction sub(){}\nfunction mul(){}\nmodule.exports={add,sub,mul};' }],
    });
    expect(r.duplicate).toBe(false);
  });

  test('never matches a file against itself', () => {
    const r = findDuplicateModule({
      path: 'src/users.js',
      content: newFile.content,
      siblings: [{ path: 'src/users.js', content: newFile.content }],
    });
    expect(r.duplicate).toBe(false);
  });
});

describe('assessWrite facade', () => {
  const path = require('path');
  // The facade resolves each listed sibling to an absolute path before calling
  // readFile, so the injected reader must match on the resolved path.
  const inject = (siblings) => ({
    listFiles: () => ({ files: siblings.map(s => s.path), capped: false }),
    readFile: (p) => {
      const hit = siblings.find(s => path.resolve(s.path) === path.resolve(p));
      return hit ? hit.content : null;
    },
  });

  test('clean new file → ok', () => {
    const r = hygiene.assessWrite({
      path: 'src/brandNew.js',
      content: 'function unique(){}\nmodule.exports={unique};',
      isNew: true,
      ...inject([{ path: 'src/other.js', content: 'function zzz(){}' }]),
    });
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  test('god file → violation regardless of new/existing', () => {
    const content = Array.from({ length: 30 }, () => 'x').join('\n');
    process.env.KHY_PROJECT_GOD_FILE_LOC = '10';
    const r = hygiene.assessWrite({ path: 'src/big.js', content, isNew: false, ...inject([]) });
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.type === 'god-file')).toBe(true);
  });

  test('duplicate module on NEW file → violation', () => {
    const r = hygiene.assessWrite({
      path: 'src/userService2.js',
      content: 'function getUser(){}\nmodule.exports={getUser};',
      isNew: true,
      ...inject([{ path: 'src/userService.js', content: 'function getUser(){}' }]),
    });
    expect(r.ok).toBe(false);
    const dup = r.violations.find(v => v.type === 'duplicate-module');
    expect(dup).toBeDefined();
    expect(dup.existingPath).toBe('src/userService.js');
  });

  test('duplicate check does NOT run when overwriting an existing file (isNew=false)', () => {
    const r = hygiene.assessWrite({
      path: 'src/userService2.js',
      content: 'function getUser(){}\nmodule.exports={getUser};',
      isNew: false,
      ...inject([{ path: 'src/userService.js', content: 'function getUser(){}' }]),
    });
    expect(r.violations.some(v => v.type === 'duplicate-module')).toBe(false);
  });

  test('kill-switch KHY_PROJECT_HYGIENE=off short-circuits to ok', () => {
    process.env.KHY_PROJECT_HYGIENE = 'off';
    const content = Array.from({ length: 9999 }, () => 'x').join('\n');
    const r = hygiene.assessWrite({ path: 'src/huge.js', content, isNew: true, ...inject([]) });
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  test('missing/invalid input fails open (never throws)', () => {
    expect(hygiene.assessWrite({}).ok).toBe(true);
    expect(hygiene.assessWrite({ path: 'a.js' }).ok).toBe(true); // no content
  });
});

describe('projectHygieneGuard (toolGuards integration)', () => {
  const { projectHygieneGuard } = require('../src/services/toolGuards');

  test('allows a small clean write', () => {
    const r = projectHygieneGuard({
      toolName: 'write_file',
      params: { file_path: 'src/tiny.js', content: 'const a=1;\nmodule.exports={a};' },
    });
    expect(r.action).toBe('allow');
  });

  test('blocks (approvable) a god-file write', () => {
    process.env.KHY_PROJECT_GOD_FILE_LOC = '20';
    const content = Array.from({ length: 50 }, () => 'x').join('\n');
    const r = projectHygieneGuard({
      toolName: 'write_file',
      params: { file_path: 'src/godfile.js', content },
    });
    expect(r.action).toBe('block');
    expect(r.approvable).toBe(true);
    expect(r.source).toBe('ProjectHygieneGuard');
    expect(r.reason).toMatch(/上帝文件/);
  });

  test('allows when params lack content (e.g. a non-write call)', () => {
    expect(projectHygieneGuard({ toolName: 'write_file', params: {} }).action).toBe('allow');
  });
});
