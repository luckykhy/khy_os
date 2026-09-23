'use strict';

/**
 * recentModelsStore — 「历史选择」必须能被「当前真值」剪枝（[DESIGN-ARCH-100] §3.4）。
 *
 * 用户报告：「tui 会莫名跳转到不存在的模型」—— 本 store 记的是「用户曾选过什么」,
 * 不是「什么现在还存在」。一次基于猜测模型（静态目录 / 本机扫描）的选择会永久留在
 * recent_models.json 里，被 F2「最近模型」轮换捞回并直接应用 → 选中即 model_not_found。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('recentModelsStore', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-recent-'));
    file = path.join(dir, 'recent_models.json');
    process.env.KHY_RECENT_MODELS_FILE = file;
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.KHY_RECENT_MODELS_FILE;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('pushRecentModel / readRecentModels 往返且去重置顶', () => {
    const store = require('../../src/services/gateway/recentModelsStore');
    store.pushRecentModel({ adapter: 'api', model: 'gpt-4o' });
    store.pushRecentModel({ adapter: 'codex', model: 'gpt-5.3-codex' });
    store.pushRecentModel({ adapter: 'api', model: 'gpt-4o' }); // 重复 → 置顶,不新增
    const list = store.readRecentModels();
    expect(list.length).toBe(2);
    expect(list[0]).toMatchObject({ adapter: 'api', model: 'gpt-4o' });
  });

  test('pruneRecentModels 忘掉已不在当前 catalog 里的历史条目', () => {
    const store = require('../../src/services/gateway/recentModelsStore');
    store.pushRecentModel({ adapter: 'api', model: 'gpt-4o' });
    store.pushRecentModel({ adapter: 'windsurf', model: 'claude-3.5-sonnet' }); // 猜测条目
    store.pushRecentModel({ adapter: 'codex', model: 'gpt-5.3-codex' });

    // 本次构建出的真实 catalog 只含前两条里的 api/… 与 codex/…
    const keys = new Set(['api/gpt-4o', 'codex/gpt-5.3-codex']);
    const out = store.pruneRecentModels(keys);

    expect(out.removed).toBe(1);
    // 顺序保持「最近在前」(push 是置顶写入):codex 最后 push → 在首位。
    expect(out.list.map((r) => `${r.adapter}/${r.model}`)).toEqual([
      'codex/gpt-5.3-codex',
      'api/gpt-4o',
    ]);
    // 剪枝已落盘,重读一致
    store._resetCache();
    expect(store.readRecentModels().map((r) => `${r.adapter}/${r.model}`)).toEqual([
      'codex/gpt-5.3-codex',
      'api/gpt-4o',
    ]);
  });

  test('pruneRecentModels 支持谓词形式,且谓词抛异常时保留该条(宁可留也不误删)', () => {
    const store = require('../../src/services/gateway/recentModelsStore');
    store.pushRecentModel({ adapter: 'api', model: 'gpt-4o' });
    store.pushRecentModel({ adapter: 'api', model: 'glm-4.6' });

    const out = store.pruneRecentModels((rec) => {
      if (rec.model === 'glm-4.6') {
        throw new Error('boom');
      }
      return true;
    });
    expect(out.removed).toBe(0);
    expect(out.list.length).toBe(2);
  });

  test('pruneRecentModels 非函数/非集合入参 → 零剪枝(绝不因此清空历史)', () => {
    const store = require('../../src/services/gateway/recentModelsStore');
    store.pushRecentModel({ adapter: 'api', model: 'gpt-4o' });
    for (const bad of [null, undefined, 42, 'nope', {}]) {
      expect(store.pruneRecentModels(bad).removed).toBe(0);
    }
    expect(store.readRecentModels().length).toBe(1);
  });

  test('recordKey 大小写不敏感且 model 为空仍可按 adapter 记录', () => {
    const store = require('../../src/services/gateway/recentModelsStore');
    expect(store.recordKey({ adapter: 'API', model: 'GPT-4o' })).toBe('api/gpt-4o');
    expect(store.recordKey({ adapter: 'warp' })).toBe('warp/');
    expect(store.recordKey(null)).toBe('');
  });
});
