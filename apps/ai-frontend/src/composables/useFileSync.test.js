/**
 * useFileSync 客户端契约测试。
 *
 * 覆盖后端 file_sync_bus(T-008)约定的客户端一侧:增量应用、opId 幂等、
 * 版本缺口不半应用、resync 覆盖增量、冲突不动本地文本、租约状态、
 * 以及「非 file_* 帧必须交回宿主 view」这条向后兼容红线。
 *
 * 纯逻辑,不开真实 socket:
 *   npx vitest run src/composables/useFileSync.test.js
 */
import { describe, test, expect } from 'vitest';
import {
  applyOperations,
  applyEvent,
  createFileState,
  buildSubscribeFrame,
  isFileSyncMessage,
  useFileSync,
  FILE_SYNC_SCHEMA,
} from './useFileSync.js';

function changed(path, version, baseVersion, opId, operations) {
  return {
    type: 'file_changed',
    schema: FILE_SYNC_SCHEMA,
    path,
    version,
    baseVersion,
    opId,
    editor: 'alice',
    sessionId: 's-1',
    operations,
    timestamp: 1,
  };
}

describe('applyOperations:文本操作应用', () => {
  test('单个 insert 落在指定位置', () => {
    expect(applyOperations('hello', [{ insert: '[', position: 0 }])).toBe('[hello');
  });

  test('多个 insert 从右往左应用,前面的偏移不被后面的破坏', () => {
    const out = applyOperations('hello', [
      { insert: '[', position: 0 },
      { insert: ']', position: 5 },
    ]);
    expect(out).toBe('[hello]');
  });

  test('delete 支持数字长度与 range 两种写法', () => {
    expect(applyOperations('hello', [{ delete: 2, position: 0 }])).toBe('llo');
    expect(applyOperations('hello', [{ range: { start: 1, end: 3 } }])).toBe('hlo');
  });

  test('越界位置被忽略而不是抛错', () => {
    expect(applyOperations('hi', [{ insert: 'x', position: 99 }])).toBe('hi');
    expect(applyOperations('hi', [{ insert: 'x', position: -1 }])).toBe('hi');
  });

  test('坏操作(null / 非对象 / 空数组)不改动文本', () => {
    expect(applyOperations('hi', [null, 42, undefined])).toBe('hi');
    expect(applyOperations('hi', [])).toBe('hi');
    expect(applyOperations('hi', null)).toBe('hi');
  });
});

describe('applyEvent:file_changed 增量', () => {
  test('按版本推进并应用增量', () => {
    const files = { 'a.md': { ...createFileState('a.md'), text: 'hello' } };
    const r = applyEvent(files, changed('a.md', 1, 0, 'op-1', [{ insert: '[', position: 0 }]));

    expect(r.ok).toBe(true);
    expect(r.value.changed).toBe(true);
    expect(files['a.md'].text).toBe('[hello');
    expect(files['a.md'].version).toBe(1);
  });

  test('重复 opId 不二次应用(幂等)', () => {
    const files = { 'a.md': { ...createFileState('a.md'), text: 'hello' } };
    const ev = changed('a.md', 1, 0, 'op-dup', [{ insert: 'X', position: 0 }]);

    applyEvent(files, ev);
    const again = applyEvent(files, { ...ev, version: 2 });

    expect(again.value.changed).toBe(false);
    expect(files['a.md'].text).toBe('Xhello');
  });

  test('旧版本回放被丢弃', () => {
    const files = { 'a.md': { ...createFileState('a.md'), text: 'hello', version: 5 } };
    const r = applyEvent(files, changed('a.md', 3, 2, 'op-old', [{ insert: 'Z', position: 0 }]));

    expect(r.value.changed).toBe(false);
    expect(files['a.md'].text).toBe('hello');
    expect(files['a.md'].version).toBe(5);
  });

  test('版本缺口不半应用,登记 VERSION_GAP 待补齐', () => {
    const files = { 'a.md': { ...createFileState('a.md'), text: 'hello', version: 1 } };
    const r = applyEvent(files, changed('a.md', 9, 8, 'op-gap', [{ insert: 'G', position: 0 }]));

    expect(r.value.changed).toBe(false);
    expect(files['a.md'].text).toBe('hello');
    expect(files['a.md'].version).toBe(1);
    expect(files['a.md'].lastError.code).toBe('VERSION_GAP');
  });

  test('同基线两条不重叠增量顺序到达 → 与服务端一致的确定性结果', () => {
    const files = { 'a.md': { ...createFileState('a.md'), text: 'hello' } };

    applyEvent(files, changed('a.md', 1, 0, 'op-a', [{ insert: '[', position: 0 }]));
    applyEvent(files, changed('a.md', 2, 1, 'op-b', [{ insert: ']', position: 6 }]));

    expect(files['a.md'].text).toBe('[hello]');
    expect(files['a.md'].version).toBe(2);
  });
});

describe('applyEvent:重同步与补偿', () => {
  test('file_resync_required 覆盖本地文本并清空去重环', () => {
    const files = { 'a.md': { ...createFileState('a.md'), text: 'stale', version: 2 } };
    files['a.md'].seenOpIds = ['op-old'];

    const r = applyEvent(files, {
      type: 'file_resync_required',
      schema: FILE_SYNC_SCHEMA,
      path: 'a.md',
      version: 7,
      reason: '历史已淘汰',
      text: 'fresh',
      timestamp: 9,
    });

    expect(r.ok).toBe(true);
    expect(files['a.md'].text).toBe('fresh');
    expect(files['a.md'].version).toBe(7);
    expect(files['a.md'].seenOpIds).toEqual([]);
    expect(files['a.md'].resyncedAt).toBe(9);
  });

  test('file_subscribed 带 increments 时逐条补齐', () => {
    const files = { 'a.md': { ...createFileState('a.md'), text: 'hello', version: 1 } };

    const r = applyEvent(files, {
      type: 'file_subscribed',
      schema: FILE_SYNC_SCHEMA,
      ok: true,
      results: [
        {
          path: 'a.md',
          ok: true,
          version: 2,
          increments: [changed('a.md', 2, 1, 'op-inc', [{ insert: '!', position: 5 }])],
        },
      ],
    });

    expect(r.ok).toBe(true);
    expect(files['a.md'].subscribed).toBe(true);
    expect(files['a.md'].text).toBe('hello!');
    expect(files['a.md'].version).toBe(2);
  });

  test('file_subscribed 里 resync 优先于 increments', () => {
    const files = { 'a.md': { ...createFileState('a.md'), text: 'x', version: 1 } };

    applyEvent(files, {
      type: 'file_subscribed',
      schema: FILE_SYNC_SCHEMA,
      ok: true,
      results: [
        {
          path: 'a.md',
          ok: true,
          resync: { path: 'a.md', version: 12, text: 'authoritative', timestamp: 3 },
          increments: [changed('a.md', 2, 1, 'op-ignored', [{ insert: 'NO', position: 0 }])],
        },
      ],
    });

    expect(files['a.md'].text).toBe('authoritative');
    expect(files['a.md'].version).toBe(12);
  });

  test('file_catch_up_result 的增量与 resync 分支都可用', () => {
    const files = { 'a.md': { ...createFileState('a.md'), text: 'hello', version: 1 } };

    applyEvent(files, {
      type: 'file_catch_up_result',
      schema: FILE_SYNC_SCHEMA,
      ok: true,
      path: 'a.md',
      increments: [changed('a.md', 2, 1, 'op-cu', [{ insert: '?', position: 5 }])],
    });
    expect(files['a.md'].text).toBe('hello?');

    applyEvent(files, {
      type: 'file_catch_up_result',
      schema: FILE_SYNC_SCHEMA,
      ok: true,
      path: 'a.md',
      resync: { path: 'a.md', version: 20, text: 'reset' },
    });
    expect(files['a.md'].version).toBe(20);
  });
});

describe('applyEvent:冲突、租约与降级', () => {
  test('MERGE_CONFLICT 不改动本地文本,只登记错误', () => {
    const files = { 'a.md': { ...createFileState('a.md'), text: 'mine', version: 3 } };

    const r = applyEvent(files, {
      type: 'file_op_result',
      schema: FILE_SYNC_SCHEMA,
      ok: false,
      path: 'a.md',
      opId: 'op-x',
      error: { code: 'MERGE_CONFLICT', message: '文件存在重叠编辑冲突' },
    });

    expect(r.ok).toBe(true);
    expect(files['a.md'].text).toBe('mine');
    expect(files['a.md'].version).toBe(3);
    expect(files['a.md'].lastError.code).toBe('MERGE_CONFLICT');
  });

  test('自己的 op 被接受后,广播回来的同一 opId 不重复应用', () => {
    const files = { 'a.md': { ...createFileState('a.md'), text: 'hello' } };

    applyEvent(files, {
      type: 'file_op_result',
      schema: FILE_SYNC_SCHEMA,
      ok: true,
      path: 'a.md',
      opId: 'op-self',
      version: 1,
      baseVersion: 0,
    });

    const echo = applyEvent(
      files,
      changed('a.md', 2, 0, 'op-self', [{ insert: 'DUP', position: 0 }])
    );

    expect(echo.value.changed).toBe(false);
    expect(files['a.md'].text).toBe('hello');
  });

  test('MERGE_FALLBACK 带的 file_lock_state 被记录', () => {
    const files = {};

    applyEvent(files, {
      type: 'file_lock_state',
      schema: FILE_SYNC_SCHEMA,
      ok: true,
      path: 'a.md',
      lock: { holder: 'bob', mode: 'file_lock' },
    });

    expect(files['a.md'].lockedBy.holder).toBe('bob');
  });

  test('租约获取成功记录持有者,被拒时清空', () => {
    const files = {};

    applyEvent(files, {
      type: 'file_lease_state',
      schema: FILE_SYNC_SCHEMA,
      ok: true,
      path: 'a.md',
      lease: { sessionId: 's-1', editorId: 'alice' },
    });
    expect(files['a.md'].lease.sessionId).toBe('s-1');

    applyEvent(files, {
      type: 'file_lease_state',
      schema: FILE_SYNC_SCHEMA,
      ok: false,
      path: 'a.md',
      error: { code: 'LEASE_HELD', message: '编辑租约被他人持有' },
    });
    expect(files['a.md'].lease).toBe(null);
    expect(files['a.md'].lastError.code).toBe('LEASE_HELD');
  });
});

describe('向后兼容:非 file_* 帧必须交回宿主', () => {
  test.each([
    ['auth_ok'],
    ['khyos_data'],
    ['khyos_status'],
    ['terminal_stream'],
    ['task_poll'],
    ['chat'],
    ['error'],
  ])('%s 不被 isFileSyncMessage 认领', (type) => {
    expect(isFileSyncMessage({ type })).toBe(false);
  });

  test('坏帧不被认领且 applyEvent 不抛', () => {
    for (const bad of [null, undefined, {}, { type: '' }, { type: 42 }]) {
      expect(isFileSyncMessage(bad)).toBe(false);
      expect(() => applyEvent({}, bad)).not.toThrow();
      expect(applyEvent({}, bad).ok).toBe(false);
    }
  });

  test('handleMessage 对非同步帧返回 false,让 view 走原 switch', () => {
    const sync = useFileSync({ send: () => {} });

    expect(sync.handleMessage({ type: 'khyos_data', data: 'x' })).toBe(false);
    expect(sync.handleMessage({ type: 'auth_ok' })).toBe(false);
    expect(sync.handleMessage(changed('a.md', 1, 0, 'op-1', []))).toBe(true);
  });
});

describe('useFileSync:发帧与状态', () => {
  function harness() {
    const sent = [];
    const sync = useFileSync({ send: (frame) => sent.push(frame), sessionTag: 't' });
    sync.attach((frame) => sent.push(frame));
    return { sync, sent };
  }

  test('subscribe 带上已持有版本,重连只要增量', () => {
    const { sync, sent } = harness();

    sync.files.value['a.md'] = { ...createFileState('a.md'), version: 4 };
    sync.subscribe(['a.md', 'b.md']);

    expect(sent[0].type).toBe('subscribe_files');
    expect(sent[0].paths).toEqual(['a.md', 'b.md']);
    expect(sent[0].lastSeenVersions).toEqual({ 'a.md': 4 });
  });

  test('submitOps 声明本地实际版本作为 baseVersion,并带唯一 opId', () => {
    const { sync, sent } = harness();

    sync.files.value['a.md'] = { ...createFileState('a.md'), version: 6 };
    sync.submitOps('a.md', [{ insert: 'x', position: 0 }]);
    sync.submitOps('a.md', [{ insert: 'y', position: 0 }]);

    expect(sent[0].baseVersion).toBe(6);
    expect(sent[0].type).toBe('file_op');
    expect(sent[1].opId).not.toBe(sent[0].opId);
  });

  test('租约三个动作发出正确 action', () => {
    const { sync, sent } = harness();

    sync.acquireLease('a.md');
    sync.renewLease('a.md');
    sync.releaseLease('a.md');

    expect(sent.map((f) => f.action)).toEqual(['acquire', 'renew', 'release']);
    expect(sent.every((f) => f.type === 'file_lease')).toBe(true);
  });

  test('未连接时发帧 fail-soft,不抛', () => {
    const sync = useFileSync({});

    expect(sync.connected.value).toBe(false);
    const r = sync.subscribe(['a.md']);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('NOT_CONNECTED');
  });

  test('send 抛异常被吞成结构化错误', () => {
    const sync = useFileSync({
      send: () => {
        throw new Error('socket closed');
      },
    });
    sync.attach(() => {
      throw new Error('socket closed');
    });

    const r = sync.catchUp('a.md');
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('SEND_FAILED');
    expect(r.error.message).toContain('file_catch_up');
  });

  test('detach 清掉本地租约与订阅(镜像服务端断线释放)', () => {
    const { sync } = harness();

    sync.files.value['a.md'] = {
      ...createFileState('a.md'),
      subscribed: true,
      lease: { sessionId: 's-1' },
    };
    sync.detach();

    expect(sync.connected.value).toBe(false);
    expect(sync.files.value['a.md'].lease).toBe(null);
    expect(sync.files.value['a.md'].subscribed).toBe(false);
  });

  test('版本缺口自动触发 file_catch_up', () => {
    const { sync, sent } = harness();

    sync.files.value['a.md'] = { ...createFileState('a.md'), text: 'hello', version: 1 };
    sync.handleMessage(changed('a.md', 9, 8, 'op-gap', [{ insert: 'G', position: 0 }]));

    const cu = sent.find((f) => f.type === 'file_catch_up');
    expect(cu).toBeTruthy();
    expect(cu.lastSeenVersion).toBe(1);
  });

  test('statusText 含动作+目标+进度,不出现「处理中 / Loading」', () => {
    const { sync } = harness();

    expect(sync.statusText.value).toContain('尚未订阅文件');

    sync.files.value['a.md'] = { ...createFileState('a.md'), subscribed: true, version: 3 };
    const text = sync.statusText.value;

    expect(text).toContain('a.md v3');
    expect(text).toContain('同步 1 个文件');
    expect(/正在工作|处理中|Loading|请稍候|Processing/.test(text)).toBe(false);
  });
});

describe('buildSubscribeFrame:边界', () => {
  test('过滤空路径,零版本不写进 lastSeenVersions', () => {
    const frame = buildSubscribeFrame({ 'a.md': createFileState('a.md') }, ['a.md', '', null]);

    expect(frame.paths).toEqual(['a.md']);
    expect(frame.lastSeenVersions).toEqual({});
  });

  test('非数组入参不抛', () => {
    expect(buildSubscribeFrame({}, null).paths).toEqual([]);
  });
});
