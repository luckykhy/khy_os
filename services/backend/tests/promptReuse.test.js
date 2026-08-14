'use strict';

/**
 * promptReuse.test.js — Agent 提示词复用机制（DESIGN-ARCH-018）单元/集成测试。
 *
 * 覆盖核心诉求与防呆规则：
 *   - 动态复用：用法登记 → 相似任务检索回流（非静态预设）。
 *   - 效果导向：效果分随成功/失败/反馈变化；检索按「相似度 × 效果」排序。
 *   - 防呆·版本保留：换 promptText 追加 versions[]，绝不覆盖历史。
 *   - 防呆·相似度阈值：不相似任务被阈值过滤，避免误推荐。
 *   - 健壮 / 门控：KHY_PROMPT_REUSE=0 整体停用；零数据时静默返回 null。
 *
 * Hermetic：每个用例用独立临时 KHY_DATA_HOME，store/service 在 isolateModules 中
 * 重新加载，互不污染、不触碰真实数据家。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 在隔离的临时数据家中加载一组全新模块，执行 fn 后还原 env。 */
function withFreshStore(envOverlay, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prompt-reuse-'));
  const saved = {};
  const overlay = { KHY_DATA_HOME: dir, ...envOverlay };
  for (const k of Object.keys(overlay)) {
    saved[k] = process.env[k];
    if (overlay[k] === undefined) delete process.env[k];
    else process.env[k] = overlay[k];
  }
  let result;
  jest.isolateModules(() => {
    const store = require('../src/services/promptReuseStore');
    const service = require('../src/services/promptReuseService');
    result = fn({ store, service, dir });
  });
  for (const k of Object.keys(overlay)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return result;
}

describe('promptReuseStore — 分词 / 签名 / 相似度', () => {
  test('normalizeTokens：中文二元组 + 英文词，去停用词', () => {
    withFreshStore({}, ({ store }) => {
      const toks = store.normalizeTokens('请帮我重构登录模块 refactor login');
      expect(toks).toEqual(expect.arrayContaining(['登录', 'refactor', 'login']));
      // 停用词「请」「帮」「我」不应作为独立 token 残留为单字
      expect(toks).not.toContain('请');
    });
  });

  test('signatureFor：同一任务文本稳定归一；token 级语序无关', () => {
    withFreshStore({}, ({ store }) => {
      // 契约 1：同文本恒等签名（用于 upsert 去重）
      expect(store.signatureFor('给登录接口补充测试')).toBe(store.signatureFor('给登录接口补充测试'));
      // 契约 2：token 级语序无关（token 排序后再哈希）——用 ascii 词演示该不变性
      expect(store.signatureFor('refactor login module'))
        .toBe(store.signatureFor('module login refactor'));
    });
  });

  test('similarity：相似任务高分，不相似任务≈0', () => {
    withFreshStore({}, ({ store }) => {
      const hi = store.similarity(
        store.normalizeTokens('为登录接口写 jest 测试'),
        store.normalizeTokens('给登录接口补充 Jest 单元测试'),
      );
      const lo = store.similarity(
        store.normalizeTokens('优化前端 CSS 动画性能'),
        store.normalizeTokens('给登录接口补充 Jest 单元测试'),
      );
      expect(hi).toBeGreaterThan(0.35);
      expect(lo).toBeLessThan(0.1);
    });
  });
});

describe('promptReuseStore — 版本保留（防呆）', () => {
  test('同任务换 promptText 追加新版本，绝不覆盖历史', () => {
    withFreshStore({}, ({ store }) => {
      const t = '给订单服务补充集成测试';
      const r1 = store.recordUsage({ taskText: t, promptText: '打法 A：先建 fixtures。' });
      const r2 = store.recordUsage({ taskText: t, promptText: '打法 B：分层断言。' });
      expect(r1.id).toBe(r2.id); // 同签名 → 同配方
      const rec = store.loadRecipe(r2.id);
      expect(rec.versions).toHaveLength(2);
      expect(rec.versions[0].promptText).toContain('打法 A'); // 旧版本仍在
      expect(rec.current.promptText).toContain('打法 B');     // 当前=最新
      expect(rec.stats.uses).toBe(2);
    });
  });

  test('相同 promptText 重复登记不产生新版本', () => {
    withFreshStore({}, ({ store }) => {
      const t = '给订单服务补充集成测试';
      const { id } = store.recordUsage({ taskText: t, promptText: '同一打法。' });
      store.recordUsage({ taskText: t, promptText: '同一打法。' });
      const rec = store.loadRecipe(id);
      expect(rec.versions).toHaveLength(1);
      expect(rec.stats.uses).toBe(2);
    });
  });
});

describe('promptReuseStore — 效果评估', () => {
  test('成功提升效果分，失败拉低；贝叶斯平滑抑制 1/1 假象', () => {
    withFreshStore({}, ({ store }) => {
      const { id } = store.recordUsage({ taskText: '甲任务 部署上线', promptText: 'x' });
      const oneShot = store.computeEffectiveness({ uses: 1, successes: 1 });
      expect(oneShot).toBeLessThan(0.9); // 不会因单次成功就给满分

      store.recordOutcome({ id, success: true });
      store.recordOutcome({ id, success: true });
      store.recordOutcome({ id, success: true });
      const good = store.loadRecipe(id).effectiveness;

      const { id: id2 } = store.recordUsage({ taskText: '乙任务 部署回滚', promptText: 'y' });
      store.recordOutcome({ id: id2, success: false });
      store.recordOutcome({ id: id2, success: false });
      const bad = store.loadRecipe(id2).effectiveness;

      expect(good).toBeGreaterThan(bad);
    });
  });

  test('显式用户反馈纳入效果分', () => {
    withFreshStore({}, ({ store }) => {
      const { id } = store.recordUsage({ taskText: '丙任务 写文档', promptText: 'z' });
      const before = store.loadRecipe(id).effectiveness;
      store.recordOutcome({ id, success: true, feedbackScore: 1 });
      const after = store.loadRecipe(id).effectiveness;
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  test('avgDurationMs 增量均值正确', () => {
    withFreshStore({}, ({ store }) => {
      const { id } = store.recordUsage({ taskText: '丁任务 跑构建', promptText: 'b' });
      store.recordOutcome({ id, success: true, durationMs: 1000 });
      store.recordOutcome({ id, success: true, durationMs: 3000 });
      expect(store.loadRecipe(id).stats.avgDurationMs).toBe(2000);
    });
  });
});

describe('promptReuseStore — 检索排序与阈值', () => {
  test('低于阈值的不相似配方被过滤', () => {
    withFreshStore({}, ({ store }) => {
      store.recordUsage({ taskText: '给登录接口补充 Jest 单元测试', promptText: 'p' });
      store.recordOutcome({ taskText: '给登录接口补充 Jest 单元测试', success: true });
      const hit = store.retrieve('为登录接口写 jest 测试', { threshold: 0.35 });
      expect(hit.length).toBeGreaterThanOrEqual(1);
      const miss = store.retrieve('优化前端 CSS 动画性能', { threshold: 0.35 });
      expect(miss).toHaveLength(0);
    });
  });

  test('效果更高的配方在相近相似度下排序更前', () => {
    withFreshStore({}, ({ store }) => {
      // 两个对登录测试都相似的配方，一个高效一个低效
      const a = store.recordUsage({ taskText: '登录接口 单元测试 覆盖', promptText: '高效打法' });
      const b = store.recordUsage({ taskText: '登录接口 单元测试 用例', promptText: '低效打法' });
      for (let i = 0; i < 4; i++) store.recordOutcome({ id: a.id, success: true });
      for (let i = 0; i < 4; i++) store.recordOutcome({ id: b.id, success: false });
      const ranked = store.retrieve('登录接口 单元测试', { threshold: 0.2, limit: 5 });
      const ia = ranked.findIndex(r => r.id === a.id);
      const ib = ranked.findIndex(r => r.id === b.id);
      expect(ia).toBeGreaterThanOrEqual(0);
      expect(ib).toBeGreaterThanOrEqual(0);
      expect(ia).toBeLessThan(ib); // 高效在前
    });
  });
});

describe('promptReuseService — 推荐 / 回收 / 门控', () => {
  test('recommendForTask 命中时返回可前置的 [SYSTEM:] 建议块', () => {
    withFreshStore({}, ({ store, service }) => {
      store.recordUsage({ taskText: '给登录接口补充 Jest 单元测试', promptText: '覆盖成功/401/参数校验三类用例。' });
      store.recordOutcome({ taskText: '给登录接口补充 Jest 单元测试', success: true });
      const rec = service.recommendForTask('为登录接口写 jest 测试');
      expect(rec).not.toBeNull();
      expect(rec.block).toMatch(/SYSTEM: 提示词复用建议/);
      expect(rec.block).toContain('覆盖成功');
      expect(rec.candidates.length).toBeGreaterThanOrEqual(1);
    });
  });

  test('零数据时 recommendForTask 返回 null（无噪音无副作用）', () => {
    withFreshStore({}, ({ service }) => {
      expect(service.recommendForTask('任意新任务 abc')).toBeNull();
    });
  });

  test('captureOutcome 登记用法并回写效果，可被随后检索复用', () => {
    withFreshStore({}, ({ store, service }) => {
      const id = service.captureOutcome({
        taskText: '为支付回调补充契约测试',
        success: true,
        durationMs: 5000,
        promptText: '对账三态：成功/失败/重复回调幂等。',
      });
      expect(id).toBeTruthy();
      const rec = store.loadRecipe(id);
      expect(rec.stats.successes).toBe(1);
      expect(rec.category).toBe('testing'); // 自动分类
      const hit = service.recommendForTask('支付回调 契约测试 补充');
      expect(hit).not.toBeNull();
    });
  });

  test('KHY_PROMPT_REUSE=0 整体停用：recommend=null 且 capture=null', () => {
    withFreshStore({ KHY_PROMPT_REUSE: '0' }, ({ store, service }) => {
      // 即便底层有数据
      store.recordUsage({ taskText: '给登录接口补充 Jest 单元测试', promptText: 'p' });
      store.recordOutcome({ taskText: '给登录接口补充 Jest 单元测试', success: true });
      expect(service.recommendForTask('为登录接口写 jest 测试')).toBeNull();
      expect(service.captureOutcome({ taskText: '任意', success: true })).toBeNull();
    });
  });

  test('classifyCategory 关键词归类', () => {
    withFreshStore({}, ({ service }) => {
      expect(service.classifyCategory('补充单元测试')).toBe('testing');
      expect(service.classifyCategory('修复登录报错 bug')).toBe('bugfix');
      expect(service.classifyCategory('重构数据访问层')).toBe('refactor');
      expect(service.classifyCategory('随便聊聊')).toBe('general');
    });
  });
});

describe('promptReuseService — 防呆健壮性', () => {
  test('空任务文本不抛错，安全返回', () => {
    withFreshStore({}, ({ service }) => {
      expect(service.recommendForTask('')).toBeNull();
      expect(service.captureOutcome({ taskText: '', success: true })).toBeNull();
    });
  });

  test('损坏的配方文件被静默跳过，不影响检索', () => {
    withFreshStore({}, ({ store, dir }) => {
      store.recordUsage({ taskText: '给登录接口补充 Jest 单元测试', promptText: 'p' });
      store.recordOutcome({ taskText: '给登录接口补充 Jest 单元测试', success: true });
      // 注入一个损坏 JSON
      const recipesDir = path.join(dir, 'prompts', 'recipes');
      fs.writeFileSync(path.join(recipesDir, 'corrupt.json'), '{ not valid json', 'utf-8');
      const hit = store.retrieve('为登录接口写 jest 测试', { threshold: 0.35 });
      expect(hit.length).toBeGreaterThanOrEqual(1); // 损坏文件被跳过，正常配方仍命中
    });
  });
});
