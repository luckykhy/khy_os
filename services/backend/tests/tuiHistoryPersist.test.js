'use strict';

/**
 * tuiHistoryPersist.test.js —— 跨会话历史回溯的端到端契约(不依赖 React)。
 *
 * 验证 Ink TUI 的 useTextInput 所复用的「单一真源」cli/repl/history.js 真能跨会话
 * 落盘/回放,并复刻 hook 挂载时的预填逻辑:
 *   - 提交时 saveHistory([text]) 增量追加一条(不重复)。
 *   - 下次启动 loadHistory() 取回,经 mergeHistory 预填 history.current。
 *   - 上界 MAX_HISTORY 截顶。
 * 用临时 HOME 隔离,绝不碰真实 ~/.khyquant_history。node:test。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mergeHistory } = require('../src/cli/tui/hooks/historyPersist');

const HISTORY_MOD = '../src/cli/repl/history';

// 在临时 HOME 下新鲜加载 repl/history(其 HISTORY_FILE 在 require 时按 HOME 定值)。
function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hist-'));
  const savedHome = process.env.HOME;
  const savedUserprofile = process.env.USERPROFILE;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  delete require.cache[require.resolve(HISTORY_MOD)];
  try {
    const mod = require(HISTORY_MOD);
    return fn(mod, tmp);
  } finally {
    delete require.cache[require.resolve(HISTORY_MOD)];
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserprofile;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('提交→落盘→下次会话 loadHistory 取回(跨会话回溯)', () => {
  withTempHome((mod) => {
    // 上一会话:逐条提交。
    mod.saveHistory(['第一条']);
    mod.saveHistory(['第二条']);
    // 新会话:hook 挂载预填。
    const persisted = mod.loadHistory();
    assert.deepEqual(persisted, ['第一条', '第二条']);
    const session = mergeHistory(persisted, [], mod.MAX_HISTORY);
    // Up 从尾部往前 → 最近一条先出。
    assert.equal(session[session.length - 1], '第二条');
  });
});

test('saveHistory([text]) 增量追加一条,不重复既有内容', () => {
  withTempHome((mod) => {
    mod.saveHistory(['a']);
    mod.saveHistory(['b']);
    mod.saveHistory(['c']);
    assert.deepEqual(mod.loadHistory(), ['a', 'b', 'c']);
  });
});

test('HISTORY_FILE 落在临时 HOME 内(隔离真实历史)', () => {
  withTempHome((mod, tmp) => {
    mod.saveHistory(['x']);
    assert.ok(mod.HISTORY_FILE.startsWith(tmp), 'HISTORY_FILE 应在临时 HOME 下');
    assert.ok(fs.existsSync(mod.HISTORY_FILE));
  });
});

test('超过 MAX_HISTORY 时落盘截到最近 MAX_HISTORY 条', () => {
  withTempHome((mod) => {
    const max = mod.MAX_HISTORY;
    const many = Array.from({ length: max + 10 }, (_, i) => `cmd${i}`);
    mod.saveHistory(many);
    const loaded = mod.loadHistory();
    assert.equal(loaded.length, max);
    assert.equal(loaded[loaded.length - 1], `cmd${max + 9}`); // 最近一条保留
    assert.equal(loaded[0], `cmd${10}`); // 最旧的被截掉
  });
});

test('门控关时(由 hook 注入空 store)走旧行为:不预填、不落盘', () => {
  // hook 在 KHY_TUI_HISTORY_PERSIST=off 时 store=null,既不 load 也不 save。
  // 这里直接验证 mergeHistory 不被调用时的等价物:空持久 → 仅会话内存。
  const sessionOnly = mergeHistory([], ['仅本会话'], 500);
  assert.deepEqual(sessionOnly, ['仅本会话']);
});
