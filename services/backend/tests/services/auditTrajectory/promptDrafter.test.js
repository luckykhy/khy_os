'use strict';

/**
 * 第三项验收测试：提示词起草器（六道硬性自检 + 人工确认才发出）与三级验收器。
 *
 * 两条硬约束在这里被钉住：
 *   1. 起草器**没有发送能力**：draft() 不写任何轨迹，只有 confirmDraft 带真人署名
 *      才落一条 origin.type=human 的提示词。缺署名直接抛，不静默降级。
 *   2. **禁止每一块都跑第三级**：按块申请三级会被 AcceptancePolicy 拒绝并给出原因，
 *      收尾额度默认只有一次。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const acceptance = require('../../../src/services/auditTrajectory/acceptance');
const drafter = require('../../../src/services/auditTrajectory/drafter');
const parser = require('../../../src/services/auditTrajectory/parser');
const { AuditTrajectoryRecorder } = require('../../../src/services/auditTrajectory/recorder');

const SEP = String.fromCharCode(92); // 反斜杠，避免在字面量里被转义规则绕晕
const EVIDENCE = {
  screenshots: ['C:' + SEP + 'shots' + SEP + 'home-before.png', 'C:' + SEP + 'shots' + SEP + 'home-after.png'],
  logs: [{ command: 'npm run build', exitCode: 0, stdout: 'built in 4200ms, 37 modules' }],
  numbers: [16],
};

let tmpRoot;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-drafter-'));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言结论 */
  }
});

describe('锚点集合：只收可核查的东西', () => {
  test('截图取全路径与文件名，日志里的数字也进锚点', () => {
    const set = drafter.buildAnchorSet(EVIDENCE);
    const froms = new Set(set.list.map((a) => a.from));
    expect(froms.has('screenshot')).toBe(true);
    expect(froms.has('log')).toBe(true);
    expect([...set.tokens].some((t) => t === 'home-before.png'.replace(/-/g, ''))).toBe(true);
    expect([...set.tokens]).toContain('4200ms');
    expect([...set.tokens]).toContain('37');
  });

  test('空证据得到空锚点集合（后面检查 1 会据此判否）', () => {
    const set = drafter.buildAnchorSet({});
    expect(set.list).toHaveLength(0);
    expect(set.tokens.size).toBe(0);
  });
});

describe('检查 1：有实测锚点（无锚点等于编造，不可靠重写修复）', () => {
  const set = drafter.buildAnchorSet(EVIDENCE);

  test('整篇没有一个锚点直接判否，且标为不可机械修复', () => {
    const r = drafter.checkEvidenceAnchor('我觉得整体差点意思，你再优化一下吧', set);
    expect(r.ok).toBe(false);
    expect(r.fixable).toBe(false);
    expect(r.reason).toContain('锚点');
  });

  test('体感词所在的那一句必须自带锚点', () => {
    const bad = '刚点了一遍 home-after.png，改得不错。另一块我感觉有点怪，你顺着调调';
    const r = drafter.checkEvidenceAnchor(bad, set);
    expect(r.ok).toBe(false);
    expect(r.unanchored[0].vibe).toContain('感觉');
  });

  test('体感词同句带锚点就放行（主观取舍是被鼓励的）', () => {
    const good = '对着 home-after.png 看，我感觉卡片间距还是挤了点';
    const r = drafter.checkEvidenceAnchor(good, set);
    expect(r.ok).toBe(true);
    expect(r.anchors.length).toBeGreaterThan(0);
  });
});

describe('检查 2 到 6', () => {
  test('检查 2：跟前一轮太像就判否，且可靠重写修复', () => {
    const text = '刚点了一遍 home-after.png，卡片间距还是挤，先把间距调大一点';
    const r = drafter.checkSimilarity(text, [text], {});
    expect(r.ok).toBe(false);
    expect(r.fixable).toBe(true);
    expect(r.metrics.body).toBeGreaterThan(0.9);
  });

  test('检查 2：第一轮没有可比对象，直接通过', () => {
    expect(drafter.checkSimilarity('随便一段', []).ok).toBe(true);
  });

  test('检查 3：通篇像规格书就判否；有口语取舍就通过', () => {
    expect(drafter.checkTone('列表页卡片间距应调整为 16px，符合设计规范第 3 条').ok).toBe(false);
    expect(drafter.checkTone('间距先调大点吧，其他的回头再说').ok).toBe(true);
  });

  test('检查 4：破折号连字符全清（唯一允许机械自动修复的一条）', () => {
    const dirty = '这块 UI 有点挤 —— 顺手把 line-height 调一调';
    const bad = drafter.checkNoDashes(dirty);
    expect(bad.ok).toBe(false);
    expect(bad.autoFix).toBe(true);
    const cleaned = drafter.stripDashes(dirty);
    expect(drafter.checkNoDashes(cleaned).ok).toBe(true);
    for (const d of drafter.DASHES) {
      expect(cleaned.includes(d)).toBe(false);
    }
  });

  test('检查 5：声明了多个靶子要拆多轮', () => {
    const r = drafter.checkSingleTarget('随便', { targets: ['卡片间距', '登录报错'] });
    expect(r.ok).toBe(false);
    expect(r.splittable).toBe(true);
    expect(r.reason).toContain('2 个靶子');
  });

  test('检查 5：连接词前后各有一个动作也算两个靶子', () => {
    const r = drafter.checkSingleTarget('先把间距调大，另外顺手把登录那个报错也改掉');
    expect(r.ok).toBe(false);
    expect(r.splittable).toBe(true);
  });

  test('检查 5：只有一个动作的长句不误判', () => {
    expect(drafter.checkSingleTarget('把列表那一屏的卡片间距调大一点，别动别的地方').ok).toBe(true);
  });

  test('检查 6：语言跟随原始需求，全程不换', () => {
    const set = drafter.buildAnchorSet(EVIDENCE);
    expect(drafter.checkLanguage('please bump the card spacing a bit', 'zh', set).ok).toBe(false);
    expect(drafter.checkLanguage('间距先调大一点', 'zh', set).ok).toBe(true);
    expect(drafter.checkLanguage('bump the spacing please', 'en', set).ok).toBe(true);
    expect(drafter.checkLanguage('间距调大一点', 'en', set).ok).toBe(false);
  });

  test('锚点里的英文（文件名、命令）不算换语言', () => {
    const set = drafter.buildAnchorSet(EVIDENCE);
    const text = '对着 home-before.png 和 home-after.png 比了一遍，npm run build 也过了，间距先调大点';
    expect(drafter.checkLanguage(text, 'zh', set).ok).toBe(true);
  });

  test('runSelfChecks 报「几条过」而不是只报通过与否', () => {
    const r = drafter.runSelfChecks('随便写点什么', { evidence: {}, lang: 'zh' });
    expect(r.checks).toHaveLength(6);
    expect(r.ok).toBe(false);
    expect(r.status).toMatch(/自检提示词草稿：\d \/ 6 条通过/);
  });
});

describe('起草与重写：产物是草稿，不是消息', () => {
  test('一份带证据的草稿六道全过，并显式标注要人工确认', () => {
    const r = drafter.draft({
      evidence: EVIDENCE,
      observation: '卡片间距对着 home-after.png 看还是挤',
      ask: '能不能把列表那一屏的卡片间距调大一点',
      lang: 'zh',
    });
    expect(r.ok).toBe(true);
    expect(r.draft.requiresHumanConfirmation).toBe(true);
    expect(r.draft.text.length).toBeGreaterThan(10);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    for (const d of drafter.DASHES) {
      expect(r.draft.text.includes(d)).toBe(false);
    }
  });

  test('跟前几轮撞了会自动换开头重写，直到过检查 2', () => {
    const input = {
      evidence: EVIDENCE,
      observation: '卡片间距对着 home-after.png 看还是挤',
      ask: '能不能把列表那一屏的卡片间距调大一点',
      lang: 'zh',
    };
    const first = drafter.draft(input);
    expect(first.ok).toBe(true);
    const second = drafter.draft({ ...input, priorDrafts: [first.draft.text] });
    expect(second.ok).toBe(true);
    expect(second.draft.text).not.toBe(first.draft.text);
    expect(second.attempts.length).toBeGreaterThan(1); // 第一次尝试确实被判重复过
    expect(second.attempts[0].failed).toContain('similarity');
    expect(parser.similarity(first.draft.text.slice(0, 12), second.draft.text.slice(0, 12))).toBeLessThan(0.8);
  });

  test('没有实测证据时不靠重写硬凑，直接判 blocked 交人工', () => {
    const r = drafter.draft({ evidence: {}, observation: '感觉不太行', ask: '你再优化下', lang: 'zh' });
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.failed[0].id).toBe('evidence-anchor');
    expect(r.status).toContain('无法靠重写解决');
  });

  test('多靶子不硬起草，直接要求拆成多轮', () => {
    const r = drafter.draft({
      evidence: EVIDENCE,
      observation: '两处都对着 home-after.png 看过',
      ask: '都调一下',
      targets: ['卡片间距', '登录报错'],
      lang: 'zh',
    });
    expect(r.ok).toBe(false);
    expect(r.splitRequired).toBe(true);
    expect(r.status).toContain('拆成 2 轮');
  });

  test('splitDraft 一个靶子一份草稿，且后一份要跟前一份比相似度', () => {
    const r = drafter.splitDraft({
      lang: 'zh',
      targets: [
        {
          name: '卡片间距',
          evidence: EVIDENCE,
          observation: '对着 home-after.png 看卡片还是挤',
          ask: '能不能先把卡片间距调大一点',
        },
        {
          name: '构建耗时',
          evidence: EVIDENCE,
          observation: 'npm run build 那条日志写着 4200ms，比上次慢',
          ask: '要是不难的话顺手看下为什么变慢了',
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds.map((x) => x.target)).toEqual(['卡片间距', '构建耗时']);
    expect(r.rounds[0].draft.text).not.toBe(r.rounds[1].draft.text);
    expect(r.status).toContain('2 / 2');
  });

  test('自定义起草器（比如接大模型）一样要过六道自检', () => {
    const r = drafter.draft(
      { evidence: EVIDENCE, lang: 'zh' },
      { composer: () => '列表页卡片间距应统一为 16px，参见 home-after.png', maxRewrites: 1 }
    );
    expect(r.ok).toBe(false);
    expect(r.attempts[0].failed).toContain('tone'); // 太像规格书
  });
});

describe('人工确认是唯一的发出口（不许做成自动闭环）', () => {
  function freshRecorder(name) {
    return new AuditTrajectoryRecorder({ sessionId: name, cwd: tmpRoot, dir: path.join(tmpRoot, name) });
  }

  test('起草器模块本身没有任何发送 / 自动确认能力', () => {
    const names = Object.keys(drafter);
    expect(names.filter((n) => /send|dispatch|post|emit|auto/i.test(n))).toEqual([]);
    expect(typeof drafter.confirmDraft).toBe('function');
  });

  test('draft() 不写一个字节到轨迹', () => {
    const rec = freshRecorder('no-write');
    const before = fs.statSync(rec.file).size;
    drafter.draft({
      evidence: EVIDENCE,
      observation: '对着 home-after.png 看卡片还是挤',
      ask: '把卡片间距先调大一点',
      lang: 'zh',
    });
    expect(fs.statSync(rec.file).size).toBe(before);
  });

  test('缺真人署名直接抛，绝不静默降级成 ai_generated', () => {
    const d = drafter.draft({
      evidence: EVIDENCE,
      observation: '对着 home-after.png 看卡片还是挤',
      ask: '把卡片间距先调大一点',
      lang: 'zh',
    });
    expect(() => drafter.confirmDraft({ draft: d.draft })).toThrow(drafter.DraftNotConfirmedError);
    try {
      drafter.confirmDraft({ draft: d.draft, confirmedBy: '   ' });
    } catch (err) {
      expect(err.code).toBe('DRAFT_UNSIGNED');
    }
  });

  test('署名确认后落一条 origin.type=human 的提示词，解析器读得出来', () => {
    const rec = freshRecorder('confirmed');
    const d = drafter.draft({
      evidence: EVIDENCE,
      observation: '对着 home-after.png 看卡片还是挤',
      ask: '把卡片间距先调大一点',
      lang: 'zh',
    });
    const out = drafter.confirmDraft({ draft: d.draft, confirmedBy: '小柯', recorder: rec });
    expect(out.ok).toBe(true);
    expect(out.origin).toMatchObject({ type: 'human', confirmedBy: '小柯' });
    const parsed = parser.parseTrajectory(rec.file);
    const prompts = parsed.events.filter((e) => e.type === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].origin.type).toBe('human');
    expect(prompts[0].origin.confirmedBy).toBe('小柯');
    expect(prompts[0].origin.confirmedAt).toBeTruthy();
    expect(prompts[0].origin.draftId).toBe(d.draft.id);
  });

  test('真人改写后的正文以人写的为准，并标记 edited', () => {
    const rec = freshRecorder('edited');
    const d = drafter.draft({
      evidence: EVIDENCE,
      observation: '对着 home-after.png 看卡片还是挤',
      ask: '把卡片间距先调大一点',
      lang: 'zh',
    });
    const out = drafter.confirmDraft({
      draft: d.draft,
      confirmedBy: '小柯',
      recorder: rec,
      editedText: '看 home-after.png 那张，卡片贴太近了 —— 先把间距放开点就行',
    });
    expect(out.edited).toBe(true);
    expect(out.text).toContain('卡片贴太近');
    expect(out.text.includes('—')).toBe(false); // 机械那条对人写的也生效
  });

  test('草稿里混进管理词汇，确认这一步就拦住（不让它借起草器绕进 Worker）', () => {
    const d = drafter.draft({
      evidence: EVIDENCE,
      observation: '对着 home-after.png 看卡片还是挤',
      ask: '把卡片间距先调大一点',
      lang: 'zh',
    });
    expect(() =>
      drafter.confirmDraft({
        draft: d.draft,
        confirmedBy: '小柯',
        editedText: '本轮质检要求把 home-after.png 里的卡片间距调大一点',
      })
    ).toThrow(/拒绝发出|CHANNEL/);
  });
});

describe('一级验收：grep 源码判模块在不在（秒级，每块都过）', () => {
  const SRC = path.resolve(__dirname, '..', '..', '..', 'src', 'services', 'auditTrajectory');

  test('模块与符号都在时通过，并给出文件加行号', () => {
    const r = acceptance.tier1Grep({
      root: SRC,
      checks: [
        { name: '轨迹记录器', files: ['recorder.js'], patterns: ['class AuditTrajectoryRecorder', 'fsyncSync'] },
        { name: '工作目录校验', files: ['workspaceGuard.js'], patterns: ['assertWorkerCwd'] },
      ],
    });
    expect(r.tier).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.results[0].hits[0].line).toBeGreaterThan(0);
    expect(r.status).toContain('2 / 2 块在位');
    expect(r.elapsedMs).toBeLessThan(3000); // 秒级，这一级才敢每块都过
  });

  test('符号缺失时点名缺的是哪一个', () => {
    const r = acceptance.tier1Grep({
      root: SRC,
      checks: [{ name: '不存在的模块', files: ['drafter.js'], patterns: ['someSymbolThatDoesNotExist'] }],
    });
    expect(r.ok).toBe(false);
    expect(r.results[0].missingPatterns).toEqual(['someSymbolThatDoesNotExist']);
    expect(r.results[0].reason).toContain('源码里找不到');
  });

  test('文件都读不到时如实报读不到，而不是含糊地报没找到', () => {
    const r = acceptance.tier1Grep({ root: SRC, checks: [{ name: '缺文件', files: ['nope.js'], patterns: ['x'] }] });
    expect(r.ok).toBe(false);
    expect(r.results[0].missingFiles).toEqual(['nope.js']);
    expect(r.results[0].reason).toContain('读不到文件');
  });

  test('anyOf 只要命中一个就算在位', () => {
    const r = acceptance.tier1Grep({
      root: SRC,
      checks: [{ name: '任一', files: ['drafter.js'], patterns: ['nopeNope', 'confirmDraft'], anyOf: true }],
    });
    expect(r.ok).toBe(true);
  });
});

describe('二级验收：打开产物实际点一遍（分钟级，主力层）', () => {
  test('没有交互执行器时如实报未执行，绝不假装通过', async () => {
    const r = await acceptance.tier2Interact({ steps: [{ name: '打开首页' }] });
    expect(r.ok).toBe(false);
    expect(r.ran).toBe(false);
    expect(r.reason).toContain('交互执行器');
  });

  test('没有步骤等于什么都没验，也判否', async () => {
    const r = await acceptance.tier2Interact({ runner: async () => ({ ok: true }), steps: [] });
    expect(r.ok).toBe(false);
    expect(r.ran).toBe(false);
  });

  test('每步都点通才算过，截图要真的在盘上才算证据', async () => {
    const real = path.join(tmpRoot, 'shot.png');
    fs.writeFileSync(real, 'x');
    const ghost = path.join(tmpRoot, 'ghost.png');
    const seen = [];
    const r = await acceptance.tier2Interact({
      artifact: 'index.html',
      steps: [{ name: '打开首页' }, { name: '点第一张卡片' }],
      runner: async (step) => {
        seen.push(step.name);
        return { ok: true, evidence: '点完了 ' + step.name, screenshot: step.name === '打开首页' ? real : ghost };
      },
    });
    expect(r.ok).toBe(true);
    expect(r.ran).toBe(true);
    expect(seen).toEqual(['打开首页', '点第一张卡片']);
    expect(r.screenshots).toEqual([real]); // 不存在的那张不进证据
    expect(r.status).toContain('2 / 2 步可用');
  });

  test('第一步就打不开就不再往下点（后面的点击没意义）', async () => {
    let calls = 0;
    const r = await acceptance.tier2Interact({
      steps: [{ name: '打开首页' }, { name: '点第一张卡片' }],
      runner: async () => {
        calls += 1;
        return { ok: false, error: '页面白屏' };
      },
    });
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
    expect(r.reason).toContain('页面白屏');
  });

  test('runner 卡住按空闲上限判卡死，而不是永久挂着', async () => {
    const r = await acceptance.tier2Interact({
      stepIdleMs: 200,
      steps: [{ name: '等一个永远不来的响应' }],
      runner: () => new Promise(() => {}),
    });
    expect(r.ok).toBe(false);
    expect(r.steps[0].error).toContain('无进展');
  });
});

describe('三级验收：完整套件只在收尾跑一次（禁止每块都跑）', () => {
  test('按块申请一律拒绝，并说明该用一级加二级', async () => {
    const policy = new acceptance.AcceptancePolicy();
    const r = await acceptance.tier3FullSuite({ policy, scope: 'block', blockId: '卡片间距' });
    expect(r.ran).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.code).toBe('TIER3_PER_BLOCK_FORBIDDEN');
    expect(r.reason).toContain('卡片间距');
    expect(r.reason).toContain('收尾');
  });

  test('收尾放行一次，第二次报额度用完', async () => {
    const policy = new acceptance.AcceptancePolicy();
    const spawnImpl = jest.fn(async () => ({ stdout: 'ok', stderr: '', code: 0 }));
    const first = await acceptance.tier3FullSuite({ policy, scope: 'wrapup', spawnImpl, args: ['test'] });
    expect(first.ok).toBe(true);
    expect(first.exitCode).toBe(0);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const second = await acceptance.tier3FullSuite({ policy, scope: 'wrapup', spawnImpl });
    expect(second.refused).toBe(true);
    expect(second.code).toBe('TIER3_BUDGET_EXHAUSTED');
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  test('没有策略就不许直跑完整套件', async () => {
    await expect(acceptance.tier3FullSuite({ scope: 'wrapup' })).rejects.toThrow(acceptance.Tier3RefusedError);
  });

  test('空闲上限是滑动的（红线 3），默认十分钟量级', async () => {
    expect(acceptance.DEFAULT_SUITE_IDLE_MS).toBeGreaterThanOrEqual(600000);
    const policy = new acceptance.AcceptancePolicy();
    let seenIdle = 0;
    await acceptance.tier3FullSuite({
      policy,
      scope: 'wrapup',
      spawnImpl: async (_cmd, _argv, opts) => {
        seenIdle = opts.idleMs;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    expect(seenIdle).toBe(acceptance.DEFAULT_SUITE_IDLE_MS);
  });

  test('套件卡死时如实报 idleTimeout', async () => {
    const policy = new acceptance.AcceptancePolicy();
    const r = await acceptance.tier3FullSuite({
      policy,
      scope: 'wrapup',
      spawnImpl: async () => {
        throw Object.assign(new Error('600000ms 无输出'), { idleTimeout: true });
      },
    });
    expect(r.ok).toBe(false);
    expect(r.idleTimeout).toBe(true);
    expect(r.status).toContain('判为卡死');
  });

  test('策略报告能看出「按块申请被拒了几次」', async () => {
    const policy = new acceptance.AcceptancePolicy();
    await acceptance.tier3FullSuite({ policy, scope: 'block', blockId: 'a' });
    await acceptance.tier3FullSuite({ policy, scope: 'block', blockId: 'b' });
    const rep = policy.report();
    expect(rep.tier3Runs).toBe(0);
    expect(rep.refusals).toHaveLength(2);
    expect(rep.status).toContain('按块申请被拒 2 次');
  });
});

describe('验收阶梯：代价从低到高，且三级不因为在阶梯里就被偷偷放行', () => {
  const SRC = path.resolve(__dirname, '..', '..', '..', 'src', 'services', 'auditTrajectory');
  const okChecks = [{ name: '起草器', files: ['drafter.js'], patterns: ['function draft'] }];

  test('一级不过就短路，二级三级都不跑（省掉分钟级与十分钟级的代价）', async () => {
    const runner = jest.fn(async () => ({ ok: true }));
    const spawnImpl = jest.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const r = await acceptance.runLadder({
      scope: 'wrapup',
      root: SRC,
      checks: [{ name: '缺的模块', files: ['drafter.js'], patterns: ['neverEverThere'] }],
      interact: { steps: [{ name: '打开首页' }], runner },
      suite: { spawnImpl },
    });
    expect(r.ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(r.skipped.map((s) => s.tier)).toEqual([acceptance.TIER.INTERACT, acceptance.TIER.SUITE]);
    expect(r.status).toContain('止于一级');
  });

  test('按块验收永远只走一级加二级，三级带原因跳过', async () => {
    const spawnImpl = jest.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const r = await acceptance.runLadder({
      scope: 'block',
      blockId: '卡片间距',
      root: SRC,
      checks: okChecks,
      interact: { steps: [{ name: '打开首页' }], runner: async () => ({ ok: true }) },
      suite: { spawnImpl },
    });
    expect(r.ok).toBe(true);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(r.tiers.map((t) => t.tier)).toEqual([acceptance.TIER.GREP, acceptance.TIER.INTERACT]);
    expect(r.skipped.find((s) => s.tier === acceptance.TIER.SUITE).reason).toContain('只在收尾跑一次');
  });

  test('二级发现产物不可用时也不跑三级（先修再跑）', async () => {
    const spawnImpl = jest.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const r = await acceptance.runLadder({
      scope: 'wrapup',
      root: SRC,
      checks: okChecks,
      interact: { steps: [{ name: '打开首页' }], runner: async () => ({ ok: false, error: '白屏' }) },
      suite: { spawnImpl },
    });
    expect(r.ok).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(r.status).toContain('止于二级');
  });

  test('收尾一次跑齐三级，且策略额度被记账', async () => {
    const policy = new acceptance.AcceptancePolicy();
    const spawnImpl = jest.fn(async () => ({ stdout: 'all passed', stderr: '', code: 0 }));
    const r = await acceptance.runLadder({
      scope: 'wrapup',
      policy,
      root: SRC,
      checks: okChecks,
      interact: { steps: [{ name: '打开首页' }], runner: async () => ({ ok: true }) },
      suite: { spawnImpl, args: ['run', 'test:backend'] },
    });
    expect(r.ok).toBe(true);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0][1]).toEqual(['run', 'test:backend']);
    expect(r.tiers.map((t) => t.tier)).toEqual([acceptance.TIER.GREP, acceptance.TIER.INTERACT, acceptance.TIER.SUITE]);
    expect(r.policy.tier3Runs).toBe(1);
  });

  test('同一个策略实例跨多块使用：块块申请全被拒，收尾那次才放行', async () => {
    const policy = new acceptance.AcceptancePolicy();
    const spawnImpl = jest.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const common = { root: SRC, checks: okChecks, policy, suite: { spawnImpl } };
    for (const id of ['块一', '块二', '块三']) {
      const r = await acceptance.runLadder({ ...common, scope: 'block', blockId: id });
      expect(r.ok).toBe(true);
    }
    expect(spawnImpl).not.toHaveBeenCalled();
    const wrap = await acceptance.runLadder({ ...common, scope: 'wrapup' });
    expect(wrap.ok).toBe(true);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(wrap.policy.tier3Runs).toBe(1);
  });
});

describe('barrel 导出（第三项的对外表面）', () => {
  test('index 上能直接拿到起草器与验收器', () => {
    const api = require('../../../src/services/auditTrajectory');
    for (const k of ['draft', 'splitDraft', 'runSelfChecks', 'confirmDraft', 'tier1Grep', 'tier2Interact', 'tier3FullSuite', 'runLadder', 'AcceptancePolicy']) {
      expect(typeof api[k]).toBe('function');
    }
    expect(api.TIER).toEqual({ GREP: 1, INTERACT: 2, SUITE: 3 });
  });
});
