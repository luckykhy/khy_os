'use strict';

/**
 * 跨实例共享注册表的端到端回归:两个**独立的** bus 实例(模拟两个 Node 进程)共用
 * 同一份快照文件,验证「跨进程事实不只活在单个进程内存里」这条要求真的成立。
 *
 * 守住的事实:
 *   1. A 保存后 B 调 syncRegistry() 能看见 A 的会话与订阅者;
 *   2. 双方交替保存不会互相覆盖(读-合并-写,而非 last-writer-wins);
 *   3. A 持有的租约在 B 侧可见,B 抢不到;
 *   4. 快照文件损坏 / 目录不可写时 fail-soft,总线照常工作。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const busModule = require('../file_sync_bus');

// 共享快照端口:两个 bus 指向同一文件,复刻真实的跨进程读-合并-写。
function sharedPersist(file) {
  return {
    load() {
      try {
        return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        return { ok: true, value: null };
      }
    },
    save(state, options = {}) {
      const merge = typeof options.merge === 'function' ? options.merge : null;
      let outgoing = state;

      if (merge) {
        let onDisk = null;

        try {
          onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          onDisk = null;
        }

        outgoing = merge(onDisk) || state;
      }

      fs.writeFileSync(file, JSON.stringify(outgoing), 'utf8');

      return { ok: true, value: { file } };
    },
  };
}

let workDir = '';
let snapFile = '';
let seq = 0;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fsync-cross-'));
  fs.mkdirSync(path.join(workDir, 'docs'), { recursive: true });
});

afterAll(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

beforeEach(() => {
  seq += 1;
  snapFile = path.join(workDir, `registry-${seq}.json`);
});

function makeBus(instanceId) {
  return busModule.createBus({
    projectDir: workDir,
    instanceId,
    persist: sharedPersist(snapFile),
    send: () => true,
  });
}

describe('跨实例注册表:并集可见性', () => {
  test('A 的会话与订阅在 B 侧可见(syncRegistry 后)', () => {
    const busA = makeBus('inst-A');
    const busB = makeBus('inst-B');

    expect(busA.registerSession({ sessionId: 's-a', editorId: 'alice' }).ok).toBe(true);
    expect(busA.subscribeFiles({ sessionId: 's-a', paths: ['docs/shared.md'] }).ok).toBe(true);

    // B 尚未对齐,看不到 A。
    expect(busB.stats().value.sessions).toBe(0);

    const synced = busB.syncRegistry();

    expect(synced.ok).toBe(true);
    expect(synced.value.synced).toBe(true);
    // 状态文本必须是「动作 + 目标 + 进度」,不是「正在同步…」。
    expect(synced.value.detail).toContain('已对齐共享注册表');
    expect(synced.value.detail).toMatch(/新增会话 \d+ 个/);
    expect(busB.stats().value.sessions).toBe(1);
  });

  test('双方交替保存不互相覆盖', () => {
    const busA = makeBus('inst-A');
    const busB = makeBus('inst-B');

    busA.registerSession({ sessionId: 's-a', editorId: 'alice' });
    busB.registerSession({ sessionId: 's-b', editorId: 'bob' });

    // B 后写。若是 last-writer-wins,A 的会话此刻已被抹掉。
    busA.syncRegistry();
    busB.syncRegistry();
    busB.registerSession({ sessionId: 's-b2', editorId: 'bob' });

    const onDisk = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    const ids = onDisk.sessions.map((s) => s.sessionId).sort();

    expect(ids).toEqual(['s-a', 's-b', 's-b2']);
  });

  test('A 持有的租约在 B 侧可见且 B 抢不到', () => {
    const busA = makeBus('inst-A');
    const busB = makeBus('inst-B');

    busA.registerSession({ sessionId: 's-a', editorId: 'alice' });
    expect(busA.lease({ path: 'docs/leased.md', sessionId: 's-a', action: 'acquire' }).ok).toBe(
      true
    );

    busB.registerSession({ sessionId: 's-b', editorId: 'bob' });
    busB.syncRegistry();

    const taken = busB.lease({ path: 'docs/leased.md', sessionId: 's-b', action: 'acquire' });

    expect(taken.ok).toBe(false);
    expect(taken.error.code).toBe('LEASE_HELD');
    expect(taken.error.holderSessionId).toBe('s-a');
  });

  test('A 断线后 B 对齐即可接手(不等 TTL)', () => {
    const busA = makeBus('inst-A');
    const busB = makeBus('inst-B');

    busA.registerSession({ sessionId: 's-a', editorId: 'alice' });
    busA.lease({ path: 'docs/handoff.md', sessionId: 's-a', action: 'acquire' });

    busB.registerSession({ sessionId: 's-b', editorId: 'bob' });
    busA.handleDisconnect('s-a');
    busB.syncRegistry();

    expect(
      busB.lease({ path: 'docs/handoff.md', sessionId: 's-b', action: 'acquire' }).ok
    ).toBe(true);
  });
});

describe('跨实例注册表:fail-soft', () => {
  test('快照文件损坏 → syncRegistry 报告未对齐,总线照常工作', () => {
    fs.writeFileSync(snapFile, '{ this is not json', 'utf8');

    const bus = makeBus('inst-A');
    const synced = bus.syncRegistry();

    expect(synced.ok).toBe(true);
    expect(synced.value.synced).toBe(false);
    expect(typeof synced.value.detail).toBe('string');

    // 损坏的快照不影响本实例注册与订阅。
    expect(bus.registerSession({ sessionId: 's-a', editorId: 'alice' }).ok).toBe(true);
    expect(bus.subscribeFiles({ sessionId: 's-a', paths: ['docs/ok.md'] }).ok).toBe(true);
  });

  test('save 抛异常 → 注册仍成功(持久化失败不阻断编辑)', () => {
    const bus = busModule.createBus({
      projectDir: workDir,
      instanceId: 'inst-A',
      persist: {
        load: () => ({ ok: true, value: null }),
        save: () => {
          throw new Error('disk on fire');
        },
      },
      send: () => true,
    });

    expect(bus.registerSession({ sessionId: 's-a', editorId: 'alice' }).ok).toBe(true);
    expect(bus.stats().value.sessions).toBe(1);
  });

  test('未配置 persist 端口时 syncRegistry 不崩', () => {
    const bus = busModule.createBus({
      projectDir: workDir,
      instanceId: 'inst-A',
      persist: { load: null, save: null },
      send: () => true,
    });

    const synced = bus.syncRegistry();

    expect(synced.ok).toBe(true);
    expect(synced.value.synced).toBe(false);
  });

  test('instanceId 缺省时回落到 pid,且对外可读', () => {
    const bus = busModule.createBus({ projectDir: workDir, send: () => true });

    expect(bus.instanceId).toBe(`pid-${process.pid}`);
  });

  test('KHY_FILE_SYNC_INSTANCE_ID 环境变量可覆盖', () => {
    const bus = busModule.createBus({
      projectDir: workDir,
      env: { ...process.env, KHY_FILE_SYNC_INSTANCE_ID: 'from-env' },
      send: () => true,
    });

    expect(bus.instanceId).toBe('from-env');
  });
});
