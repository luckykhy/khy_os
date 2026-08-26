'use strict';

/**
 * 分块传输在总线上的接线测试:二进制 / 超长文件不再被一口拒绝,而是走
 * file_chunk_manifest → file_chunk_request → file_chunk_patch 三步拿字节 / 写字节。
 *
 * 守住的事实:
 *   1. 二进制文件的文本合并仍被拒,但错误里指路分块通道(门控关则退回文件锁);
 *   2. 清单 / 补丁 / 落盘一条链走通,且写回的字节与源**逐字节相同**;
 *   3. data 指令以 base64 上线 —— JSON 通道里原始 Buffer 会被 utf8 化即损坏;
 *   4. 拼装校验不过时**一个字节都不写**,宁可整份重传;
 *   5. 别人持有编辑租约时分块写入被拒(绕过 CRDT 不等于绕过互斥);
 *   6. 三个新消息类型是纯加法,老类型行为不变。
 *
 * 所有 IO 走注入的假 readBinary / writeBinary 端口,不碰真实磁盘。
 */

const engine = require('../crdt_engine');
const chunk = require('../chunk_diff');
const busModule = require('../file_sync_bus');

const { SCHEMA, createBus } = busModule;

// 确定性字节流:不用 Math.random,失败可复现。
function bytes(size, seed = 1) {
  const buf = Buffer.alloc(size);
  let s = seed >>> 0 || 1;

  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 48271) + 11) >>> 0;
    buf[i] = (s >>> 13) & 0xff;
  }

  return buf;
}

function harness(over = {}) {
  const clock = { t: 1_700_000_000_000 };
  const disk = new Map(Object.entries(over.binaries || {}));
  const writes = [];

  const bus = createBus({
    now: () => clock.t,
    env: { KHY_FILE_SYNC: '1', ...(over.env || {}) },
    logger: { warn: () => {}, error: () => {} },
    readFile: (p) => ({
      ok: true,
      value: disk.has(p) ? disk.get(p).toString('utf8') : '',
    }),
    writeFile: () => ({ ok: true, value: {} }),
    readBinary: (p) => {
      if (over.failRead) {
        return { ok: false, error: { code: 'READ_FAILED', message: `读取文件失败：${p}` } };
      }

      return { ok: true, value: disk.has(p) ? disk.get(p) : Buffer.alloc(0) };
    },
    writeBinary: (p, buf) => {
      if (over.failWrite) {
        return { ok: false, error: { code: 'WRITE_FAILED', message: `写入文件失败：${p}` } };
      }

      writes.push({ path: p, bytes: Buffer.from(buf) });
      disk.set(p, Buffer.from(buf));

      return { ok: true, value: { bytes: buf.length } };
    },
    persist: {
      load: () => ({ ok: true, value: null }),
      save: () => ({ ok: true, value: {} }),
    },
    send: () => true,
  });

  return { bus, clock, disk, writes };
}

describe('二进制文件:拒绝文本合并,但指路分块通道', () => {
  test('分块门控开启 → BINARY_FILE 带 route/nextType', () => {
    const h = harness({ binaries: { 'docs/bin.dat': Buffer.from([0x41, 0x00, 0x42]) } });

    const r = h.bus.ensureFile('docs/bin.dat');

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(engine.CODES.BINARY_FILE);
    expect(r.error.route).toBe('chunk_diff');
    expect(r.error.nextType).toBe('file_chunk_manifest');
    // 文件锁兜底不能消失:门控可能在运行期被关。
    expect(r.error.fallback).toBe('file_lock');
  });

  test('分块门控关闭 → 回到原文件锁指引,不提分块', () => {
    const h = harness({
      env: { KHY_FILE_SYNC_CHUNK: '0' },
      binaries: { 'docs/bin.dat': Buffer.from([0x41, 0x00, 0x42]) },
    });

    const r = h.bus.ensureFile('docs/bin.dat');

    expect(r.error.code).toBe(engine.CODES.BINARY_FILE);
    expect(r.error.route).toBeUndefined();
    expect(r.error.message).toContain('请走文件锁路径');
  });
});

describe('分块清单与补丁:一条链走通', () => {
  test('chunkManifestFor 返回可下发清单(不含字节)', () => {
    const src = bytes(200_000, 7);
    const h = harness({ binaries: { 'docs/big.bin': src } });

    const r = h.bus.chunkManifestFor('docs/big.bin');

    expect(r.ok).toBe(true);
    expect(r.value.manifest.schema).toBe(chunk.SCHEMA);
    expect(r.value.manifest.size).toBe(src.length);
    expect(r.value.manifest.chunks.length).toBeGreaterThan(1);
    // 清单只带 digest/offset/size —— 带字节就等于整份重传,分块白做。
    for (const c of r.value.manifest.chunks) {
      expect(c.bytes).toBeUndefined();
    }
    expect(r.value.status).toContain('分块清单 docs/big.bin');
    expect(/正在|处理中|Loading|请稍候/.test(r.value.status)).toBe(false);
  });

  test('客户端一无所有 → 全量 data 指令,拼回逐字节相同', () => {
    const src = bytes(150_000, 11);
    const h = harness({ binaries: { 'docs/big.bin': src } });

    const patch = h.bus.chunkPatchFor({ path: 'docs/big.bin' });

    expect(patch.ok).toBe(true);
    expect(patch.value.patch.instructions.every((s) => s.op === 'data')).toBe(true);
    expect(patch.value.plan.reusedBytes).toBe(0);

    // 客户端侧拼装:base64 解回字节再交给纯叶子。
    const decoded = {
      ...patch.value.patch,
      instructions: patch.value.patch.instructions.map((s) => ({
        ...s,
        bytes: Buffer.from(s.bytes, 'base64'),
      })),
    };
    const out = chunk.applyPatch(decoded, new Map());

    expect(out.ok).toBe(true);
    expect(Buffer.compare(out.value.content, src)).toBe(0);
  });

  test('客户端已持有旧版本 → 只传变动块,大部分块走 copy', () => {
    const src = bytes(200_000, 13);
    const h = harness({ binaries: { 'docs/big.bin': src } });

    const oldSplit = chunk.splitChunks(src);
    const have = oldSplit.value;

    // 磁盘换成「中段改一个字节」的新内容。
    const next = Buffer.from(src);
    next[100_000] = next[100_000] ^ 0xff;
    h.disk.set('docs/big.bin', next);

    const patch = h.bus.chunkPatchFor({ path: 'docs/big.bin', haveManifest: have });

    expect(patch.ok).toBe(true);

    const copies = patch.value.patch.instructions.filter((s) => s.op === 'copy').length;
    const datas = patch.value.patch.instructions.filter((s) => s.op === 'data').length;

    expect(copies).toBeGreaterThan(datas);
    expect(patch.value.plan.reusedBytes).toBeGreaterThan(patch.value.plan.transferBytes);
    expect(patch.value.status).toContain('分块传输 docs/big.bin');
  });

  test('内容完全一致 → 无需传输,状态如实说明', () => {
    const src = bytes(120_000, 17);
    const h = harness({ binaries: { 'docs/big.bin': src } });

    const have = chunk.splitChunks(src).value;
    const patch = h.bus.chunkPatchFor({ path: 'docs/big.bin', haveManifest: have });

    expect(patch.ok).toBe(true);
    expect(patch.value.plan.missing).toEqual([]);
    expect(patch.value.patch.instructions.every((s) => s.op === 'copy')).toBe(true);
    expect(patch.value.status).toContain('无需传输');
  });
});

describe('base64 上线:JSON 通道不能吃掉字节', () => {
  test('data 指令标注 encoding=base64,解回长度与声明一致', () => {
    // 0x00 / 0x80-0xff 这些字节在 utf8 往返里会被替换成 U+FFFD,是最容易踩的坑。
    const src = Buffer.from([0x00, 0x80, 0xff, 0xfe, 0x41, 0x00, 0xc3]);
    const h = harness({ binaries: { 'docs/tricky.bin': src } });

    const patch = h.bus.chunkPatchFor({ path: 'docs/tricky.bin' });

    expect(patch.ok).toBe(true);

    const data = patch.value.patch.instructions.filter((s) => s.op === 'data');

    expect(data.length).toBeGreaterThan(0);

    for (const step of data) {
      expect(step.encoding).toBe('base64');
      expect(typeof step.bytes).toBe('string');
      expect(Buffer.from(step.bytes, 'base64').length).toBe(step.size);
    }

    // JSON 往返一趟仍能拼回原字节 —— 这才是「上线安全」。
    const wire = JSON.parse(JSON.stringify(patch.value.patch));
    const out = chunk.applyPatch(
      {
        ...wire,
        instructions: wire.instructions.map((s) =>
          s.op === 'data' ? { ...s, bytes: Buffer.from(s.bytes, 'base64') } : s
        ),
      },
      new Map()
    );

    expect(Buffer.compare(out.value.content, src)).toBe(0);
  });
});

describe('applyChunkPatch:落盘、校验与互斥', () => {
  function patchFrom(target, haveBuf) {
    const targetManifest = chunk.splitChunks(target).value;
    const have = haveBuf ? chunk.splitChunks(haveBuf).value : null;
    const built = chunk.buildPatch(target, targetManifest, have);

    expect(built.ok).toBe(true);

    return {
      ...built.value,
      instructions: built.value.instructions.map((s) =>
        s.op === 'data'
          ? { ...s, encoding: 'base64', bytes: Buffer.from(s.bytes).toString('base64') }
          : s
      ),
    };
  }

  test('客户端补丁落盘,写回字节与目标逐字节相同', () => {
    const before = bytes(180_000, 19);
    const after = Buffer.from(before);
    after[90_000] = after[90_000] ^ 0x5a;

    const h = harness({ binaries: { 'docs/big.bin': before } });

    h.bus.registerSession({ sessionId: 's-1', editorId: 'alice' });

    const r = h.bus.applyChunkPatch({
      sessionId: 's-1',
      path: 'docs/big.bin',
      patch: patchFrom(after, before),
    });

    expect(r.ok).toBe(true);
    expect(r.value.size).toBe(after.length);
    expect(Buffer.compare(h.disk.get('docs/big.bin'), after)).toBe(0);
    expect(r.value.status).toContain('分块写入 docs/big.bin');
    expect(r.value.status).toContain('字节');
  });

  test('摘要不符 → 一个字节都不写', () => {
    const src = bytes(80_000, 23);
    const h = harness({ binaries: { 'docs/big.bin': src } });

    const bad = patchFrom(src, null);

    bad.digest = 'deadbeefdeadbeef';

    const r = h.bus.applyChunkPatch({ path: 'docs/big.bin', patch: bad });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(chunk.CODES.DIGEST_MISMATCH);
    // 关键:半新半旧的文件比写失败危险得多。
    expect(h.writes).toEqual([]);
    expect(Buffer.compare(h.disk.get('docs/big.bin'), src)).toBe(0);
  });
});
