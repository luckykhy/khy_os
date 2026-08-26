'use strict';

/**
 * chunk_diff 回归测试:二进制/大文件分块传输。
 *
 * 守住的事实:
 *   1. 切块确定(同内容任意进程切出同一批边界),块长落在配置区间内;
 *   2. **内容定义分块真的成立** —— 头部插一个字节后绝大多数块仍可复用,
 *      这条是分块相对「整份重传」唯一的收益来源,退化了就等于白做;
 *   3. copy/data 补丁能把内容逐字节拼回来,缺块 / 摘要不符时报错而非返回半成品;
 *   4. 坏清单、坏补丁、坏字节一律结构化报错,绝不抛;
 *   5. 状态文本是「动作 + 目标 + 进度」(工程红线 2)。
 */

const chunk = require('../chunk_diff');

// 确定性伪随机字节:测试不能依赖 Math.random,否则失败无法复现。
function bytes(size, seed = 1) {
  const buf = Buffer.alloc(size);
  let s = seed >>> 0 || 1;

  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 48271) + 11) >>> 0;
    buf[i] = (s >>> 13) & 0xff;
  }

  return buf;
}

function manifestOf(buf, opts) {
  const out = chunk.splitChunks(buf, opts);

  expect(out.ok).toBe(true);

  return out.value;
}

// 模拟对端块库:digest → 字节。真实实现里这就是本地缓存目录/内存 LRU。
function storeFrom(buf, manifest) {
  return new Map(
    manifest.chunks.map((c) => [c.digest, Buffer.from(buf.subarray(c.offset, c.offset + c.size))])
  );
}

describe('splitChunks:切块形状与确定性', () => {
  test('块偏移连续、长度求和等于原长', () => {
    const buf = bytes(200_000, 7);
    const manifest = manifestOf(buf);

    expect(manifest.schema).toBe(chunk.SCHEMA);
    expect(manifest.size).toBe(buf.length);

    let cursor = 0;

    for (const c of manifest.chunks) {
      expect(c.offset).toBe(cursor);
      cursor += c.size;
    }

    expect(cursor).toBe(buf.length);
  });

  test('同一内容切出完全相同的清单(跨进程可比)', () => {
    const buf = bytes(120_000, 11);

    expect(manifestOf(buf)).toEqual(manifestOf(buf));
  });

  test('块长落在 min/max 之间,且不退化成单块', () => {
    const buf = bytes(200_000, 13);
    const manifest = manifestOf(buf);
    const sizes = manifest.chunks.map((c) => c.size);

    expect(sizes.length).toBeGreaterThan(3);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(chunk.DEFAULT_CHUNK_LIMITS.maxChunkBytes);
    // 末块可以短于 min,其余不行。
    expect(Math.min(...sizes.slice(0, -1))).toBeGreaterThanOrEqual(
      chunk.DEFAULT_CHUNK_LIMITS.minChunkBytes
    );
  });

  test('空内容与超短内容不崩,产出可用清单', () => {
    expect(manifestOf(Buffer.alloc(0)).chunks).toEqual([]);
    expect(manifestOf(Buffer.from('hi')).chunks).toHaveLength(1);
  });

  test('字符串入参按 utf8 处理,与等价 Buffer 结果一致', () => {
    const text = 'khy-os 分块传输'.repeat(500);

    expect(manifestOf(text)).toEqual(manifestOf(Buffer.from(text, 'utf8')));
  });

  test('含空字节的真二进制内容照样能切(不像文本路径那样拒绝)', () => {
    const buf = Buffer.concat([Buffer.alloc(5000), bytes(60_000, 3), Buffer.alloc(5000)]);

    expect(manifestOf(buf).chunks.length).toBeGreaterThan(0);
  });

  test('超出 maxTotalBytes → TOO_LARGE,不抛', () => {
    const out = chunk.splitChunks(bytes(5000, 5), { limits: { maxTotalBytes: 100 } });

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe(chunk.CODES.TOO_LARGE);
  });

  test('块数超上限 → TOO_MANY_CHUNKS,消息给出可调旋钮', () => {
    const out = chunk.splitChunks(bytes(200_000, 9), {
      limits: { minChunkBytes: 1, targetChunkBytes: 2, maxChunkBytes: 8, maxChunks: 4 },
    });

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe(chunk.CODES.TOO_MANY_CHUNKS);
    expect(out.error.message).toContain('KHY_FILE_SYNC_CHUNK_TARGET');
  });

  test('非法入参类型 → INVALID_INPUT,不抛', () => {
    for (const bad of [42, true, {}, []]) {
      const out = chunk.splitChunks(bad);

      expect(out.ok).toBe(false);
      expect(out.error.code).toBe(chunk.CODES.INVALID_INPUT);
    }
  });
});

describe('内容定义分块:局部改动只影响邻近块', () => {
  // 这一组是整个模块的价值所在:若滚动哈希写成循环移位(旧字节永不出窗),
  // 插入一字节会让后面所有边界平移、摘要全变,复用率归零 —— 分块就白做了。
  const base = bytes(200_000, 17);
  const baseManifest = manifestOf(base);
  const baseDigests = new Set(baseManifest.chunks.map((c) => c.digest));

  function reuseRatio(mutated) {
    const diff = chunk.diffManifests(manifestOf(mutated), baseManifest);

    expect(diff.ok).toBe(true);

    return diff.value.savedRatio;
  }

  test('头部插入 1 字节:仍复用绝大多数字节', () => {
    expect(reuseRatio(Buffer.concat([Buffer.from([0x09]), base]))).toBeGreaterThan(0.8);
  });

  test('中部插入一小段:仍复用大部分字节', () => {
    const mutated = Buffer.concat([
      base.subarray(0, 100_000),
      Buffer.from('NEWDATA'),
      base.subarray(100_000),
    ]);

    expect(reuseRatio(mutated)).toBeGreaterThan(0.5);
  });

  test('尾部追加:前面的块全部复用', () => {
    expect(reuseRatio(Buffer.concat([base, Buffer.from([1, 2, 3])]))).toBeGreaterThan(0.8);
  });

  test('单字节原地改写:只有命中的那块需要重传', () => {
    const mutated = Buffer.from(base);

    mutated[150_000] ^= 0xff;

    const diff = chunk.diffManifests(manifestOf(mutated), baseManifest).value;

    expect(diff.missing).toHaveLength(1);
    expect(diff.savedRatio).toBeGreaterThan(0.5);
  });

  test('内容完全不同:诚实报告「几乎没得复用」而非假装省流量', () => {
    expect(reuseRatio(bytes(200_000, 99))).toBeLessThan(0.2);
  });

  test('内容相同:missing 为空,无需传输', () => {
    const diff = chunk.diffManifests(baseManifest, baseManifest).value;

    expect(diff.missing).toEqual([]);
    expect(diff.transferBytes).toBe(0);
    expect(diff.reusedBytes).toBe(base.length);
  });

  test('对端一无所有(haveManifest 缺省)→ 全部块都要传', () => {
    const diff = chunk.diffManifests(baseManifest).value;

    expect(diff.missing).toHaveLength(baseManifest.chunks.length);
    expect(diff.transferBytes).toBe(base.length);
    expect(diff.savedRatio).toBe(0);
  });

  test('重复块只统计一次传输(全零大文件)', () => {
    const zeros = Buffer.alloc(200_000);
    const diff = chunk.diffManifests(manifestOf(zeros)).value;
    const uniqueDigests = new Set(diff.missing.map((c) => c.digest));

    expect(uniqueDigests.size).toBe(diff.missing.length);
    expect(diff.transferBytes).toBeLessThan(zeros.length);
  });
});

describe('buildPatch / applyPatch:逐字节拼回', () => {
  test.each([
    ['头部插入', (b) => Buffer.concat([Buffer.from([7]), b])],
    ['中部替换', (b) => Buffer.concat([b.subarray(0, 50_000), bytes(4000, 5), b.subarray(54_000)])],
    ['尾部截断', (b) => b.subarray(0, 90_000)],
    ['整体替换', () => bytes(150_000, 77)],
    ['清空', () => Buffer.alloc(0)],
  ])('%s 后仍能拼出与目标完全一致的字节', (_label, mutate) => {
    const base = bytes(160_000, 23);
    const baseManifest = manifestOf(base);
    const target = Buffer.from(mutate(base));
    const targetManifest = manifestOf(target);

    const patch = chunk.buildPatch(target, targetManifest, baseManifest);

    expect(patch.ok).toBe(true);

    const applied = chunk.applyPatch(patch.value, storeFrom(base, baseManifest));

    expect(applied.ok).toBe(true);
    expect(applied.value.content.equals(target)).toBe(true);
    expect(applied.value.size).toBe(target.length);
  });

  test('补丁只携带缺失块的字节,已有块走 copy', () => {
    const base = bytes(200_000, 29);
    const baseManifest = manifestOf(base);
    const target = Buffer.concat([base, Buffer.from('TAIL')]);
    const patch = chunk.buildPatch(target, manifestOf(target), baseManifest).value;

    const copies = patch.instructions.filter((i) => i.op === 'copy');
    const datas = patch.instructions.filter((i) => i.op === 'data');

    expect(copies.length).toBeGreaterThan(0);
    expect(datas.length).toBeGreaterThan(0);
    expect(patch.transferBytes).toBeLessThan(target.length);
    // copy 指令不得带字节 —— 否则「省流量」就是假的。
    expect(copies.every((i) => i.bytes === undefined)).toBe(true);
  });

  test('本地缺块 → CHUNK_MISSING 并指名 digest,不返回半成品', () => {
    const base = bytes(120_000, 31);
    const baseManifest = manifestOf(base);
    const target = Buffer.concat([base, Buffer.from('X')]);
    const patch = chunk.buildPatch(target, manifestOf(target), baseManifest).value;

    const applied = chunk.applyPatch(patch, new Map());

    expect(applied.ok).toBe(false);
    expect(applied.error.code).toBe(chunk.CODES.CHUNK_MISSING);
    expect(typeof applied.error.digest).toBe('string');
    expect(applied.value).toBeUndefined();
  });

  test('本地块被篡改 → DIGEST_MISMATCH,拒绝写出错内容', () => {
    const base = bytes(120_000, 37);
    const baseManifest = manifestOf(base);
    const target = Buffer.concat([base, Buffer.from('X')]);
    const patch = chunk.buildPatch(target, manifestOf(target), baseManifest).value;

    const store = storeFrom(base, baseManifest);
    const firstKey = baseManifest.chunks[0].digest;

    store.set(firstKey, Buffer.concat([store.get(firstKey), Buffer.from('EXTRA')]));

    const applied = chunk.applyPatch(patch, store);

    expect(applied.ok).toBe(false);
    expect(applied.error.code).toBe(chunk.CODES.DIGEST_MISMATCH);
  });

  test('普通对象充当块库同样可用(不强制 Map)', () => {
    const base = bytes(80_000, 41);
    const baseManifest = manifestOf(base);
    const target = Buffer.concat([base, Buffer.from('Y')]);
    const patch = chunk.buildPatch(target, manifestOf(target), baseManifest).value;

    const applied = chunk.applyPatch(patch, Object.fromEntries(storeFrom(base, baseManifest)));

    expect(applied.ok).toBe(true);
    expect(applied.value.content.equals(target)).toBe(true);
  });
});

describe('fail-soft:坏清单 / 坏补丁一律结构化报错', () => {
  // namesSchema:只有「信封本身不对」的场景才该把期望 schema 印进消息;
  // 块级脏数据的消息要指向坏字段,印 schema 只会误导排查方向。
  test.each([
    ['null', null, true],
    ['非对象', 42, true],
    ['缺 schema', { chunks: [] }, true],
    ['schema 不匹配', { schema: 'khy-file-sync-chunks/999', chunks: [] }, true],
    ['chunks 非数组', { schema: chunk.SCHEMA, chunks: 'nope' }, false],
    ['块缺 digest', { schema: chunk.SCHEMA, chunks: [{ size: 10 }] }, false],
    ['块 size 非法', { schema: chunk.SCHEMA, chunks: [{ digest: 'aa', size: -1 }] }, false],
  ])('清单 %s → INVALID_MANIFEST,不抛', (_label, bad, namesSchema) => {
    let out;

    expect(() => {
      out = chunk.validateManifest(bad);
    }).not.toThrow();

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe(chunk.CODES.INVALID_MANIFEST);
    expect(typeof out.error.message).toBe('string');

    if (namesSchema) {
      expect(out.error.message).toContain(chunk.SCHEMA);
    }
  });

  test('diffManifests 对坏 target / 坏 have 都报错而非静默当空', () => {
    const good = manifestOf(bytes(20_000, 43));

    expect(chunk.diffManifests(null).ok).toBe(false);
    expect(chunk.diffManifests(good, { schema: 'x', chunks: [] }).ok).toBe(false);
  });

  test('清单偏移越出内容长度 → INVALID_MANIFEST(不越界读)', () => {
    const buf = bytes(10_000, 47);
    const lying = {
      schema: chunk.SCHEMA,
      size: 999_999,
      digest: 'deadbeefdeadbeef',
      chunks: [{ offset: 900_000, size: 1000, digest: 'aaaaaaaabbbbbbbb' }],
    };

    const out = chunk.buildPatch(buf, lying);

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe(chunk.CODES.INVALID_MANIFEST);
  });

  test.each([
    ['null', null],
    ['非对象', 7],
    ['schema 不符', { schema: 'nope', instructions: [] }],
    ['instructions 非数组', { schema: chunk.SCHEMA, instructions: null }],
    ['未知 op', { schema: chunk.SCHEMA, instructions: [{ op: 'teleport', digest: 'a' }] }],
    ['非对象指令', { schema: chunk.SCHEMA, instructions: [null] }],
  ])('补丁 %s → INVALID_PATCH,不抛', (_label, bad) => {
    let out;

    expect(() => {
      out = chunk.applyPatch(bad, new Map());
    }).not.toThrow();

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe(chunk.CODES.INVALID_PATCH);
  });

  test('声明长度与实际拼装不符 → DIGEST_MISMATCH', () => {
    const out = chunk.applyPatch(
      {
        schema: chunk.SCHEMA,
        size: 999,
        instructions: [{ op: 'data', digest: 'aa', size: 2, bytes: Buffer.from('hi') }],
      },
      new Map()
    );

    expect(out.ok).toBe(false);
    expect(out.error.code).toBe(chunk.CODES.DIGEST_MISMATCH);
    expect(out.error.actualSize).toBe(2);
  });

  test('digestBytes 对越界 / 反序区间不抛', () => {
    const buf = bytes(100, 51);

    expect(() => chunk.digestBytes(buf, -5, 999)).not.toThrow();
    expect(chunk.digestBytes(buf, -5, 999)).toBe(chunk.digestBytes(buf));
    // 反序区间当空区间,而不是「算到末尾」—— 后者会给写错的区间一个看似正常的摘要。
    expect(chunk.digestBytes(buf, 50, 10)).toBe(chunk.digestBytes(buf, 50, 50));
    expect(chunk.digestBytes(buf, 500, 900)).toBe(chunk.digestBytes(buf, 100, 100));
  });

  test('不同长度的全零块摘要不同(长度掺进摘要)', () => {
    expect(chunk.digestBytes(Buffer.alloc(8))).not.toBe(chunk.digestBytes(Buffer.alloc(16)));
  });

  test('toBuffer 对 null/undefined 回空 Buffer,对怪类型报错', () => {
    expect(chunk.toBuffer(null).value.length).toBe(0);
    expect(chunk.toBuffer(undefined).value.length).toBe(0);
    expect(chunk.toBuffer(new Uint8Array([1, 2])).value.equals(Buffer.from([1, 2]))).toBe(true);
    expect(chunk.toBuffer(Symbol('x')).ok).toBe(false);
  });
});

describe('门控与边界解析', () => {
  test('默认开;仅显式 0/false/off/no 关', () => {
    expect(chunk.isChunkDiffEnabled({})).toBe(true);
    expect(chunk.isChunkDiffEnabled({ KHY_FILE_SYNC_CHUNK: '' })).toBe(true);
    expect(chunk.isChunkDiffEnabled({ KHY_FILE_SYNC_CHUNK: '1' })).toBe(true);

    for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      expect(chunk.isChunkDiffEnabled({ KHY_FILE_SYNC_CHUNK: off })).toBe(false);
    }
  });

  test('env 覆盖生效,坏值回落默认', () => {
    expect(chunk.resolveChunkLimits({ KHY_FILE_SYNC_CHUNK_COUNT: '128' }).maxChunks).toBe(128);
    expect(chunk.resolveChunkLimits({ KHY_FILE_SYNC_CHUNK_COUNT: 'abc' }).maxChunks).toBe(
      chunk.DEFAULT_CHUNK_LIMITS.maxChunks
    );
    expect(chunk.resolveChunkLimits({ KHY_FILE_SYNC_CHUNK_MIN: '-5' }).minChunkBytes).toBe(
      chunk.DEFAULT_CHUNK_LIMITS.minChunkBytes
    );
    expect(chunk.resolveChunkLimits(null)).toEqual(chunk.DEFAULT_CHUNK_LIMITS);
  });

  test('互相矛盾的旋钮被夹成 min <= target <= max', () => {
    const limits = chunk.resolveChunkLimits({
      KHY_FILE_SYNC_CHUNK_MIN: '50000',
      KHY_FILE_SYNC_CHUNK_TARGET: '100',
      KHY_FILE_SYNC_CHUNK_MAX: '200',
    });

    expect(limits.minChunkBytes).toBeLessThanOrEqual(limits.targetChunkBytes);
    expect(limits.targetChunkBytes).toBeLessThanOrEqual(limits.maxChunkBytes);
  });

  test('自定义 target 真的改变平均块长', () => {
    const buf = bytes(200_000, 53);
    const coarse = manifestOf(buf, { limits: chunk.resolveChunkLimits() });
    const fine = manifestOf(buf, {
      limits: chunk.resolveChunkLimits({ KHY_FILE_SYNC_CHUNK_TARGET: '2048' }),
    });

    expect(fine.chunks.length).toBeGreaterThan(coarse.chunks.length);
  });
});

describe('状态文本:动作 + 目标 + 进度', () => {
  test('需传输时给出块数、字节数与节省比例', () => {
    const base = bytes(200_000, 59);
    const target = Buffer.concat([base, Buffer.from('TAIL')]);
    const diff = chunk.diffManifests(manifestOf(target), manifestOf(base)).value;
    const text = chunk.describeChunkPlan('bin/app.exe', diff);

    expect(text).toContain('bin/app.exe');
    expect(text).toMatch(/需传 \d+ 块/);
    expect(text).toMatch(/省 \d+%/);
    expect(/正在工作|处理中|Loading|请稍候|Processing|同步中/.test(text)).toBe(false);
  });

  test('全部命中时明说「无需传输」', () => {
    const manifest = manifestOf(bytes(50_000, 61));
    const text = chunk.describeChunkPlan('docs/big.pdf', chunk.diffManifests(manifest, manifest).value);

    expect(text).toContain('docs/big.pdf');
    expect(text).toContain('无需传输');
  });

  test('缺参不抛,且不出现空路径', () => {
    expect(chunk.describeChunkPlan(null, null)).toContain('(未命名文件)');
    expect(() => chunk.describeChunkPlan(undefined, undefined)).not.toThrow();
  });
});
