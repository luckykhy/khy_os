'use strict';

/**
 * file_sync_wiring 回归测试:验证文件级实时同步真的接在**真实的** aiManagementServer 上,
 * 而不只是总线自测里通过。三条要守住的事实:
 *   1. file_* / subscribe_files / unsubscribe_files 被 default 分支之前认领掉;
 *   2. 一切老消息类型(终端流、桌面帧、任务轮询、auth、ping…)照旧穿透,零影响;
 *   3. 断线立即释放编辑租约与订阅,异常退出不会永久占用编辑状态。
 *
 * 数据落点由 jest.taskStoreIsolation.setup.js 钉到临时目录(KHY_DATA_HOME /
 * KHY_PROJECT_DATA_HOME),所以注册表快照不会碰真实工程目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const server = require('../aiManagementServer');

const wiring = server.__test__;

// 假 ws:只要 readyState 与 send,足以让 wsSend 与 send 端口跑通真实分支。
function fakeSocket() {
  const sent = [];

  return {
    readyState: 1, // WebSocket.OPEN
    send: (text) => sent.push(JSON.parse(text)),
    sent,
    close: () => {
      /* not used */
    },
  };
}

function joinSession(id, editorId) {
  const ws = fakeSocket();
  const session = { id, ws, authenticated: true, user: { username: editorId } };

  wiring._sessionsForTest().set(id, session);
  wiring._getFileSyncBus().registerSession({ sessionId: id, editorId });

  return session;
}

function leaveSession(id) {
  wiring._fileSyncDropSession(id);
  wiring._sessionsForTest().delete(id);
}

function typesOf(session, type) {
  return session.ws.sent.filter((m) => !type || m.type === type);
}

// 每个用例一个独立文件名,避免同一进程内互相污染。
let workDir = '';
let relPath = '';
let seq = 0;
let originalCwd = '';

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fsync-wiring-'));
  fs.mkdirSync(path.join(workDir, 'docs'), { recursive: true });
  // 总线的 projectDir 取自 process.cwd() 且在懒建时固化 —— 必须在首次取总线前切过去。
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

beforeEach(() => {
  seq += 1;
  relPath = `docs/w${seq}.md`;
  fs.writeFileSync(path.join(workDir, relPath), 'hello', 'utf8');
});

describe('file_sync 接线:总线可用性', () => {
  test('总线懒建成功且被记忆(同一进程一个总线)', () => {
    const first = wiring._getFileSyncBus();
    const second = wiring._getFileSyncBus();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(first.stats().value.enabled).toBe(true);
    expect(first.stats().value.yjs).toBe(true);
  });
});

describe('file_sync 接线:向后兼容(老消息类型必须穿透)', () => {
  test.each([
    ['auth'],
    ['ping'],
    ['terminal_input'],
    ['terminal_stream'],
    ['terminal_resize'],
    ['khyos_desktop_frame'],
    ['khyos_input'],
    ['task_poll'],
    ['chat'],
    ['subscribe'],
  ])('%s 不被认领 → 交回既有 switch', (type) => {
    const session = joinSession(`legacy-${type}`, 'legacy');

    try {
      expect(wiring._handleFileSyncMessage(session, { type })).toBe(false);
      expect(session.ws.sent).toEqual([]);
    } finally {
      leaveSession(`legacy-${type}`);
    }
  });

  test('坏消息(null / 空 / 无 type)一律不被认领,不抛', () => {
    const session = joinSession('legacy-bad', 'legacy');

    try {
      expect(wiring._handleFileSyncMessage(session, null)).toBe(false);
      expect(wiring._handleFileSyncMessage(session, {})).toBe(false);
      expect(wiring._handleFileSyncMessage(session, { type: '' })).toBe(false);
      expect(wiring._handleFileSyncMessage(session, { type: 42 })).toBe(false);
      expect(session.ws.sent).toEqual([]);
    } finally {
      leaveSession('legacy-bad');
    }
  });

  test('未认证会话的 file_op 被认领并结构化拒绝(不落盘、不建状态)', () => {
    const ws = fakeSocket();
    const session = { id: 'anon-1', ws, authenticated: false };

    expect(wiring._handleFileSyncMessage(session, { type: 'file_op', path: relPath })).toBe(true);

    const reply = typesOf(session, 'file_op_result')[0];

    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('UNAUTHENTICATED_SESSION');
    expect(fs.readFileSync(path.join(workDir, relPath), 'utf8')).toBe('hello');
  });
});

describe('file_sync 接线:真实模块上的端到端最小路径', () => {
  test('两实例同基线提交 → 确定性合并 → 双方各收到两条 file_changed', () => {
    const a = joinSession('wire-a', 'alice');
    const b = joinSession('wire-b', 'bob');

    try {
      for (const s of [a, b]) {
        expect(
          wiring._handleFileSyncMessage(s, { type: 'subscribe_files', paths: [relPath] })
        ).toBe(true);
        expect(typesOf(s, 'file_subscribed')[0].ok).toBe(true);
      }

      a.ws.sent.length = 0;
      b.ws.sent.length = 0;

      // 两边都声明 baseVersion=0(都读到 v0),位置不重叠。
      expect(
        wiring._handleFileSyncMessage(a, {
          type: 'file_op',
          path: relPath,
          opId: 'wire-op-a',
          baseVersion: 0,
          operations: [{ insert: '[', position: 0 }],
        })
      ).toBe(true);

      expect(
        wiring._handleFileSyncMessage(b, {
          type: 'file_op',
          path: relPath,
          opId: 'wire-op-b',
          baseVersion: 0,
          operations: [{ insert: ']', position: 5 }],
        })
      ).toBe(true);

      const aResult = typesOf(a, 'file_op_result')[0];
      const bResult = typesOf(b, 'file_op_result')[0];

      expect(aResult.ok).toBe(true);
      expect(aResult.version).toBe(1);
      expect(bResult.ok).toBe(true);
      expect(bResult.version).toBe(2);

      // 双方都拿到两条增量,而不是整文件广播。
      expect(typesOf(a, 'file_changed').map((m) => m.version)).toEqual([1, 2]);
      expect(typesOf(b, 'file_changed').map((m) => m.version)).toEqual([1, 2]);

      // 磁盘上是合并后的确定性结果,不是任何一边的整体覆盖。
      expect(fs.readFileSync(path.join(workDir, relPath), 'utf8')).toBe('[hello]');
    } finally {
      leaveSession('wire-a');
      leaveSession('wire-b');
    }
  });

  test('断线的一方带 lastSeenVersion 重连,只补缺失增量', () => {
    const a = joinSession('wire-c', 'carol');
    const b = joinSession('wire-d', 'dave');

    try {
      for (const s of [a, b]) {
        wiring._handleFileSyncMessage(s, { type: 'subscribe_files', paths: [relPath] });
      }

      wiring._handleFileSyncMessage(a, {
        type: 'file_op',
        path: relPath,
        opId: 'wire-op-c1',
        baseVersion: 0,
        operations: [{ insert: 'A', position: 0 }],
      });

      // A 断线,B 继续提交。
      leaveSession('wire-c');

      wiring._handleFileSyncMessage(b, {
        type: 'file_op',
        path: relPath,
        opId: 'wire-op-d1',
        baseVersion: 1,
        operations: [{ insert: 'B', position: 0 }],
      });

      // A 重连并声明只看到 v1。
      const again = joinSession('wire-c', 'carol');
      const claimed = wiring._handleFileSyncMessage(again, {
        type: 'subscribe_files',
        paths: [relPath],
        lastSeenVersions: { [relPath]: 1 },
      });

      expect(claimed).toBe(true);

      const sub = typesOf(again, 'file_subscribed')[0];
      const entry = sub.results.find((f) => f.path === relPath);

      expect(entry.increments.map((i) => i.version)).toEqual([2]);
      expect(entry.resync).toBeFalsy();

      // 补齐后可以直接继续提交。
      wiring._handleFileSyncMessage(again, {
        type: 'file_op',
        path: relPath,
        opId: 'wire-op-c2',
        baseVersion: 2,
        operations: [{ insert: 'C', position: 0 }],
      });

      expect(typesOf(again, 'file_op_result')[0].version).toBe(3);
      expect(fs.readFileSync(path.join(workDir, relPath), 'utf8')).toBe('CBAhello');
    } finally {
      leaveSession('wire-c');
      leaveSession('wire-d');
    }
  });

  test('租约:申请 → 断线立即释放 → 另一实例马上接手(不等 TTL)', () => {
    const a = joinSession('wire-e', 'erin');
    const b = joinSession('wire-f', 'frank');

    try {
      expect(
        wiring._handleFileSyncMessage(a, { type: 'file_lease', path: relPath, action: 'acquire' })
      ).toBe(true);

      const leased = typesOf(a, 'file_lease_state')[0];

      expect(leased.ok).toBe(true);
      expect(leased.lease.sessionId).toBe('wire-e');

      // 他人此刻拿不到。
      wiring._handleFileSyncMessage(b, { type: 'file_lease', path: relPath, action: 'acquire' });
      expect(typesOf(b, 'file_lease_state')[0].ok).toBe(false);

      // 断线立即释放,不等租约 TTL 走完。
      leaveSession('wire-e');
      b.ws.sent.length = 0;

      wiring._handleFileSyncMessage(b, { type: 'file_lease', path: relPath, action: 'acquire' });

      const taken = typesOf(b, 'file_lease_state')[0];

      expect(taken.ok).toBe(true);
      expect(taken.lease.sessionId).toBe('wire-f');
    } finally {
      leaveSession('wire-e');
      leaveSession('wire-f');
    }
  });

  test('未知 file_* 类型被认领并给出支持列表,不落到 Unknown message type', () => {
    const session = joinSession('wire-g', 'gina');

    try {
      expect(wiring._handleFileSyncMessage(session, { type: 'file_teleport' })).toBe(true);

      const reply = session.ws.sent[0];

      expect(reply.ok).toBe(false);
      expect(reply.error.code).toBe('UNKNOWN_FILE_SYNC_TYPE');
      expect(reply.error.message).toContain('subscribe_files');
    } finally {
      leaveSession('wire-g');
    }
  });

  test('丢弃未知会话不抛(异常退出路径 fail-soft)', () => {
    expect(() => wiring._fileSyncDropSession('never-existed')).not.toThrow();
    expect(() => wiring._fileSyncDropSession(undefined)).not.toThrow();
  });
});
