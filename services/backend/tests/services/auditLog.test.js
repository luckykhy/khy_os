'use strict';

/**
 * 审计日志与压缩链路透明度的契约测试（node:test）。
 *
 * 覆盖【验收清单】八项，逐条以文件/返回值为证据，不接受叙述性断言：
 *   1. 八个必需字段齐全
 *   2. 敏感字段被 `***` 遮蔽、`_` 前缀字段被丢弃
 *   3. error 只留首句且 ≤200 字符
 *   4. appendFileSync 失败不抛（fail-soft）
 *   5. print* 调用都带「动作 + 目标 + 进度」量化信号
 *   6. _rotateIfNeeded 正确实现 10MB → .1 → .2 → .3 链式轮转
 *   7. queryAuditLog 支持 tool / since / until / success 过滤
 *   8. getModuleStats 返回 7 个统计字段
 *
 * 隔离手法：把 KHY_APP_HOME 指向临时目录，再 _resetForTest() 清掉
 * auditLog 已缓存的路径与 dataHome 的 _cachedAppHome。不 mock fs —— mock 掉
 * 就只能证明「我的 mock 被调用了」，证明不了 Windows 上 renameSync 拒绝覆盖
 * 已存在目标这类真实行为，而那正是轮转此前静默失效的原因。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const audit = require('../../src/services/auditLog');
const dataHome = require('../../src/utils/dataHome');

const ENV_KEYS = [
  'KHY_APP_HOME',
  'KHY_AUDIT_MAX_BYTES',
  'KHY_AUDIT_MAX_BACKUPS',
  'KHY_AUDIT_ERROR_CHARS',
  'KHY_AUDIT_PARAM_CHARS',
  'KHY_AUDIT_DEDUPE_WINDOW_MS',
  'KHY_AUDIT_DEDUPE_MEMORY',
  'KHY_COMPACT_NOTICE',
  'KHY_COMPACT_AUDIT',
];

/**
 * 在隔离的临时 app home 里跑一段逻辑。
 * @param {(tmp:string)=>any} fn
 * @param {object} [env] - 额外环境变量
 */
function withTmpHome(fn, env = {}) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-audit-'));
  process.env.KHY_APP_HOME = tmp;
  process.env.KHY_AUDIT_DEDUPE_WINDOW_MS = '0'; // 默认关掉去重，单测各自显式开
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
  _reset();
  try {
    return fn(tmp);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
    _reset();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 异步版本。压缩链路是 async 的，用同步 withTmpHome 包住 await 会在
 * compress 还没跑完时就把 KHY_APP_HOME 还原掉，审计行会落到真实家目录 ——
 * 那既污染开发者环境，又让断言查不到刚写的行。
 * @param {(tmp:string)=>Promise<any>} fn
 * @param {object} [env]
 */
async function withTmpHomeAsync(fn, env = {}) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-audit-'));
  process.env.KHY_APP_HOME = tmp;
  process.env.KHY_AUDIT_DEDUPE_WINDOW_MS = '0';
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
  _reset();
  try {
    return await fn(tmp);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
    _reset();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function _reset() {
  audit._resetForTest();
  try {
    dataHome._resetStorageCaches();
  } catch {
    /* older shape — path cache reset above is what matters */
  }
}

/** 读回落盘的所有行（按写入顺序）。 */
function readRows() {
  const file = audit.getAuditFilePath();
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** 造一个刚好超过轮转阈值的文件。 */
function writeOversized(file, marker, minBytes) {
  fs.writeFileSync(file, marker + '\n' + 'x'.repeat(minBytes) + '\n');
}

// ── 1. 八个必需字段齐全 ─────────────────────────────────────────────

test('logToolExecution 落盘的每一行都含八个必需字段', () => {
  withTmpHome(() => {
    const r = audit.logToolExecution({
      tool: 'Bash',
      params: { command: 'ls' },
      result: { success: true },
      permission: 'allow-session',
      elapsed: 42,
    });
    assert.deepStrictEqual(r, { written: true, deduped: false });

    const rows = readRows();
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    for (const field of [
      'timestamp',
      'tool',
      'params',
      'result',
      'permission',
      'elapsed',
      'user',
      'sessionId',
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(row, field),
        `缺字段 ${field}：${JSON.stringify(row)}`
      );
    }
    assert.match(row.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ISO 8601');
    assert.strictEqual(row.tool, 'Bash');
    assert.strictEqual(row.permission, 'allow-session');
    assert.strictEqual(row.elapsed, 42);
    assert.strictEqual(row.result.success, true);
    assert.ok(row.user && row.sessionId, 'user / sessionId 不得为空');
  });
});

test('缺 tool 的 entry 不写盘，且返回原因而不是静默丢弃', () => {
  withTmpHome(() => {
    assert.deepStrictEqual(audit.logToolExecution({ params: { a: 1 } }), {
      written: false,
      deduped: false,
      reason: 'no-tool',
    });
    assert.deepStrictEqual(audit.logToolExecution(null), {
      written: false,
      deduped: false,
      reason: 'no-tool',
    });
    assert.strictEqual(readRows().length, 0);
  });
});

// ── 2. 脱敏 ─────────────────────────────────────────────────────────

test('敏感字段全部 ***，_ 前缀字段被丢弃，长字符串被截断并标注原长', () => {
  withTmpHome(() => {
    const long = 'A'.repeat(500);
    audit.logToolExecution({
      tool: 'httpRequest',
      params: {
        password: 'hunter2',
        apiKey: 'sk-real-key',
        token: 'ghp_xxx',
        secret: 's',
        key: 'k',
        credential: 'c',
        API_KEY: 'upper-case-variant',
        authToken: 'nested-name-variant',
        _internalCursor: 'must-not-be-logged',
        url: 'http://127.0.0.1:8080/x',
        body: long,
      },
      result: { success: true },
    });

    const p = readRows()[0].params;
    for (const k of [
      'password',
      'apiKey',
      'token',
      'secret',
      'key',
      'credential',
      'API_KEY',
      'authToken',
    ]) {
      assert.strictEqual(p[k], '***', `${k} 未被遮蔽`);
    }
    assert.ok(!('_internalCursor' in p), '_ 前缀字段必须整条丢弃');
    assert.strictEqual(p.url, 'http://127.0.0.1:8080/x', '非敏感字段原样保留');
    assert.ok(p.body.endsWith('... (500 chars)'), `长字符串应标注原长，实际: ${p.body.slice(-30)}`);
    assert.ok(p.body.length < long.length, '长字符串必须真的变短');

    // 最后一道防线：整行文本里不能出现任何明文密钥。
    const raw = fs.readFileSync(audit.getAuditFilePath(), 'utf-8');
    for (const leak of ['hunter2', 'sk-real-key', 'ghp_xxx', 'must-not-be-logged']) {
      assert.ok(!raw.includes(leak), `明文泄漏到审计文件: ${leak}`);
    }
  });
});

test('超大嵌套对象被摘要，不把整份文件内容搬进审计', () => {
  withTmpHome(() => {
    audit.logToolExecution({
      tool: 'multiEdit',
      params: { small: { a: 1 }, edits: [{ text: 'B'.repeat(1000) }] },
      result: { success: true },
    });
    const p = readRows()[0].params;
    assert.deepStrictEqual(p.small, { a: 1 }, '小对象原样保留');
    assert.strictEqual(typeof p.edits, 'string', '大对象降为摘要字符串');
    assert.match(p.edits, /\.\.\. \(\d+ chars\)$/);
    assert.ok(p.edits.length < 400);
  });
});

// ── 3. error 只留首句且 ≤200 ────────────────────────────────────────

test('result.error 只保留首句', () => {
  withTmpHome(() => {
    audit.logToolExecution({
      tool: 'readFile',
      result: { success: false, error: '文件不存在。请检查路径是否正确。第三句也不要。' },
    });
    assert.strictEqual(readRows()[0].result.error, '文件不存在。');
  });
});

test('文件路径 / 版本号里的点不算句子终结符', () => {
  withTmpHome(() => {
    const cases = [
      "ENOENT: no such file or directory, open 'C:\\a\\b.js'",
      'upgrade failed at v1.2.3 during patch',
      'first sentence. second sentence.',
    ];
    for (const msg of cases) {
      audit.logToolExecution({ tool: 't', result: { success: false, error: msg } });
    }
    const rows = readRows();
    assert.strictEqual(rows[0].result.error, cases[0], '路径里的 .js 不该截断');
    assert.strictEqual(rows[1].result.error, cases[1], 'v1.2.3 不该截断');
    assert.strictEqual(rows[2].result.error, 'first sentence.', 'ASCII 句号后跟空格才算终结');
  });
});

test('无终结符的超长 error 被硬截断到 200 字符', () => {
  withTmpHome(() => {
    audit.logToolExecution({
      tool: 't',
      result: { success: false, error: 'E'.repeat(1000) },
    });
    assert.strictEqual(readRows()[0].result.error.length, 200);
  });
});

test('KHY_AUDIT_ERROR_CHARS 可覆盖 error 上限（零硬编码）', () => {
  withTmpHome(
    () => {
      audit.logToolExecution({ tool: 't', result: { success: false, error: 'E'.repeat(300) } });
      assert.strictEqual(readRows()[0].result.error.length, 50);
    },
    { KHY_AUDIT_ERROR_CHARS: '50' }
  );
});

test('Error 实例与字符串两种 error 都能收敛成首句', () => {
  withTmpHome(() => {
    audit.logToolExecution({
      tool: 't',
      result: { success: false, error: new Error('模型调用超时。已重试 2 次。') },
    });
    assert.strictEqual(readRows()[0].result.error, '模型调用超时。');
  });
});

// ── 4. fail-soft ────────────────────────────────────────────────────

test('写入失败时不抛异常，返回 written:false 并带原因', () => {
  const saved = process.env.KHY_APP_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-audit-block-'));
  const blocked = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(blocked, 'I am a file, not a directory\n');
  process.env.KHY_APP_HOME = blocked; // 目录位置是个普通文件 ⇒ 写入必然失败
  _reset();
  try {
    let r;
    assert.doesNotThrow(() => {
      r = audit.logToolExecution({ tool: 'Bash', result: { success: true } });
    }, '审计写入失败绝不能向调用方抛异常');
    assert.strictEqual(r.written, false);
    assert.ok(r.reason && r.reason.length > 0, '失败必须给出原因，不是静默 false');
    // 查询同样 fail-soft
    assert.deepStrictEqual(audit.queryAuditLog(), []);
    assert.strictEqual(audit.getModuleStats().totalCalls, 0);
  } finally {
    if (saved === undefined) {
      delete process.env.KHY_APP_HOME;
    } else {
      process.env.KHY_APP_HOME = saved;
    }
    _reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('目录不存在时自动创建（mkdirSync recursive）', () => {
  withTmpHome((tmp) => {
    const deep = path.join(tmp, 'a', 'b', 'c');
    process.env.KHY_APP_HOME = deep;
    _reset();
    assert.strictEqual(fs.existsSync(deep), false, '前置：目录确实不存在');
    assert.strictEqual(audit.logToolExecution({ tool: 't', result: { success: true } }).written, true);
    assert.ok(fs.existsSync(path.join(deep, 'audit.jsonl')));
  });
});

// ── 6. 链式轮转 ─────────────────────────────────────────────────────

test('_rotateIfNeeded 链式轮转：连续 5 次仍正确（.4 永不出现，.3 被丢弃）', () => {
  withTmpHome(
    () => {
      const file = audit.getAuditFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });

      for (let gen = 1; gen <= 5; gen++) {
        writeOversized(file, `marker-${gen}`, 5000);
        const rotated = audit._internals._rotateIfNeeded();
        assert.strictEqual(rotated, true, `第 ${gen} 次应发生轮转`);
        assert.strictEqual(fs.existsSync(file), false, '轮转后 live 文件应已移走');
      }

      const gen = (n) => fs.readFileSync(`${file}.${n}`, 'utf-8').split('\n')[0];
      assert.strictEqual(gen(1), 'marker-5', '.1 = 最新');
      assert.strictEqual(gen(2), 'marker-4');
      assert.strictEqual(gen(3), 'marker-3', '.3 = 最旧的保留代');
      assert.strictEqual(fs.existsSync(`${file}.4`), false, '保留 3 份 ⇒ 不得出现 .4');
      // 最旧的两代必须真的被删除，而不是留在磁盘上无限堆积。
      const files = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('audit.jsonl'));
      assert.strictEqual(files.length, 3, `目录里应只剩 3 个代际，实际: ${files.join(', ')}`);
    },
    { KHY_AUDIT_MAX_BYTES: '4096' }
  );
});

test('未达阈值不轮转', () => {
  withTmpHome(() => {
    const file = audit.getAuditFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'small\n');
    assert.strictEqual(audit._internals._rotateIfNeeded(), false);
    assert.strictEqual(fs.existsSync(`${file}.1`), false);
  });
});

test('logToolExecution 越过阈值时自动轮转，写入不被中断', () => {
  withTmpHome(
    () => {
      const file = audit.getAuditFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeOversized(file, 'old-content', 5000);

      const r = audit.logToolExecution({ tool: 'afterRotate', result: { success: true } });
      assert.strictEqual(r.written, true, '轮转不得阻断写入');
      assert.strictEqual(fs.existsSync(`${file}.1`), true, '旧内容进了 .1');
      const rows = readRows();
      assert.strictEqual(rows.length, 1, 'live 文件重新从 1 行开始');
      assert.strictEqual(rows[0].tool, 'afterRotate');
    },
    { KHY_AUDIT_MAX_BYTES: '4096' }
  );
});

test('KHY_AUDIT_MAX_BACKUPS=0 ⇒ 只重置不留历史', () => {
  withTmpHome(
    () => {
      const file = audit.getAuditFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeOversized(file, 'gone', 5000);
      assert.strictEqual(audit._internals._rotateIfNeeded(), true);
      assert.strictEqual(fs.existsSync(file), false);
      assert.strictEqual(fs.existsSync(`${file}.1`), false);
    },
    { KHY_AUDIT_MAX_BYTES: '4096', KHY_AUDIT_MAX_BACKUPS: '0' }
  );
});

// ── 7. queryAuditLog 过滤 ───────────────────────────────────────────

test('queryAuditLog 支持 tool / since / until / success / limit 过滤', () => {
  withTmpHome(() => {
    const file = audit.getAuditFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [
      { timestamp: '2026-08-01T00:00:00.000Z', tool: 'Bash', result: { success: true }, permission: 'allow', elapsed: 10 },
      { timestamp: '2026-08-05T00:00:00.000Z', tool: 'readFile', result: { success: false, error: 'boom' }, permission: 'deny', elapsed: 20 },
      { timestamp: '2026-08-10T00:00:00.000Z', tool: 'Bash', result: { success: true }, permission: 'allow-session', elapsed: 30 },
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    assert.strictEqual(audit.queryAuditLog({ tool: 'Bash' }).length, 2);
    assert.strictEqual(audit.queryAuditLog({ tool: 'readFile' }).length, 1);
    assert.strictEqual(audit.queryAuditLog({ since: '2026-08-04T00:00:00.000Z' }).length, 2);
    assert.strictEqual(audit.queryAuditLog({ until: '2026-08-04T00:00:00.000Z' }).length, 1);
    assert.strictEqual(
      audit.queryAuditLog({ since: '2026-08-02T00:00:00.000Z', until: '2026-08-08T00:00:00.000Z' })
        .length,
      1
    );
    assert.strictEqual(audit.queryAuditLog({ success: true }).length, 2);
    assert.strictEqual(audit.queryAuditLog({ success: false }).length, 1);
    assert.strictEqual(audit.queryAuditLog({ limit: 1 }).length, 1);
    assert.strictEqual(audit.queryAuditLog({ limit: 1 })[0].tool, 'Bash', '最新的在最前');
    assert.strictEqual(audit.queryAuditLog({ toolPrefix: 'read' }).length, 1);
  });
});

test('损坏的行被跳过而不是让整个查询返回空', () => {
  withTmpHome(() => {
    const file = audit.getAuditFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      '{ this is not json\n' +
        JSON.stringify({ timestamp: '2026-08-01T00:00:00.000Z', tool: 'ok', result: { success: true }, permission: 'allow', elapsed: 1 }) +
        '\n'
    );
    const out = audit.queryAuditLog();
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].tool, 'ok');
  });
});

// ── 8. getModuleStats ───────────────────────────────────────────────

test('getModuleStats 返回七个统计字段，且能按模块前缀收窄', () => {
  withTmpHome(() => {
    audit.logToolExecution({ tool: 'context-compress', result: { success: true }, permission: 'allow', elapsed: 100 });
    audit.logToolExecution({ tool: 'context-compress-skip', result: { success: true }, permission: 'allow', elapsed: 0 });
    audit.logToolExecution({ tool: 'context-compress-degrade', result: { success: false, error: '摘要失败。' }, permission: 'allow', elapsed: 50 });
    audit.logToolExecution({ tool: 'Bash', result: { success: false, error: '退出码 1。' }, permission: 'deny', elapsed: 10 });

    const all = audit.getModuleStats();
    for (const f of [
      'totalCalls',
      'byTool',
      'byPermission',
      'errorCount',
      'deniedCount',
      'avgElapsed',
      'recentErrors',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(all, f), `缺统计字段 ${f}`);
    }
    assert.strictEqual(all.totalCalls, 4);
    assert.strictEqual(all.errorCount, 2);
    assert.strictEqual(all.deniedCount, 1);
    assert.strictEqual(all.avgElapsed, 40, '(100+0+50+10)/4');
    assert.strictEqual(all.byTool['context-compress'], 1);
    assert.strictEqual(all.byPermission.allow, 3);
    assert.strictEqual(all.recentErrors.length, 2);

    const scoped = audit.getModuleStats({ module: 'context-compress' });
    assert.strictEqual(scoped.totalCalls, 3, '按前缀收窄后不含 Bash');
    assert.strictEqual(scoped.errorCount, 1);
    assert.strictEqual(scoped.deniedCount, 0);
    assert.strictEqual(scoped.module, 'context-compress');
  });
});

test('getAuditStats 仍然可用（telemetryService 依赖此导出名）', () => {
  withTmpHome(() => {
    audit.logToolExecution({ tool: 'Bash', result: { success: true }, elapsed: 5 });
    const legacy = audit.getAuditStats();
    assert.strictEqual(legacy.totalCalls, 1);
    assert.deepStrictEqual(Object.keys(legacy).sort(), Object.keys(audit.getModuleStats()).sort());
  });
});

// ── 幂等 ────────────────────────────────────────────────────────────

test('同一条 entry 在窗口内重复调用只落一行（幂等）', () => {
  withTmpHome(
    () => {
      const entry = {
        tool: 'Bash',
        params: { command: 'ls' },
        result: { success: true },
        permission: 'allow',
        elapsed: 7,
      };
      const a = audit.logToolExecution(entry);
      const b = audit.logToolExecution(entry);
      const c = audit.logToolExecution({ ...entry });

      assert.strictEqual(a.written, true);
      assert.strictEqual(b.written, false);
      assert.strictEqual(b.deduped, true);
      assert.strictEqual(c.written, false, '同值不同引用同样算重复');
      assert.strictEqual(readRows().length, 1, '重复调用不得造成数据冗余');
    },
    { KHY_AUDIT_DEDUPE_WINDOW_MS: '5000' }
  );
});

test('参数不同 / elapsed 不同 ⇒ 视为两次真实执行，都要落盘', () => {
  withTmpHome(
    () => {
      audit.logToolExecution({ tool: 'Bash', params: { command: 'ls' }, result: { success: true }, elapsed: 7 });
      audit.logToolExecution({ tool: 'Bash', params: { command: 'pwd' }, result: { success: true }, elapsed: 7 });
      audit.logToolExecution({ tool: 'Bash', params: { command: 'ls' }, result: { success: true }, elapsed: 8 });
      assert.strictEqual(readRows().length, 3);
    },
    { KHY_AUDIT_DEDUPE_WINDOW_MS: '5000' }
  );
});

test('显式 dedupeKey 优先于派生指纹', () => {
  withTmpHome(
    () => {
      audit.logToolExecution({ tool: 'a', result: { success: true }, dedupeKey: 'same' });
      audit.logToolExecution({ tool: 'b', result: { success: true }, dedupeKey: 'same' });
      assert.strictEqual(readRows().length, 1);
    },
    { KHY_AUDIT_DEDUPE_WINDOW_MS: '5000' }
  );
});

test('KHY_AUDIT_DEDUPE_WINDOW_MS=0 ⇒ 完全不去重（旧行为可一键恢复）', () => {
  withTmpHome(() => {
    const entry = { tool: 'Bash', result: { success: true }, elapsed: 1 };
    audit.logToolExecution(entry);
    audit.logToolExecution(entry);
    assert.strictEqual(readRows().length, 2);
  });
});

test('指纹记忆有界，不随调用次数无限增长', () => {
  withTmpHome(
    () => {
      for (let i = 0; i < 200; i++) {
        audit.logToolExecution({ tool: `t${i}`, result: { success: true }, elapsed: i });
      }
      assert.strictEqual(readRows().length, 200, '全部落盘');
      // 记忆上限 4 ⇒ 早期指纹已被挤出，重放第 0 条应重新写入。
      const again = audit.logToolExecution({ tool: 't0', result: { success: true }, elapsed: 0 });
      assert.strictEqual(again.written, true);
    },
    { KHY_AUDIT_DEDUPE_WINDOW_MS: '60000', KHY_AUDIT_DEDUPE_MEMORY: '4' }
  );
});

// ── clearAuditLog ───────────────────────────────────────────────────

test('clearAuditLog 清空并保留 .bak 快照，返回量化结果', () => {
  withTmpHome(() => {
    audit.logToolExecution({ tool: 'a', result: { success: true }, elapsed: 1 });
    audit.logToolExecution({ tool: 'b', result: { success: true }, elapsed: 2 });

    const r = audit.clearAuditLog();
    assert.strictEqual(r.cleared, true);
    assert.strictEqual(r.lines, 2, '返回被清掉的行数，供调用方打出量化提示');
    assert.strictEqual(r.replacedPrevious, false);
    assert.strictEqual(r.backupPath, audit.getAuditFilePath() + '.bak');
    assert.strictEqual(fs.existsSync(audit.getAuditFilePath()), false, 'live 文件已清空');
    assert.strictEqual(fs.readFileSync(r.backupPath, 'utf-8').trim().split('\n').length, 2);
    assert.deepStrictEqual(audit.queryAuditLog(), [], '清空后查询为空');
  });
});

test('二次 clearAuditLog 覆盖旧快照并如实上报（Windows rename 不能覆盖已存在目标）', () => {
  withTmpHome(() => {
    audit.logToolExecution({ tool: 'first', result: { success: true }, elapsed: 1 });
    audit.clearAuditLog();
    audit.logToolExecution({ tool: 'second', result: { success: true }, elapsed: 1 });

    const r = audit.clearAuditLog();
    assert.strictEqual(r.cleared, true, '第二次清空不得因 .bak 已存在而失败');
    assert.strictEqual(r.replacedPrevious, true, '必须告知旧快照被替换，不能静默丢弃');
    assert.match(fs.readFileSync(r.backupPath, 'utf-8'), /second/);
  });
});

test('文件不存在时 clearAuditLog 是无害空操作', () => {
  withTmpHome(() => {
    assert.deepStrictEqual(audit.clearAuditLog(), {
      cleared: false,
      lines: 0,
      backupPath: null,
      replacedPrevious: false,
    });
  });
});

// ── 5. 压缩链路：跳过/降级必须可见且量化 ────────────────────────────

const compressor = require('../../src/services/contextCompressor');
const uiPort = require('../../src/services/compactionUiPort');

/** AGENTS 规则 2：状态行必须带 n/m、百分比、第 n 次 之类的量化信号。 */
const QUANT_RE = /\d+\s*\/\s*\d+|\d+\s*%|第\s*\d+\s*次|\d+\s*(?:s|ms|tokens|条|字符)/;
const GENERIC_TOKENS = ['正在工作', '处理中', 'Loading', 'Connecting', 'loading', 'connecting'];

const estimate = (t) => Math.ceil(String(t || '').length / 4);

/** 捕获压缩链路发出的所有 notice，并保证测试后解除注册。 */
async function withNotices(fn) {
  const seen = [];
  uiPort._resetForTest();
  uiPort.registerCompactionNoticeRenderer((n) => seen.push(n));
  try {
    return await fn(seen);
  } finally {
    uiPort._resetForTest();
    compressor.resetAntiJitter();
  }
}

function assertQuantified(notices) {
  assert.ok(notices.length > 0, '压缩被跳过/降级时必须有用户可见输出，禁止静默');
  for (const n of notices) {
    assert.match(n.text, QUANT_RE, `状态行缺量化信号: ${n.text}`);
    assert.match(n.text, /^\[上下文压缩\]/, `状态行缺目标标识: ${n.text}`);
    for (const g of GENERIC_TOKENS) {
      assert.ok(!n.text.includes(g), `状态行含笼统措辞 "${g}": ${n.text}`);
    }
    assert.ok(['info', 'success', 'warn', 'error'].includes(n.level), `未知 level: ${n.level}`);
  }
}

test('压缩跳过时发出带量化信号的提示，并写入审计', async () => {
  await withNotices((seen) =>
    withTmpHomeAsync(async () => {
      compressor.resetAntiJitter();
      const msgs = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: 'x'.repeat(40),
      }));
      const r = await compressor.compress(msgs, {
        estimateTokensFn: estimate,
        contextWindowTokens: 1000000,
      });
      assert.strictEqual(r.summaryGenerated, false, '未达阈值 ⇒ 不压缩');
      assertQuantified(seen);
      assert.match(seen[0].text, /未达触发线 70%/);

      const stats = audit.getModuleStats({ module: 'context-compress' });
      assert.strictEqual(stats.totalCalls, 1, '跳过也要留审计痕迹');
      assert.strictEqual(stats.byTool['context-compress-skip'], 1);
      assert.strictEqual(stats.errorCount, 0, '正确的跳过不算错误');
      const row = audit.queryAuditLog({ tool: 'context-compress-skip' })[0];
      assert.strictEqual(row.params.reason, 'below-threshold');
      assert.strictEqual(row.params.usagePercent, 0);
      assert.strictEqual(row.result.success, true);
      assert.strictEqual(row.permission, 'allow');
    })
  );
});

test('会话过短跳过时同样可见且量化', async () => {
  await withNotices(async (seen) => {
    process.env.KHY_COMPACT_AUDIT = '0';
    try {
      compressor.resetAntiJitter();
      const r = await compressor.compress([{ role: 'user', content: 'hi' }], {
        estimateTokensFn: estimate,
        contextWindowTokens: 1000,
      });
      assert.strictEqual(r.summaryGenerated, false);
      assertQuantified(seen);
      assert.match(seen[0].text, /1\/5 条消息/);
    } finally {
      delete process.env.KHY_COMPACT_AUDIT;
    }
  });
});

test('冷却期跳过有用户可见输出，且给出「已等/需等」比例', async () => {
  await withNotices(async (seen) => {
    process.env.KHY_COMPACT_AUDIT = '0';
    try {
      const msgs = Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: 'y'.repeat(400),
      }));
      compressor.resetAntiJitter();
      await compressor.compress(msgs, {
        estimateTokensFn: estimate,
        contextWindowTokens: 200,
        callModelFn: async () => ({ reply: '摘要内容：这是一段足够长的压缩摘要文本，用于通过长度下限检查。' }),
      });
      seen.length = 0;
      await compressor.compress(msgs, { estimateTokensFn: estimate, contextWindowTokens: 200 });
      assertQuantified(seen);
      assert.match(seen[0].text, /冷却期/);
      assert.match(seen[0].text, /\d+s\/\d+s/, '冷却期必须给出「已等/需等」比例');
    } finally {
      delete process.env.KHY_COMPACT_AUDIT;
    }
  });
});

test('摘要模型抛异常 ⇒ 降级为本地抽取，用户可见且审计记为失败', async () => {
  await withNotices((seen) =>
    withTmpHomeAsync(async () => {
      compressor.resetAntiJitter();
      const msgs = Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `第 ${i} 条消息 ` + 'z'.repeat(400),
      }));
      const r = await compressor.compress(msgs, {
        estimateTokensFn: estimate,
        contextWindowTokens: 300,
        callModelFn: async () => {
          throw new Error('模型不可达。ECONNREFUSED 127.0.0.1:11434');
        },
      });

      assert.strictEqual(r.summaryGenerated, true, '降级后压缩仍然完成');
      const degrade = seen.filter((n) => /摘要模型调用失败/.test(n.text));
      assert.strictEqual(degrade.length, 1, '摘要失败必须恰好报一次，不得静默');
      assertQuantified(degrade);
      assert.strictEqual(degrade[0].level, 'warn');

      const rows = audit
        .queryAuditLog({ tool: 'context-compress-degrade' })
        .filter((e) => e.params.reason === 'ai-summary-call-failed');
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].result.success, false);
      // 一个 message 里带 "ECONNREFUSED" 但没有 err.code 的普通 Error 无法被
      // 可靠归类 —— 此时必须落到调用方给的 fallbackCode，而不是靠猜字符串。
      assert.strictEqual(rows[0].params.errorCode, 'CONTEXT_SUMMARY_FAILED');
      assert.ok(rows[0].result.error.length <= 200, 'error 仍受 200 字符上限约束');
      // 成功那一行要标明摘要其实来自本地抽取，而不是模型。
      const okRow = audit.queryAuditLog({ tool: 'context-compress' })[0];
      assert.strictEqual(okRow.params.summarySource, 'manual-extract');
    })
  );
});

test('弱模型输出过短 ⇒ 报「输出过短」而不是伪装成功', async () => {
  await withNotices(async (seen) => {
    process.env.KHY_COMPACT_AUDIT = '0';
    try {
      compressor.resetAntiJitter();
      const msgs = Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `第 ${i} 条 ` + 'w'.repeat(400),
      }));
      await compressor.compress(msgs, {
        estimateTokensFn: estimate,
        contextWindowTokens: 300,
        callModelFn: async () => ({ reply: '好的' }), // 2 字符，远低于下限
      });
      const short = seen.filter((n) => /输出过短/.test(n.text));
      assert.strictEqual(short.length, 1);
      assert.match(short[0].text, /2\/20 字符/, '必须给出「实际/要求」比例');
    } finally {
      delete process.env.KHY_COMPACT_AUDIT;
    }
  });
});

test('KHY_COMPACT_NOTICE=0 ⇒ 提示层可一键关回原样', async () => {
  await withNotices(async (seen) => {
    process.env.KHY_COMPACT_NOTICE = '0';
    process.env.KHY_COMPACT_AUDIT = '0';
    try {
      compressor.resetAntiJitter();
      await compressor.compress([{ role: 'user', content: 'hi' }], {
        estimateTokensFn: estimate,
        contextWindowTokens: 1000,
      });
      assert.strictEqual(seen.length, 0);
    } finally {
      delete process.env.KHY_COMPACT_NOTICE;
      delete process.env.KHY_COMPACT_AUDIT;
    }
  });
});

test('没有注册渲染器时回落到注入的 logger（不让提示消失）', async () => {
  const infoed = [];
  uiPort._resetForTest(); // 无渲染器
  process.env.KHY_COMPACT_AUDIT = '0';
  try {
    compressor.resetAntiJitter();
    await compressor.compress([{ role: 'user', content: 'hi' }], {
      estimateTokensFn: estimate,
      contextWindowTokens: 1000,
      logger: { info: (m) => infoed.push(m), warn: (m) => infoed.push(m), error: () => {} },
    });
    assert.strictEqual(infoed.length, 1, '无渲染器时提示必须落到 logger');
    assert.match(infoed[0], /1\/5 条消息/);
  } finally {
    delete process.env.KHY_COMPACT_AUDIT;
    compressor.resetAntiJitter();
  }
});

test('审计层自身故障不会影响压缩结果（fail-soft 传导）', async () => {
  const saved = process.env.KHY_APP_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-audit-blk2-'));
  const blocked = path.join(tmp, 'blocked-file');
  fs.writeFileSync(blocked, 'x');
  process.env.KHY_APP_HOME = blocked;
  _reset();
  uiPort._resetForTest();
  try {
    compressor.resetAntiJitter();
    const r = await compressor.compress([{ role: 'user', content: 'hi' }], {
      estimateTokensFn: estimate,
      contextWindowTokens: 1000,
    });
    assert.strictEqual(r.summaryGenerated, false);
    assert.ok(Array.isArray(r.compressed), '审计写不进去也要正常返回结果');
  } finally {
    if (saved === undefined) {
      delete process.env.KHY_APP_HOME;
    } else {
      process.env.KHY_APP_HOME = saved;
    }
    _reset();
    compressor.resetAntiJitter();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
