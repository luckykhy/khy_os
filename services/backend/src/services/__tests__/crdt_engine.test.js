'use strict';

/**
 * crdt_engine 单元测试:校验闸门 + 确定性合并语义。
 * 纯叶子,无 fs / WebSocket / 真实时钟,全部同步可重复。
 */

const engine = require('../crdt_engine');

const { CODES } = engine;

function envelope(over = {}) {
  return {
    path: 'docs/a.md',
    opId: 'op-1',
    editor: 'alice',
    sessionId: 's-1',
    baseVersion: 0,
    operations: [{ insert: 'x', position: 0 }],
    ...over,
  };
}

function ctx(over = {}) {
  return { limits: engine.DEFAULT_LIMITS, authenticated: true, canEdit: true, ...over };
}

function batch(opId, version, operations) {
  return { version, opId, operations };
}

describe('crdt_engine 门控与边界解析', () => {
  test('默认开启，仅显式关闭词才关', () => {
    expect(engine.isEngineEnabled({})).toBe(true);
    expect(engine.isEngineEnabled({ KHY_FILE_SYNC: '' })).toBe(true);
    expect(engine.isEngineEnabled({ KHY_FILE_SYNC: '1' })).toBe(true);
    expect(engine.isEngineEnabled({ KHY_FILE_SYNC: '0' })).toBe(false);
    expect(engine.isEngineEnabled({ KHY_FILE_SYNC: 'off' })).toBe(false);
    expect(engine.isEngineEnabled({ KHY_FILE_SYNC: 'FALSE' })).toBe(false);
  });

  test('坏的 env 值回落默认，绝不抛', () => {
    const limits = engine.resolveLimits({
      KHY_FILE_SYNC_MAX_OPS: 'abc',
      KHY_FILE_SYNC_HISTORY: '-5',
    });

    expect(limits.maxOpsPerBatch).toBe(engine.DEFAULT_LIMITS.maxOpsPerBatch);
    expect(limits.historyLimit).toBe(engine.DEFAULT_LIMITS.historyLimit);
    expect(engine.resolveLimits({ KHY_FILE_SYNC_HISTORY: '7' }).historyLimit).toBe(7);
  });

  test('stableHash 确定且为正整数', () => {
    expect(engine.stableHash('docs/a.md')).toBe(engine.stableHash('docs/a.md'));
    expect(engine.stableHash('docs/a.md')).not.toBe(engine.stableHash('docs/b.md'));
    expect(engine.stableHash('docs/a.md')).toBeGreaterThan(0);
  });
});

describe('crdt_engine 路径校验', () => {
  test('非法路径:空串 / 非字符串 / 控制字符', () => {
    expect(engine.normalizeRelPath('').error.code).toBe(CODES.INVALID_PATH);
    expect(engine.normalizeRelPath('   ').error.code).toBe(CODES.INVALID_PATH);
    expect(engine.normalizeRelPath(null).error.code).toBe(CODES.INVALID_PATH);
    expect(engine.normalizeRelPath(42).error.code).toBe(CODES.INVALID_PATH);
    expect(engine.normalizeRelPath('docs/a\u0000.md').error.code).toBe(CODES.INVALID_PATH);
    expect(engine.normalizeRelPath('docs/a\u001f.md').error.code).toBe(CODES.INVALID_PATH);
    expect(engine.normalizeRelPath('./.').error.code).toBe(CODES.INVALID_PATH);
  });

  test('非法路径:超长', () => {
    const long = `docs/${'a'.repeat(500)}.md`;
    const result = engine.normalizeRelPath(long);

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(CODES.INVALID_PATH);
    expect(result.error.message).toContain('超出上限');
  });

  test('路径越界:向上穿越 / 绝对路径 / UNC / 盘符', () => {
    expect(engine.normalizeRelPath('../etc/passwd').error.code).toBe(CODES.PATH_ESCAPE);
    expect(engine.normalizeRelPath('docs/../../x').error.code).toBe(CODES.PATH_ESCAPE);
    expect(engine.normalizeRelPath('/etc/passwd').error.code).toBe(CODES.PATH_ESCAPE);
    expect(engine.normalizeRelPath('//host/share/x').error.code).toBe(CODES.PATH_ESCAPE);
    expect(engine.normalizeRelPath('C:/Windows/x').error.code).toBe(CODES.PATH_ESCAPE);
    expect(engine.normalizeRelPath('C:\\Windows\\x').error.code).toBe(CODES.PATH_ESCAPE);
  });

  test('合法路径被规范化:反斜杠统一、冗余段折叠', () => {
    expect(engine.normalizeRelPath('docs\\sub\\a.md').value).toBe('docs/sub/a.md');
    expect(engine.normalizeRelPath('./docs//sub/./a.md').value).toBe('docs/sub/a.md');
  });

  test('未授权订阅目标:白名单前缀之外', () => {
    const opts = { allowPrefixes: ['docs', 'services/backend/src/'] };

    expect(engine.normalizeRelPath('docs/a.md', opts).ok).toBe(true);
    expect(engine.normalizeRelPath('docs', opts).ok).toBe(true);
    expect(engine.normalizeRelPath('services/backend/src/x.js', opts).ok).toBe(true);

    const denied = engine.normalizeRelPath('kernel/boot.c', opts);

    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe(CODES.PATH_NOT_ALLOWED);
    expect(denied.error.path).toBe('kernel/boot.c');
  });

  test('前缀白名单不被同前缀的兄弟目录绕过', () => {
    const opts = { allowPrefixes: ['docs'] };

    expect(engine.normalizeRelPath('docs-secret/a.md', opts).error.code).toBe(
      CODES.PATH_NOT_ALLOWED
    );
  });
});

describe('crdt_engine 二进制与编码判定', () => {
  test('空字节 / 高比例控制字符判为二进制', () => {
    expect(engine.looksBinary('hello\u0000world')).toBe(true);
    expect(engine.looksBinary('\u0001\u0002\u0003\u0004ab')).toBe(true);
  });

  test('普通文本(含空格、制表、换行)不判为二进制', () => {
    expect(engine.looksBinary('hello world')).toBe(false);
    expect(engine.looksBinary('a\tb\r\nc\n')).toBe(false);
    expect(engine.looksBinary('中文内容，含标点。')).toBe(false);
    expect(engine.looksBinary('')).toBe(false);
  });

  test('替换字符与孤立代理对判为编码非法', () => {
    expect(engine.hasValidEncoding('ok')).toBe(true);
    expect(engine.hasValidEncoding('bad\uFFFD')).toBe(false);
    expect(engine.hasValidEncoding('lone\uD800')).toBe(false);
    expect(engine.hasValidEncoding('emoji\uD83D\uDE00')).toBe(true);
  });
});

describe('crdt_engine 操作归一化', () => {
  test('三种写法归一到同一结构', () => {
    expect(
      engine.normalizeOperation({ insert: 'ab', position: 3 }, engine.DEFAULT_LIMITS).value
    ).toEqual([{ kind: 'insert', position: 3, text: 'ab' }]);

    expect(
      engine.normalizeOperation({ delete: 2, position: 3 }, engine.DEFAULT_LIMITS).value
    ).toEqual([{ kind: 'delete', position: 3, length: 2 }]);

    expect(
      engine.normalizeOperation(
        { delete: true, range: { start: 3, end: 5 } },
        engine.DEFAULT_LIMITS
      ).value
    ).toEqual([{ kind: 'delete', position: 3, length: 2 }]);
  });

  test('替换 = delete 先于 insert，两半共用同一基线位置', () => {
    const result = engine.normalizeOperation(
      { range: { start: 2, end: 5 }, insert: 'XY' },
      engine.DEFAULT_LIMITS
    );

    expect(result.value).toEqual([
      { kind: 'delete', position: 2, length: 3 },
      { kind: 'insert', position: 2, text: 'XY' },
    ]);
  });

  test('非法 range:end < start / position 非整数 / 负数', () => {
    const limits = engine.DEFAULT_LIMITS;

    expect(
      engine.normalizeOperation({ range: { start: 5, end: 2 }, delete: true }, limits).error.code
    ).toBe(CODES.INVALID_RANGE);
    expect(
      engine.normalizeOperation({ range: { start: -1, end: 2 }, delete: true }, limits).error.code
    ).toBe(CODES.INVALID_RANGE);
    expect(engine.normalizeOperation({ insert: 'x', position: 1.5 }, limits).error.code).toBe(
      CODES.INVALID_RANGE
    );
    expect(engine.normalizeOperation({ insert: 'x', position: -3 }, limits).error.code).toBe(
      CODES.INVALID_RANGE
    );
    expect(engine.normalizeOperation({ insert: 'x' }, limits).error.code).toBe(CODES.INVALID_RANGE);
  });

  test('空操作 / 非对象操作被拒', () => {
    const limits = engine.DEFAULT_LIMITS;

    expect(engine.normalizeOperation(null, limits).error.code).toBe(CODES.INVALID_OPERATION);
    expect(engine.normalizeOperation([], limits).error.code).toBe(CODES.INVALID_OPERATION);
    expect(engine.normalizeOperation({ position: 0 }, limits).error.code).toBe(
      CODES.INVALID_OPERATION
    );
    expect(engine.normalizeOperation({ insert: 123, position: 0 }, limits).error.code).toBe(
      CODES.INVALID_OPERATION
    );
  });

  test('批内删除区间重叠被拒(语义歧义,必须拆成两版提交)', () => {
    const ops = [
      { kind: 'delete', position: 0, length: 5 },
      { kind: 'delete', position: 3, length: 4 },
    ];

    expect(engine.validateBatch(ops, engine.DEFAULT_LIMITS).error.code).toBe(
      CODES.OVERLAPPING_BATCH
    );
  });

  test('批内相邻但不相交的删除被接受', () => {
    const ops = [
      { kind: 'delete', position: 0, length: 3 },
      { kind: 'delete', position: 3, length: 2 },
    ];

    expect(engine.validateBatch(ops, engine.DEFAULT_LIMITS).ok).toBe(true);
  });
});

describe('crdt_engine 信封校验(整排闸门)', () => {
  test('未认证会话', () => {
    const result = engine.validateOpEnvelope(envelope(), ctx({ authenticated: false }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(CODES.UNAUTHENTICATED_SESSION);
  });

  test('未授权编辑', () => {
    const result = engine.validateOpEnvelope(envelope(), ctx({ canEdit: false }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(CODES.EDIT_FORBIDDEN);
  });

  test('缺失 opId / opId 超长', () => {
    expect(engine.validateOpEnvelope(envelope({ opId: undefined }), ctx()).error.code).toBe(
      CODES.MISSING_OP_ID
    );
    expect(engine.validateOpEnvelope(envelope({ opId: '   ' }), ctx()).error.code).toBe(
      CODES.MISSING_OP_ID
    );
    expect(engine.validateOpEnvelope(envelope({ opId: 'z'.repeat(200) }), ctx()).error.code).toBe(
      CODES.MISSING_OP_ID
    );
  });

  test('缺失 baseVersion / baseVersion 非整数 / 负数', () => {
    expect(engine.validateOpEnvelope(envelope({ baseVersion: undefined }), ctx()).error.code).toBe(
      CODES.MISSING_BASE_VERSION
    );
    expect(engine.validateOpEnvelope(envelope({ baseVersion: '3' }), ctx()).error.code).toBe(
      CODES.MISSING_BASE_VERSION
    );
    expect(engine.validateOpEnvelope(envelope({ baseVersion: -1 }), ctx()).error.code).toBe(
      CODES.MISSING_BASE_VERSION
    );
    expect(engine.validateOpEnvelope(envelope({ baseVersion: 1.5 }), ctx()).error.code).toBe(
      CODES.MISSING_BASE_VERSION
    );
  });

  test('非法路径 / 路径越界 经由信封同样被拦', () => {
    expect(engine.validateOpEnvelope(envelope({ path: '' }), ctx()).error.code).toBe(
      CODES.INVALID_PATH
    );
    expect(engine.validateOpEnvelope(envelope({ path: '../secrets' }), ctx()).error.code).toBe(
      CODES.PATH_ESCAPE
    );
    expect(
      engine.validateOpEnvelope(envelope({ path: 'kernel/x.c' }), ctx({ allowPrefixes: ['docs'] }))
        .error.code
    ).toBe(CODES.PATH_NOT_ALLOWED);
  });

  test('超大操作:单批操作数 / 单次插入字符数 / 单批总字符数', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ insert: 'x', position: i }));

    expect(
      engine.validateOpEnvelope(
        envelope({ operations: many }),
        ctx({ limits: { ...engine.DEFAULT_LIMITS, maxOpsPerBatch: 4 } })
      ).error.code
    ).toBe(CODES.OP_TOO_LARGE);

    expect(
      engine.validateOpEnvelope(
        envelope({ operations: [{ insert: 'x'.repeat(20), position: 0 }] }),
        ctx({ limits: { ...engine.DEFAULT_LIMITS, maxInsertChars: 10 } })
      ).error.code
    ).toBe(CODES.OP_TOO_LARGE);

    expect(
      engine.validateOpEnvelope(
        envelope({
          operations: [
            { insert: 'x'.repeat(8), position: 0 },
            { insert: 'y'.repeat(8), position: 20 },
          ],
        }),
        ctx({ limits: { ...engine.DEFAULT_LIMITS, maxBatchChars: 10 } })
      ).error.code
    ).toBe(CODES.OP_TOO_LARGE);
  });

  test('非法编码', () => {
    const result = engine.validateOpEnvelope(
      envelope({ operations: [{ insert: 'bad\uFFFD', position: 0 }] }),
      ctx()
    );

    expect(result.error.code).toBe(CODES.INVALID_ENCODING);
  });

  test('二进制内容不得进入文本合并路径', () => {
    const result = engine.validateOpEnvelope(
      envelope({ operations: [{ insert: 'a\u0000b', position: 0 }] }),
      ctx()
    );

    expect(result.error.code).toBe(CODES.BINARY_FILE);
  });

  test('sessionId 与 editor 至少提供其一，且互相回填', () => {
    expect(engine.validateOpEnvelope(envelope({ sessionId: '', editor: '' }), ctx()).error.code).toBe(
      CODES.INVALID_OPERATION
    );

    const onlyEditor = engine.validateOpEnvelope(envelope({ sessionId: '', editor: 'bob' }), ctx());

    expect(onlyEditor.value.editor).toBe('bob');
    expect(onlyEditor.value.sessionId).toBe('bob');
  });

  test('通过校验后返回规范化信封', () => {
    const result = engine.validateOpEnvelope(
      envelope({ path: 'docs\\a.md', opId: ' op-9 ', operations: [{ insert: 'hi', position: 0 }] }),
      ctx()
    );

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      path: 'docs/a.md',
      opId: 'op-9',
      editor: 'alice',
      sessionId: 's-1',
      baseVersion: 0,
      operations: [{ kind: 'insert', position: 0, text: 'hi' }],
    });
  });

  test('信封本身非对象不抛，返回结构化错误', () => {
    expect(engine.validateOpEnvelope(null, ctx()).error.code).toBe(CODES.INVALID_OPERATION);
    expect(engine.validateOpEnvelope('nope', ctx()).error.code).toBe(CODES.INVALID_OPERATION);
  });
});

describe('crdt_engine 合并语义', () => {
  test('不同位置的独立编辑自动合并，双方内容都在', () => {
    const committed = [batch('op-a', 1, [{ kind: 'insert', position: 0, text: 'X' }])];
    const rebased = engine.rebaseOperations(
      { opId: 'op-b', operations: [{ kind: 'insert', position: 11, text: 'Y' }] },
      committed
    );

    expect(rebased.ok).toBe(true);
    expect(rebased.value.operations).toEqual([{ kind: 'insert', position: 12, text: 'Y' }]);
    expect(rebased.value.rebasedOver).toBe(1);

    const applied = engine.applyOperations('Xhello world', rebased.value.operations);

    expect(applied.value).toBe('Xhello worldY');
  });

  test('已提交操作在后方时，入向位置不需要平移', () => {
    const committed = [batch('op-a', 1, [{ kind: 'insert', position: 11, text: 'Y' }])];
    const rebased = engine.rebaseOperations(
      { opId: 'op-b', operations: [{ kind: 'insert', position: 0, text: 'X' }] },
      committed
    );

    expect(rebased.value.operations).toEqual([{ kind: 'insert', position: 0, text: 'X' }]);
  });

  test('同一区域的重叠编辑返回结构化冲突,而非静默覆盖', () => {
    const committed = [batch('op-a', 1, [{ kind: 'delete', position: 0, length: 5 }])];
    const rebased = engine.rebaseOperations(
      { opId: 'op-b', operations: [{ kind: 'delete', position: 2, length: 5 }] },
      committed
    );

    expect(rebased.ok).toBe(false);
    expect(rebased.error.code).toBe(CODES.MERGE_CONFLICT);
    expect(rebased.error.conflictingOpIds).toEqual(['op-a']);
    expect(rebased.error.message).toContain('重叠编辑冲突');
  });

  test('插入落在已提交删除区间内部 → 冲突', () => {
    const committed = [batch('op-a', 1, [{ kind: 'delete', position: 2, length: 6 }])];
    const rebased = engine.rebaseOperations(
      { opId: 'op-b', operations: [{ kind: 'insert', position: 4, text: 'Z' }] },
      committed
    );

    expect(rebased.error.code).toBe(CODES.MERGE_CONFLICT);
    expect(rebased.error.conflictingOpIds).toEqual(['op-a']);
  });

  test('已提交插入落在待删除区间内部 → 冲突', () => {
    const committed = [batch('op-a', 1, [{ kind: 'insert', position: 4, text: 'Z' }])];
    const rebased = engine.rebaseOperations(
      { opId: 'op-b', operations: [{ kind: 'delete', position: 2, length: 6 }] },
      committed
    );

    expect(rebased.error.code).toBe(CODES.MERGE_CONFLICT);
  });

  test('本次操作被此前删除完全吞掉 → 冲突，不静默丢弃', () => {
    const committed = [batch('op-a', 1, [{ kind: 'delete', position: 0, length: 5 }])];
    const rebased = engine.rebaseOperations(
      { opId: 'op-b', operations: [{ kind: 'delete', position: 0, length: 5 }] },
      committed
    );

    expect(rebased.ok).toBe(false);
    expect(rebased.error.code).toBe(CODES.MERGE_CONFLICT);
  });

  test('不相交的删除自动平移合并', () => {
    const committed = [batch('op-a', 1, [{ kind: 'delete', position: 0, length: 3 }])];
    const rebased = engine.rebaseOperations(
      { opId: 'op-b', operations: [{ kind: 'delete', position: 6, length: 2 }] },
      committed
    );

    expect(rebased.value.operations).toEqual([{ kind: 'delete', position: 3, length: 2 }]);
  });

  test('同位置插入按 opId 全序定序:两侧内容都保留且顺序确定', () => {
    const aFirst = engine.rebaseOperations(
      { opId: 'op-bbb', operations: [{ kind: 'insert', position: 3, text: 'B' }] },
      [batch('op-aaa', 1, [{ kind: 'insert', position: 3, text: 'A' }])]
    );

    expect(aFirst.value.operations).toEqual([{ kind: 'insert', position: 4, text: 'B' }]);

    const bFirst = engine.rebaseOperations(
      { opId: 'op-aaa', operations: [{ kind: 'insert', position: 3, text: 'A' }] },
      [batch('op-bbb', 1, [{ kind: 'insert', position: 3, text: 'B' }])]
    );

    expect(bFirst.value.operations).toEqual([{ kind: 'insert', position: 3, text: 'A' }]);

    // 两条提交顺序不同，最终文本一致 —— 这就是收敛。
    expect(engine.applyOperations('012A45', aFirst.value.operations).value).toBe('012AB45');
    expect(engine.applyOperations('012B45', bFirst.value.operations).value).toBe('012AB45');
  });

  test('乱序的已提交批次被确定性排序后再变换', () => {
    const incoming = { opId: 'op-c', operations: [{ kind: 'insert', position: 10, text: 'C' }] };
    const ascending = [
      batch('op-a', 1, [{ kind: 'insert', position: 0, text: 'A' }]),
      batch('op-b', 2, [{ kind: 'insert', position: 1, text: 'B' }]),
    ];
    const shuffled = [ascending[1], ascending[0]];

    expect(engine.rebaseOperations(incoming, ascending).value).toEqual(
      engine.rebaseOperations(incoming, shuffled).value
    );
  });

  test('相同输入在不同实例得到相同输出(确定性)', () => {
    const incoming = {
      opId: 'op-x',
      operations: [
        { kind: 'delete', position: 8, length: 2 },
        { kind: 'insert', position: 2, text: '插入' },
      ],
    };
    const committed = [
      batch('op-1', 1, [{ kind: 'insert', position: 0, text: '甲' }]),
      batch('op-2', 2, [{ kind: 'delete', position: 5, length: 1 }]),
    ];
    const first = engine.rebaseOperations(incoming, committed);
    const second = engine.rebaseOperations(incoming, committed);

    expect(first).toEqual(second);
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
  });

  test('空操作列表返回结构化错误而非崩溃', () => {
    expect(engine.rebaseOperations({ opId: 'op-x', operations: [] }, []).error.code).toBe(
      CODES.INVALID_OPERATION
    );
    expect(engine.rebaseOperations({ opId: 'op-x' }, []).error.code).toBe(CODES.INVALID_OPERATION);
  });

  test('变换阶段异常降级为 MERGE_FALLBACK,不抛', () => {
    const poisoned = [
      {
        version: 1,
        opId: 'op-a',
        get operations() {
          throw new Error('boom');
        },
      },
    ];
    const result = engine.rebaseOperations(
      { opId: 'op-b', operations: [{ kind: 'insert', position: 0, text: 'x' }] },
      poisoned
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(CODES.MERGE_FALLBACK);
    expect(result.error.fallback).toBe('file_lock');
  });
});

describe('crdt_engine 应用与越界', () => {
  test('批内倒序应用,位置互不干扰', () => {
    const result = engine.applyOperations('0123456789', [
      { kind: 'insert', position: 0, text: 'A' },
      { kind: 'insert', position: 5, text: 'B' },
      { kind: 'delete', position: 8, length: 2 },
    ]);

    expect(result.value).toBe('A01234B567');
  });

  test('删除越界 / 插入越界返回 OUT_OF_RANGE', () => {
    expect(
      engine.applyOperations('abc', [{ kind: 'delete', position: 2, length: 5 }]).error.code
    ).toBe(CODES.OUT_OF_RANGE);
    expect(
      engine.applyOperations('abc', [{ kind: 'insert', position: 9, text: 'x' }]).error.code
    ).toBe(CODES.OUT_OF_RANGE);
  });

  test('应用后超出文档上限 → OP_TOO_LARGE', () => {
    const result = engine.applyOperations(
      'abc',
      [{ kind: 'insert', position: 0, text: 'x'.repeat(50) }],
      { ...engine.DEFAULT_LIMITS, maxDocChars: 10 }
    );

    expect(result.error.code).toBe(CODES.OP_TOO_LARGE);
  });
});

describe('crdt_engine Yjs 收敛基座', () => {
  test('yjs 实际可用(依赖已登记并安装)', () => {
    expect(engine.isYjsAvailable()).toBe(true);
  });

  test('同一 clientKey 派生同一 clientID —— 二进制更新逐字节可比', () => {
    const a = engine.createDocument({ text: 'hello', clientKey: 'khy:docs/a.md' });
    const b = engine.createDocument({ text: 'hello', clientKey: 'khy:docs/a.md' });

    expect(a.value.available).toBe(true);
    expect(a.value.doc.clientID).toBe(b.value.doc.clientID);

    const opA = engine.applyToDocument(a.value.doc, [{ kind: 'insert', position: 5, text: '!' }], {
      fallbackText: 'hello',
    });
    const opB = engine.applyToDocument(b.value.doc, [{ kind: 'insert', position: 5, text: '!' }], {
      fallbackText: 'hello',
    });

    expect(opA.value.text).toBe('hello!');
    expect(opA.value.update).toBe(opB.value.update);
  });

  test('Yjs 结果与纯文本对照一致', () => {
    const created = engine.createDocument({ text: '0123456789', clientKey: 'k' });
    const ops = [
      { kind: 'insert', position: 0, text: 'A' },
      { kind: 'delete', position: 8, length: 2 },
    ];
    const viaDoc = engine.applyToDocument(created.value.doc, ops, { fallbackText: '0123456789' });

    expect(viaDoc.value.text).toBe(engine.applyOperations('0123456789', ops).value);
  });

  test('越界批次在污染权威文档之前被拒(不允许半写入)', () => {
    const created = engine.createDocument({ text: 'abc', clientKey: 'k' });
    const result = engine.applyToDocument(
      created.value.doc,
      [{ kind: 'delete', position: 1, length: 99 }],
      { fallbackText: 'abc' }
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe(CODES.OUT_OF_RANGE);
    expect(created.value.doc.getText('content').toString()).toBe('abc');
  });

  test('yjs 缺席时降级到纯文本,仍返回 ok', () => {
    const result = engine.applyToDocument(null, [{ kind: 'insert', position: 0, text: 'x' }], {
      fallbackText: 'abc',
    });

    expect(result.ok).toBe(true);
    expect(result.value.text).toBe('xabc');
    expect(result.value.update).toBeNull();
    expect(result.value.degraded).toBe('yjs_unavailable');
  });

  test('快照同时给出文本、二进制快照与状态向量', () => {
    const created = engine.createDocument({ text: '内容', clientKey: 'k' });
    const snap = engine.encodeSnapshot(created.value.doc, '内容');

    expect(snap.value.text).toBe('内容');
    expect(typeof snap.value.snapshot).toBe('string');
    expect(typeof snap.value.stateVector).toBe('string');

    const plain = engine.encodeSnapshot(null, '内容');

    expect(plain.value.text).toBe('内容');
    expect(plain.value.snapshot).toBeNull();
  });

  test('两侧独立更新经 applyUpdate 后收敛到同一文本(顺序无关)', () => {
    const Y = require('yjs');
    const base = engine.createDocument({ text: 'hello world', clientKey: 'base' });
    const seed = Buffer.from(engine.encodeSnapshot(base.value.doc, '').value.snapshot, 'base64');

    const left = new Y.Doc();
    const right = new Y.Doc();

    Y.applyUpdate(left, seed);
    Y.applyUpdate(right, seed);

    left.clientID = 11;
    right.clientID = 22;
    left.getText('content').insert(0, 'L');
    right.getText('content').insert(11, 'R');

    const leftUpdate = Y.encodeStateAsUpdate(left);
    const rightUpdate = Y.encodeStateAsUpdate(right);

    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);

    expect(left.getText('content').toString()).toBe(right.getText('content').toString());
  });
});
