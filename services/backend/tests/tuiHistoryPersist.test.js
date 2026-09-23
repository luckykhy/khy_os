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
// repl/history resolves the file through getAppHome(), which honours KHY_APP_HOME
// but memoises the answer → that module's cache must be dropped as well.
const DATA_HOME_MOD = '../src/utils/dataHome';

// 在临时 HOME **与临时 app home** 下新鲜加载 repl/history。
// 只改 HOME/USERPROFILE 是不够的：便携模式下 getAppHome() 根本不看它们，
// HISTORY_FILE 会解析到项目里的 .khy/.khyquant_history，夹具就直接写进了用户
// 真实的 ↑ 历史，并按 MAX_HISTORY 截掉最旧几条(BUG-65)。
function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hist-'));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KHY_APP_HOME: process.env.KHY_APP_HOME,
  };
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KHY_APP_HOME = tmp;
  delete require.cache[require.resolve(DATA_HOME_MOD)];
  delete require.cache[require.resolve(HISTORY_MOD)];
  try {
    const mod = require(HISTORY_MOD);
    // Precondition checked *before* the fixture writes: a future change to the
    // resolver must fail loudly here rather than pollute real user data.
    if (!mod.HISTORY_FILE.startsWith(tmp)) {
      throw new Error(
        `隔离失效：HISTORY_FILE=${mod.HISTORY_FILE} 不在临时目录 ${tmp} 内`
      );
    }
    return fn(mod, tmp);
  } finally {
    // The module writes 1s later and also flushes on `process.on('exit')` —
    // by then the env below is restored, so a leftover batch would land in the
    // real history file. Drain it while still inside the temp home.
    try {
      require(HISTORY_MOD).flushHistorySync();
    } catch {
      /* module already gone from the cache */
    }
    delete require.cache[require.resolve(HISTORY_MOD)];
    delete require.cache[require.resolve(DATA_HOME_MOD)];
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key]; else process.env[key] = val;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('提交→落盘→下次会话 loadHistory 取回(跨会话回溯)', () => {
  withTempHome((mod) => {
    // 上一会话:逐条提交。
    mod.saveHistory(['第一条']);
    mod.saveHistory(['第二条']);
    mod.flushHistorySync(); // 落盘是 1s 防抖，测试里显式冲刷而不是等定时器
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
    mod.flushHistorySync(); // 三次连按只冲刷一次，验证批次不互相覆盖(BUG-66)
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
    mod.flushHistorySync();
    const loaded = mod.loadHistory();
    assert.equal(loaded.length, max);
    assert.equal(loaded[loaded.length - 1], `cmd${max + 9}`); // 最近一条保留
    assert.equal(loaded[0], `cmd${10}`); // 最旧的被截掉
  });
});

test('全量重发的调用方(replSession)在防抖窗口内不产生重复(BUG-66 同族回归)', () => {
  withTempHome((mod) => {
    // replSession 每次保存都重发整份会话历史：批次增长部分不得被写成两份。
    mod.saveHistory(['A', 'B']);
    mod.saveHistory(['A', 'B', 'C']);
    mod.saveHistory(['A', 'B', 'C']);
    mod.flushHistorySync();
    assert.deepEqual(mod.loadHistory(), ['A', 'B', 'C']);
  });
});

test('门控关时(由 hook 注入空 store)走旧行为:不预填、不落盘', () => {
  // hook 在 KHY_TUI_HISTORY_PERSIST=off 时 store=null,既不 load 也不 save。
  // 这里直接验证 mergeHistory 不被调用时的等价物:空持久 → 仅会话内存。
  const sessionOnly = mergeHistory([], ['仅本会话'], 500);
  assert.deepEqual(sessionOnly, ['仅本会话']);
});
