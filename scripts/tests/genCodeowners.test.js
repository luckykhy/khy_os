'use strict';

/**
 * genCodeowners.test.js — pins scripts/maintenance/gen-codeowners.js.
 *
 * 只测纯函数（build / syncRoster / OWNER_RE），全部输入用夹具对象构造，
 * **绝不读写真实的 .github/CODEOWNERS 或 maintainers.json**。
 *
 * 重点钉住三条容易回归的行为：
 *   1. 未分配维护者的 area 不产出任何规则（宁可无规则，也不要一条被 GitHub
 *      静默忽略的无效规则 —— 这正是本脚本存在的原因）。
 *   2. 全局兜底 `*` 必须排在具体规则之前（CODEOWNERS 是 last-match-wins）。
 *   3. 无效 owner（占位符）导致整个 area 被跳过并产生警告，而不是被写进产物。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const gen = require('../maintenance/gen-codeowners');

const AREAS = [
  { id: 'alpha', label: 'Alpha area', paths: ['src/alpha.js', 'src/alpha/'] },
  { id: 'beta', label: 'Beta area', paths: ['src/beta.js'] },
  { id: 'gamma', label: 'Gamma area', paths: ['docs/gamma with space.md'] },
];

describe('gen-codeowners', () => {
  test('未分配 owner 的 area 不产出规则', () => {
    const { text, stats } = gen.build(AREAS, { defaultOwners: ['@root'], areaOwners: {} });
    assert.equal(stats.rules, 0);
    assert.equal(stats.unassigned, 3);
    assert.ok(!text.includes('src/alpha.js'), '不应出现任何具体路径规则');
    assert.match(text, /^\* @root$/m, '兜底规则仍应存在');
  });

  test('已分配 owner 的 area 产出规则，且兜底规则排在前面', () => {
    const { text, stats } = gen.build(AREAS, {
      defaultOwners: ['@root'],
      areaOwners: { alpha: ['@a1', '@org/team'] },
    });
    assert.equal(stats.ownedAreas, 1);
    assert.equal(stats.rules, 2);
    const fallbackAt = text.indexOf('* @root');
    const specificAt = text.indexOf('src/alpha.js');
    assert.ok(fallbackAt !== -1 && specificAt !== -1);
    assert.ok(
      fallbackAt < specificAt,
      'CODEOWNERS 是 last-match-wins：兜底必须在前，否则具体规则会被兜底覆盖'
    );
    assert.match(text, /^src\/alpha\.js @a1 @org\/team$/m);
  });

  test('含空格的路径被跳过（CODEOWNERS pattern 无法匹配空格）', () => {
    const { text, stats, warnings } = gen.build(AREAS, {
      defaultOwners: ['@root'],
      areaOwners: { gamma: ['@g1'] },
    });
    assert.equal(stats.skippedPatterns, 1);
    assert.equal(stats.rules, 0);
    assert.ok(!text.includes('gamma with space'));
    assert.ok(warnings.some((w) => w.includes('含空格')));
  });

  test('无效 owner 使整个 area 被跳过并告警', () => {
    const { text, warnings, stats } = gen.build(AREAS, {
      defaultOwners: ['@root'],
      areaOwners: { alpha: ['@<area-id>'] },
    });
    assert.equal(stats.rules, 0);
    assert.ok(!text.includes('@<area-id>'), '占位符绝不能进入产物');
    assert.ok(warnings.some((w) => w.includes('alpha') && w.includes('无效 owner')));
  });

  test('缺少兜底 owner 时告警', () => {
    const { warnings } = gen.build(AREAS, { defaultOwners: [], areaOwners: {} });
    assert.ok(warnings.some((w) => w.includes('defaultOwners 为空')));
  });

  test('同一路径被多个已分配 area 声明时，按 last-match-wins 告警', () => {
    const areas = [
      { id: 'alpha', label: 'A', paths: ['src/shared.js'] },
      { id: 'beta', label: 'B', paths: ['src/shared.js'] },
    ];
    const { warnings } = gen.build(areas, {
      defaultOwners: ['@root'],
      areaOwners: { alpha: ['@a1'], beta: ['@b1'] },
    });
    const hit = warnings.find((w) => w.includes('src/shared.js'));
    assert.ok(hit, '应就重复声明的路径告警');
    assert.ok(hit.includes('beta') && hit.includes('alpha'), '应指出最终归属与失效方');
  });

  test('OWNER_RE 接受 @user / @org/team / 邮箱，拒绝占位符与裸名字', () => {
    for (const ok of ['@kodehu03', '@org/team', 'dev@example.com', '@a-b-c']) {
      assert.ok(gen.OWNER_RE.test(ok), `应接受 ${ok}`);
    }
    for (const bad of ['@<area-id>', 'kodehu03', '@', '@-lead', '@a b']) {
      assert.ok(!gen.OWNER_RE.test(bad), `应拒绝 ${bad}`);
    }
  });

  test('syncRoster 补齐新 area、保留已填值、报告已消失的 id', () => {
    const roster = {
      defaultOwners: ['@root'],
      areaOwners: { alpha: ['@a1'], obsolete: ['@old'] },
    };
    const { next, added, removed } = gen.syncRoster(AREAS, roster);
    assert.deepEqual(next.areaOwners.alpha, ['@a1'], '已填的值不能被清空');
    assert.deepEqual(next.areaOwners.beta, []);
    assert.deepEqual(added.sort(), ['beta', 'gamma']);
    assert.deepEqual(removed, ['obsolete']);
    assert.ok(!('obsolete' in next.areaOwners), '映射表中已不存在的 area 不再产出规则');
  });
});
