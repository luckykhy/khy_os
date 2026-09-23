'use strict';

/**
 * 根目录垃圾守卫 —— root-junk 规则的验收标准。
 *
 * 现场事故：仓库根陆续落进 `1`、`console.log(r))`、`console.log((11441+i)+'`、
 * `tmp-b9-src.js`、`tmp-batch-next.out`、`_flagcheck.txt`、`_gitst.txt`、`.coverage`
 * 以及 20+ 个 `tmp-*.txt` 探测残留，还有一个 shell 事故目录 `-p/`。
 *
 * 既有的 root-whitelist 规则**只扫 .md/.txt 且只扫文件**（见该文件第 125 行注释），
 * 所以上述垃圾全部在它视野之外——门禁一路绿着放行。历史 commit dafef34c 曾手工
 * 清过一批同类垃圾，说明这是复发问题，必须由门禁兜住而不是靠人记得清。
 *
 * 本条规则的设计取向是**高精度签名**：只抓「明显是临时/事故产物」的名字，
 * 不去枚举合法根文件（那需要一个封闭白名单，属方案文档 Phase 2）。
 * 因此本测试同时锁两件事：抓得住垃圾，且不误伤合法根文件/目录。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');
const layout = require(path.join(ROOT, 'scripts/ci/check-repo-layout.js'));
const { isRootJunkName, findRootJunkEntries } = layout;

describe('check-repo-layout: root-junk signature', () => {
  test('catches every junk name actually observed at the repo root', () => {
    const observed = [
      '1',
      'console.log(r))',
      "console.log((11441+i)+'",
      'tmp-b9-src.js',
      'tmp-batch-next.out',
      'tmp-bs-probe.txt',
      'tmp-nd-test.txt',
      '_flagcheck.txt',
      '_gitst.txt',
      '.tmp_startup_lines.txt',
    ];
    const missed = observed.filter((name) => !isRootJunkName(name));
    expect(missed).toEqual([]);
  });

  test('flags shell-accident and tmp-* directories, but not real top-level dirs', () => {
    const entries = [
      { name: '-p', isDirectory: true },
      { name: 'tmp-batch-out', isDirectory: true },
      { name: 'apps', isDirectory: true },
      // 未登记 ≠ 垃圾：这两类由 layer-registry 规则负责，本规则不得误伤。
      { name: '_产物', isDirectory: true },
      { name: '对齐', isDirectory: true },
    ];
    expect(findRootJunkEntries(entries)).toEqual(['-p', 'tmp-batch-out']);
  });

  test('does not flag legitimate root files', () => {
    const legit = [
      'README.md',
      'AGENTS.md',
      'CLAUDE.md',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'LICENSE',
      'Dockerfile',
      'Makefile',
      'package.json',
      'MANIFEST.in',
      'pnpm-workspace.yaml',
      'install-khy.ps1',
      'khy.bat',
      'khy.sh',
      'khy-cli.bat',
      'fly.staging.toml',
      '.gitignore',
      '.editorconfig',
      '.npmrc',
      '.clinerules',
      '.windsurfrules',
    ];
    const wronglyFlagged = legit.filter((name) => isRootJunkName(name));
    expect(wronglyFlagged).toEqual([]);
  });

  test('does not flag legitimate root directories', () => {
    const dirs = [
      'apps',
      'docs',
      'services',
      'platform',
      'software',
      'extensions',
      'tools',
      'scripts',
      'tests',
      'deploy',
      'lib',
      'patches',
      'node_modules',
      '.git',
      '.github',
      '.khy',
      '_产物',
      '对齐',
    ].map((name) => ({ name, isDirectory: true }));
    expect(findRootJunkEntries(dirs)).toEqual([]);
  });

  test('never throws on garbage input', () => {
    expect(isRootJunkName(null)).toBe(false);
    expect(isRootJunkName(undefined)).toBe(false);
    expect(isRootJunkName('')).toBe(false);
    expect(findRootJunkEntries(null)).toEqual([]);
    expect(findRootJunkEntries('not-an-array')).toEqual([]);
    expect(findRootJunkEntries([null, 42, {}, { name: 7 }])).toEqual([]);
  });

  test('the rule is registered so --list=root-junk works', () => {
    // 规则必须登记进 ALL_FINDING_IDS，否则 --list/--promote 会 exit(2)。
    const src = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-repo-layout.js'), 'utf8');
    expect(src).toContain("'root-junk'");
  });
});
