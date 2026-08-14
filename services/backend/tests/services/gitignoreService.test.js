'use strict';

/**
 * gitignoreService.test.js — 薄壳(IO):.gitignore 读写 + 探栈的确定性测试。
 *
 * 隔离:临时 cwd(每个用例独立 mkdtemp),.gitignore 落 cwd 根。因为该目录非 git 仓库,
 * findGitRoot 返回 null,_resolveRoot 回退到 cwd,写入落在临时目录根(可控)。
 *
 * 锁定:① Node 项目 generateForProject → .gitignore 出现 node_modules/;② 二次调用幂等不重复;
 * ③ 探栈正确;④ appendPatterns 幂等(已有 pattern 跳过);⑤ 现有内容保留;⑥ 门控关 → 不写。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gis = require('../../src/services/gitignoreService');

describe('gitignoreService', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gis-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('Node 项目 detectStacks → node', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}');
    assert.deepEqual(gis.detectStacks(tmp), ['node']);
  });

  test('generateForProject(Node) → .gitignore 出现 node_modules/', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}');
    const res = gis.generateForProject(tmp);
    assert.equal(res.success, true, res.error || '');
    assert.ok(res.stacks.includes('node'));
    const body = fs.readFileSync(res.file, 'utf-8');
    assert.match(body, /node_modules\//);
    assert.match(body, /\.env/); // common 模板
  });

  test('二次调用幂等:node_modules/ 不重复', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}');
    gis.generateForProject(tmp);
    const res2 = gis.generateForProject(tmp);
    assert.equal(res2.added.length, 0, `second run should add nothing, added=${res2.added}`);
    const body = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf-8');
    assert.equal((body.match(/^node_modules\/$/gm) || []).length, 1);
  });

  test('appendPatterns 幂等 + 保留现有内容', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), '# mine\nfoo/\n');
    const res = gis.appendPatterns(tmp, ['secret.env', 'foo/']);
    assert.equal(res.success, true, res.error || '');
    assert.deepEqual(res.added, ['secret.env']); // foo/ already covered
    assert.ok(res.skipped.includes('foo/'));
    const body = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf-8');
    assert.match(body, /# mine/);   // 现有保留
    assert.match(body, /foo\//);
    assert.match(body, /secret\.env/);
    assert.equal((body.match(/^foo\/$/gm) || []).length, 1); // 不重复
  });

  test('hasGitignore 反映存在性', () => {
    assert.equal(gis.hasGitignore(tmp), false);
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'x\n');
    assert.equal(gis.hasGitignore(tmp), true);
  });

  test('门控关(KHY_GITIGNORE_ADVISOR=off) → 不写', () => {
    const saved = process.env.KHY_GITIGNORE_ADVISOR;
    process.env.KHY_GITIGNORE_ADVISOR = 'off';
    try {
      fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}');
      const res = gis.generateForProject(tmp);
      assert.equal(res.success, false);
      assert.equal(fs.existsSync(path.join(tmp, '.gitignore')), false);
    } finally {
      if (saved === undefined) delete process.env.KHY_GITIGNORE_ADVISOR;
      else process.env.KHY_GITIGNORE_ADVISOR = saved;
    }
  });
});
