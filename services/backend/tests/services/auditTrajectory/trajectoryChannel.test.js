'use strict';

/**
 * 审计轨迹通道测试。
 *
 * 核心用例（需求里点名要求的自检）：跑一段真实的多轮前端开发会话 —— 真的经过
 * hookSystem.trigger 触发、真的往盘上写文件、真的截图落盘 —— 然后用「{messages:[]}
 * 形态的通用解析器」回读，断言解析出的工具调用数与实际调用数完全一致。
 *
 * 这里刻意不 mock hookSystem：如果 hook 没真触发，或者 trigger 在未 init 时短路，
 * 工具调用数就会对不上，测试当场红。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const diffCapture = require('../../../src/services/auditTrajectory/diffCapture');
const parser = require('../../../src/services/auditTrajectory/parser');
const {
  AuditTrajectoryRecorder,
  normalizeOrigin,
  isoWithOffset,
} = require('../../../src/services/auditTrajectory/recorder');
const wire = require('../../../src/services/auditTrajectory/wire');
const hookSystem = require('../../../src/services/hooks/hookSystem');

let _tmpRoots = [];

function mkTmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `khy-audit-${tag}-`));
  _tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of _tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不算测试失败 */
    }
  }
  _tmpRoots = [];
});

// ── 一、需求点名的自检：真实多轮开发会话，工具调用数必须对得上 ──

describe('审计轨迹：真实多轮开发会话的工具调用数守恒', () => {
  /**
   * 一段真实的（会真的写盘的）多轮 Web 前端开发会话脚本。
   * 每个 call 的 run() 就是「工具真正干的事」，跑在 PreToolUse 与 PostToolUse 之间，
   * 与生产里工具执行引擎的时序一致。
   */
  function buildSession(workspace, shotsDir) {
    const file = (n) => path.join(workspace, n);
    const shot = path.join(shotsDir, 'round2-list.png');
    return [
      {
        prompt: '先把商品列表页的骨架搭出来，一个 index.html 加一个 app.js 就行，样式先不管',
        calls: [
          {
            toolName: 'Write',
            params: {
              file_path: file('index.html'),
              content: '<div id="app"></div>\n<script src="app.js"></script>\n',
            },
            run: (p) => fs.writeFileSync(p.file_path, p.content, 'utf-8'),
            result: { success: true, message: '已写入 index.html' },
          },
          {
            // 同一轮里第二次调 Write —— 覆盖并行同名调用的槽位配对
            toolName: 'Write',
            params: {
              file_path: file('app.js'),
              content: 'const items = [];\nfunction render() {\n  return items.length;\n}\n',
            },
            run: (p) => fs.writeFileSync(p.file_path, p.content, 'utf-8'),
            result: { success: true, message: '已写入 app.js' },
          },
        ],
      },
      {
        prompt: '列表点进去没反应，你把点击事件补上，顺手确认一下渲染函数真的被调到了',
        calls: [
          {
            // 只读工具：算工具调用，但不产生 diff 证据
            toolName: 'Read',
            params: { file_path: file('app.js') },
            run: () => {},
            result: 'const items = [];',
          },
          {
            toolName: 'Edit',
            params: {
              file_path: file('app.js'),
              old_string: 'const items = [];',
              new_string: 'const items = [1, 2, 3];',
            },
            run: (p) => {
              const cur = fs.readFileSync(p.file_path, 'utf-8');
              fs.writeFileSync(p.file_path, cur.replace(p.old_string, p.new_string), 'utf-8');
            },
            result: { success: true, message: '已编辑 app.js' },
          },
          {
            // 实跑 + 截图：另一条「有效轮证据」路径
            toolName: 'PowerShell',
            params: { command: 'node -e "console.log(1)"' },
            run: () => {
              fs.writeFileSync(shot, 'PNGDATA', 'utf-8');
            },
            result: { success: true, exitCode: 0, stdout: `渲染 3 条，截图见 ${shot}` },
          },
        ],
      },
      {
        prompt: '价格排序要能倒序切换，还有分页按钮的禁用态也一起处理掉',
        calls: [
          {
            toolName: 'MultiEdit',
            params: {
              file_path: file('app.js'),
              edits: [{ old_string: 'function render()', new_string: 'function renderSorted()' }],
            },
            run: (p) => {
              let cur = fs.readFileSync(p.file_path, 'utf-8');
              for (const e of p.edits) {
                cur = cur.replace(e.old_string, e.new_string);
              }
              fs.writeFileSync(p.file_path, cur, 'utf-8');
            },
            result: { success: true, message: '已应用 1 处编辑' },
          },
          {
            toolName: 'apply_patch',
            params: {
              patch: [
                `--- a/${file('index.html')}`,
                `+++ b/${file('index.html')}`,
                '@@ -1,1 +1,2 @@',
                ' <div id="app"></div>',
                '+<button id="sort">价格</button>',
                '',
              ].join('\n'),
            },
            run: () => {
              fs.appendFileSync(file('index.html'), '<button id="sort">价格</button>\n', 'utf-8');
            },
            result: { success: true, message: '补丁已应用' },
          },
        ],
      },
    ];
  }

  /** 真的走一遍 hookSystem.trigger，返回本次会话的实际调用数与轨迹文件。 */
  async function runRealSession() {
    const projectRoot = mkTmp('session');
    const workspace = path.join(projectRoot, 'workspace');
    const shotsDir = path.join(projectRoot, 'shots');
    const trajDir = path.join(projectRoot, 'traj');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(shotsDir, { recursive: true });

    // 干净的注册表：load() 内部会 _clearAll，避免别的测试留下的 hook 干扰计数
    hookSystem.reload(projectRoot);

    const attached = wire.attach({
      hookSystem,
      sessionId: 'real-dev-session',
      cwd: workspace,
      dir: trajDir,
      env: { KHY_AUDIT_TRAJECTORY: '1' },
    });
    expect(attached.enabled).toBe(true);

    const session = buildSession(workspace, shotsDir);
    let actualCalls = 0;
    let iteration = 0;

    for (const round of session) {
      iteration += 1;
      await hookSystem.trigger('PrePrompt', { prompt: round.prompt, iteration });
      for (const call of round.calls) {
        await hookSystem.trigger('PreToolUse', {
          toolName: call.toolName,
          params: call.params,
          iteration,
        });
        call.run(call.params); // 工具真正干活：真写盘
        actualCalls += 1;
        await hookSystem.trigger('PostToolUse', {
          toolName: call.toolName,
          params: call.params,
          result: call.result,
          elapsed: 12,
        });
      }
    }

    return { actualCalls, file: attached.recorder.file, recorder: attached.recorder, workspace };
  }

  test('通用 {messages:[]} 解析器读出的工具调用数 === 实际调用数', async () => {
    const { actualCalls, file } = await runRealSession();
    expect(actualCalls).toBe(7); // 2 + 3 + 2，脚本改了这里要一起改

    const parsed = parser.parseTrajectory(file);
    expect(parsed.malformed).toBe(0);
    // 这是需求点名的断言
    expect(parsed.toolCalls.length).toBe(actualCalls);
    // 每个 tool_result 都配得上一个 tool_use（结构完整，不是拍平的文本）
    expect(parsed.toolResults.length).toBe(actualCalls);
    const usedIds = new Set(parsed.toolCalls.map((c) => c.id));
    for (const r of parsed.toolResults) {
      expect(usedIds.has(r.tool_use_id)).toBe(true);
    }
  });

  test('工具调用保留结构：name 与 input 原样在 tool_use 块里，未被拍平成文本', async () => {
    const { file } = await runRealSession();
    const parsed = parser.parseTrajectory(file);

    expect(parsed.toolCalls.map((c) => c.name)).toEqual([
      'Write',
      'Write',
      'Read',
      'Edit',
      'PowerShell',
      'MultiEdit',
      'apply_patch',
    ]);
    // input 是对象而不是字符串摘要
    const edit = parsed.toolCalls.find((c) => c.name === 'Edit');
    expect(typeof edit.input).toBe('object');
    expect(edit.input.old_string).toBe('const items = [];');
    const multi = parsed.toolCalls.find((c) => c.name === 'MultiEdit');
    expect(Array.isArray(multi.input.edits)).toBe(true);
    expect(multi.input.edits[0].new_string).toBe('function renderSorted()');
  });

  test('每条事件都带 sessionId / ISO8601 带时区 timestamp / cwd / parentUuid 链', async () => {
    const { file, workspace } = await runRealSession();
    const parsed = parser.parseTrajectory(file);
    expect(parsed.events.length).toBeGreaterThan(0);

    for (const e of parsed.events) {
      expect(e.sessionId).toBe('real-dev-session');
      expect(e.cwd).toBe(workspace);
      expect(typeof e.uuid).toBe('string');
      // ISO8601 且带显式偏移（+08:00 / -05:00 / Z）
      expect(e.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/
      );
      expect(typeof e.type === 'string' || typeof e.role === 'string').toBe(true);
    }
    // 对话树可重建：除首条外每条的 parentUuid 都指向已出现过的事件
    expect(parser.verifyChain(parsed).ok).toBe(true);
    expect(parsed.events[0].parentUuid).toBeNull();
  });

  test('文件修改类工具的结果里带非空 diff，只读工具不伪造 diff', async () => {
    const { file } = await runRealSession();
    const parsed = parser.parseTrajectory(file);
    const byTool = (n) => parsed.toolResults.filter((r) => r.toolName === n);

    for (const name of ['Write', 'Edit', 'MultiEdit', 'apply_patch']) {
      const results = byTool(name);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(diffCapture.hasNonEmptyDiff(r.evidence)).toBe(true);
      }
    }
    // Read 是只读工具：没有 evidence，绝不能凭空造出「改了东西」
    for (const r of byTool('Read')) {
      expect(r.evidence).toBeUndefined();
    }
    // 新建文件的 diff 里能看到真实新增行
    const writes = byTool('Write');
    const ev = Array.isArray(writes[0].evidence) ? writes[0].evidence[0] : writes[0].evidence;
    expect(ev.changeKind).toBe('created');
    expect(ev.added).toBeGreaterThan(0);
    expect(ev.diff).toContain('<div id="app"></div>');
  });

  test('三轮全部判为有效轮，且三条件逐条有据', async () => {
    const { file } = await runRealSession();
    const audit = parser.auditTrajectory(file);

    expect(audit.total).toBe(3);
    expect(audit.rounds.map((r) => r.valid)).toEqual([true, true, true]);
    expect(audit.validCount).toBe(3);
    expect(audit.allValid).toBe(true);
    expect(audit.chain.ok).toBe(true);
    expect(audit.malformed).toBe(0);

    for (const r of audit.rounds) {
      expect(r.hasNewRequirement).toBe(true);
      expect(r.hasToolCall).toBe(true);
      expect(r.hasEvidence).toBe(true);
      expect(r.reasons).toEqual([]);
    }
    // 第二轮同时拿到了「非空 diff」和「运行 + 截图」两种证据
    expect(audit.rounds[1].verifiedByRunAndShot).toBe(true);
    expect(audit.rounds[1].diffFiles).toBeGreaterThan(0);
    // 提示词来源如实：运行时自动记录的一律 ai_generated
    expect(audit.origins.human).toBe(0);
    expect(audit.origins.ai_generated).toBe(3);
  });

  test('轨迹只增不减：多轮之后行数单调增长，append-only 自检通过', async () => {
    const { file, recorder } = await runRealSession();
    const lines = () => String(fs.readFileSync(file, 'utf-8')).split('\n').filter(Boolean).length;
    const before = lines();
    expect(before).toBeGreaterThan(7);

    recorder.recordNote('收尾旁注');
    expect(lines()).toBe(before + 1);

    expect(recorder.verifyAppendOnly().ok).toBe(true);
    expect(recorder.health().appendOnly).toBe(true);
    expect(recorder.health().status).toMatch(/^记录审计轨迹 .+：已写 \d+ 条 \/ \d+ 轮$/);
  });
});

// ── 二、永不压缩：与 checkpoint 压缩逻辑完全分离 ──

describe('审计轨迹：任何情况下不压缩、不裁剪、不摘要', () => {
  test('远超 6 条消息（aiSession 的压缩阈值）后仍逐条留存', () => {
    const dir = mkTmp('nocompact');
    const rec = new AuditTrajectoryRecorder({ sessionId: 'no-compact', cwd: dir, dir });
    for (let i = 1; i <= 40; i++) {
      rec.recordPrompt(`第 ${i} 轮的新增要求：把第 ${i} 个组件做出来`, { type: 'ai_generated' });
      rec.recordAssistant('', [{ id: `t${i}`, name: 'Write', input: { file_path: `c${i}.vue` } }]);
      rec.recordToolResult({ toolUseId: `t${i}`, name: 'Write', result: 'ok' });
    }
    const parsed = parser.parseTrajectory(rec.file);
    // session_start + 40 * 3
    expect(parsed.events.length).toBe(121);
    expect(parsed.toolCalls.length).toBe(40);
    expect(rec.round).toBe(40);
    // 第 1 轮的原文仍在（没有被「只保留最近 20%」吃掉）
    expect(
      parsed.messages.some((m) => parser.textOf(m.content).includes('第 1 轮的新增要求'))
    ).toBe(true);
  });

  test('模块内不存在任何 truncate / 覆盖写 的代码路径', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '../../../src/services/auditTrajectory/recorder.js'),
      'utf-8'
    );
    // 头部 docstring 会「提到」compactHistory 来解释为什么另开通道，所以先剥注释，
    // 只扫真正会执行的代码。
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/truncateSync|ftruncate/);
    // 唯一的文件打开点必须是 append 模式
    const opens = src.match(/fs\.openSync\([^)]*\)/g) || [];
    expect(opens.length).toBeGreaterThan(0);
    for (const o of opens) {
      expect(o).toContain("'a'");
    }
    // 代码里不调用任何压缩/摘要函数
    expect(src).not.toMatch(/compactHistory|compressMessages|summarizeMessages/);
    // 也不存在覆盖写轨迹文件的路径：writeFileSync 只允许写 sidecar，不许写 this.file
    expect(src).not.toMatch(/writeFileSync\(\s*this\.file/);
  });

  test('进程重启后续写同一文件而不是另起，历史一行不少', () => {
    const dir = mkTmp('resume');
    const a = new AuditTrajectoryRecorder({ sessionId: 'resume-me', cwd: dir, dir });
    a.recordPrompt('第一轮要求', { type: 'ai_generated' });
    a.recordAssistant('', [{ id: 'x1', name: 'Write', input: {} }]);
    const linesAfterA = String(fs.readFileSync(a.file, 'utf-8')).split('\n').filter(Boolean).length;

    const b = new AuditTrajectoryRecorder({ sessionId: 'resume-me', cwd: dir, dir });
    expect(b.file).toBe(a.file);
    expect(b.round).toBe(1); // 轮号接着数，不从 0 重来
    b.recordPrompt('第二轮要求', { type: 'ai_generated' });

    const parsed = parser.parseTrajectory(b.file);
    expect(parsed.events.length).toBe(linesAfterA + 1);
    expect(parser.verifyChain(parsed).ok).toBe(true);
    expect(parsed.events.filter((e) => e.type === 'prompt').map((e) => e.round)).toEqual([1, 2]);
  });
});

// ── 三、来源如实标注：禁止把自动生成的提示词标成 human ──

describe('审计轨迹：origin.type 如实标注', () => {
  test('缺 confirmedBy 的 human 一律降级为 ai_generated 并写明原因', () => {
    const o = normalizeOrigin({ type: 'human' });
    expect(o.type).toBe('ai_generated');
    expect(o.downgradedFrom).toBe('human');
    expect(o.reason).toContain('confirmedBy');
  });

  test('带人工确认署名的 human 被如实保留', () => {
    const o = normalizeOrigin({ type: 'human', confirmedBy: '孔浩原', draftId: 'd-7' });
    expect(o.type).toBe('human');
    expect(o.confirmedBy).toBe('孔浩原');
    expect(o.draftId).toBe('d-7');
    expect(o.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('origin 缺失或取值不合法都落到 ai_generated', () => {
    expect(normalizeOrigin().type).toBe('ai_generated');
    expect(normalizeOrigin({}).reason).toContain('缺失');
    expect(normalizeOrigin({ type: ' Human ', confirmedBy: '真人' }).type).toBe('human'); // 大小写与空格归一
    expect(normalizeOrigin({ type: 'operator' }).type).toBe('ai_generated');
    expect(normalizeOrigin({ type: 'operator' }).reason).toContain('operator');
  });

  test('wire 默认来源恒为 ai_generated —— 运行时不代真人盖戳', () => {
    const dir = mkTmp('origin');
    const hs = { registerFunction: jest.fn(), isInitialized: () => true };
    const attached = wire.attach({
      hookSystem: hs,
      sessionId: 'origin-default',
      cwd: dir,
      dir,
      env: { KHY_AUDIT_TRAJECTORY: '1' },
    });
    attached.handlers.onPrompt({ prompt: '把筛选条件做成可折叠的', iteration: 1 });
    const parsed = parser.parseTrajectory(attached.recorder.file);
    const p = parsed.events.find((e) => e.type === 'prompt');
    expect(p.origin.type).toBe('ai_generated');
    expect(p.origin.generator).toBe('khy-runtime');
  });
});

// ── 四、有效轮判定从严：三条件缺一即无效 ──

describe('审计轨迹：有效轮判定', () => {
  const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n');
  const prompt = (round, text) => ({
    uuid: `p${round}`,
    parentUuid: null,
    type: 'prompt',
    round,
    origin: { type: 'human', confirmedBy: '真人' },
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const toolUse = (round, id, name) => ({
    uuid: `a${id}`,
    type: 'assistant',
    round,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
  });
  const toolResult = (round, id, evidence) => ({
    uuid: `r${id}`,
    type: 'tool_result',
    round,
    toolName: 'Write',
    evidence,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  });

  test('缺「有可见工具调用」→ 无效', () => {
    const parsed = parser.parseTrajectoryText(jsonl([prompt(1, '把登录页的错误提示补上')]));
    const [r] = parser.judgeRounds(parsed).rounds;
    expect(r.valid).toBe(false);
    expect(r.hasToolCall).toBe(false);
    expect(r.reasons.join()).toContain('tool_use');
  });

  test('缺「非空 diff / 运行加截图」→ 无效', () => {
    const parsed = parser.parseTrajectoryText(
      jsonl([
        prompt(1, '把登录页的错误提示补上'),
        toolUse(1, 't1', 'Read'),
        toolResult(1, 't1', { path: 'a.js', empty: true, added: 0, removed: 0 }),
      ])
    );
    const [r] = parser.judgeRounds(parsed).rounds;
    expect(r.valid).toBe(false);
    expect(r.hasToolCall).toBe(true);
    expect(r.hasEvidence).toBe(false);
    expect(r.reasons.join()).toContain('既无非空 diff');
  });

  test('只说「继续」不算新增量要求 → 无效', () => {
    const parsed = parser.parseTrajectoryText(
      jsonl([
        prompt(1, '继续'),
        toolUse(1, 't1', 'Write'),
        toolResult(1, 't1', { path: 'a.js', empty: false, added: 3, removed: 0 }),
      ])
    );
    const [r] = parser.judgeRounds(parsed).rounds;
    expect(r.valid).toBe(false);
    expect(r.hasNewRequirement).toBe(false);
    expect(r.reasons.join()).toContain('续做指令');
  });

  test('与前一轮提示词高度重复 → 无效，并指名是第几轮撞的', () => {
    const text = '把商品列表的分页按钮的禁用态处理一下，顺便看看排序还对不对';
    const parsed = parser.parseTrajectoryText(
      jsonl([
        prompt(1, text),
        toolUse(1, 't1', 'Write'),
        toolResult(1, 't1', { path: 'a.js', empty: false, added: 3, removed: 0 }),
        prompt(2, text),
        toolUse(2, 't2', 'Write'),
        toolResult(2, 't2', { path: 'b.js', empty: false, added: 4, removed: 1 }),
      ])
    );
    const { rounds } = parser.judgeRounds(parsed);
    expect(rounds[0].valid).toBe(true);
    expect(rounds[1].valid).toBe(false);
    expect(rounds[1].reasons.join()).toMatch(/与第 1 轮提示词相似度/);
  });

  test('有验证事件但缺截图 → 不算「运行 + 截图」', () => {
    const parsed = parser.parseTrajectoryText(
      jsonl([
        prompt(1, '跑一下开发服务器确认能起来'),
        toolUse(1, 't1', 'PowerShell'),
        {
          uuid: 'v1',
          type: 'verification',
          round: 1,
          verification: { command: 'npm run dev', exitCode: 0, ran: true, captured: false },
          message: { role: 'user', content: [{ type: 'text', text: '验证 npm run dev' }] },
        },
      ])
    );
    const [r] = parser.judgeRounds(parsed).rounds;
    expect(r.valid).toBe(false);
    expect(r.verifiedByRunAndShot).toBe(false);
    expect(r.reasons.join()).toContain('运行 + 截图');
  });

  test('三条件齐备 → 有效轮', () => {
    const parsed = parser.parseTrajectoryText(
      jsonl([
        prompt(1, '把商品卡片的图片懒加载做掉'),
        toolUse(1, 't1', 'Edit'),
        toolResult(1, 't1', { path: 'card.vue', empty: false, added: 9, removed: 2 }),
      ])
    );
    const [r] = parser.judgeRounds(parsed).rounds;
    expect(r.valid).toBe(true);
    expect(r.toolCallCount).toBe(1);
    expect(r.added).toBe(9);
    expect(r.removed).toBe(2);
    expect(r.originType).toBe('human');
  });
});

// ── 五、门控与零影响 ──

describe('审计轨迹：门控', () => {
  test('KHY_AUDIT_TRAJECTORY 未开时不注册任何 hook', () => {
    const hs = { registerFunction: jest.fn(), isInitialized: () => true, init: jest.fn() };
    const envs = [
      {},
      { KHY_AUDIT_TRAJECTORY: '' },
      { KHY_AUDIT_TRAJECTORY: '0' },
      { KHY_AUDIT_TRAJECTORY: 'off' },
      { KHY_AUDIT_TRAJECTORY: 'false' },
    ];
    for (const env of envs) {
      expect(wire.attach({ hookSystem: hs, env }).enabled).toBe(false);
    }
    expect(hs.registerFunction).not.toHaveBeenCalled();
    expect(hs.init).not.toHaveBeenCalled();
  });

  test('hook 系统未 init 时 attach 主动补 init，否则 trigger 会短路', () => {
    const dir = mkTmp('init');
    let inited = false;
    const hs = {
      registerFunction: jest.fn(),
      isInitialized: () => inited,
      init: jest.fn(() => {
        inited = true;
      }),
    };
    wire.attach({
      hookSystem: hs,
      cwd: dir,
      dir,
      sessionId: 'init-me',
      env: { KHY_AUDIT_TRAJECTORY: '1' },
    });
    expect(hs.init).toHaveBeenCalledWith(dir);
    expect(hs.registerFunction).toHaveBeenCalledTimes(3);
  });

  test('已 init 时不重复 load 用户 hook 配置', () => {
    const dir = mkTmp('noinit');
    const hs = { registerFunction: jest.fn(), isInitialized: () => true, init: jest.fn() };
    wire.attach({
      hookSystem: hs,
      cwd: dir,
      dir,
      sessionId: 'already',
      env: { KHY_AUDIT_TRAJECTORY: '1' },
    });
    expect(hs.init).not.toHaveBeenCalled();
  });
});

// ── 六、证据采集细节 ──

describe('审计轨迹：证据采集与工具参数解析', () => {
  test('截图只认真实存在且非空的文件，不存在的路径不算证据', () => {
    const dir = mkTmp('shots');
    const real = path.join(dir, 'ok.png');
    const empty = path.join(dir, 'empty.png');
    fs.writeFileSync(real, 'PNG', 'utf-8');
    fs.writeFileSync(empty, '', 'utf-8');
    const missing = path.join(dir, 'nope.png');
    expect(wire.extractScreenshots({ stdout: `${real} ${empty} ${missing}` }, dir)).toEqual([real]);
  });

  test('apply_patch 从补丁头里抽出被改文件，跳过 /dev/null', () => {
    const patch = '--- a/src/a.js\n+++ b/src/a.js\n--- a/dev/null\n+++ b/src/new.js\n';
    const paths = wire.targetPaths('apply_patch', { patch });
    expect(paths).toContain('src/a.js');
    expect(paths).toContain('src/new.js');
    expect(paths.some((p) => p.includes('dev/null'))).toBe(false);
  });

  test('captureBefore 对不存在的文件也返回合法快照（新建文件的 before）', () => {
    const dir = mkTmp('before');
    const snap = diffCapture.captureBefore(path.join(dir, 'ghost.js'));
    expect(snap.exists).toBe(false);
    expect(snap.readError).toBeUndefined();
    expect(snap.text).toBeNull();
  });

  test('内容未变时 evidence.empty 为 true，不谎报改动', () => {
    const dir = mkTmp('nochange');
    const f = path.join(dir, 'same.js');
    fs.writeFileSync(f, 'const a = 1;\n', 'utf-8');
    const before = diffCapture.captureBefore(f);
    fs.writeFileSync(f, 'const a = 1;\n', 'utf-8'); // 原样重写
    const ev = diffCapture.captureAfter(before);
    expect(ev.empty).toBe(true);
    expect(ev.changeKind).toBe('modified');
    expect(diffCapture.hasNonEmptyDiff(ev)).toBe(false);
  });

  test('isoWithOffset 产出带偏移的 ISO8601', () => {
    const s = isoWithOffset(new Date(2026, 7, 23, 14, 2, 11, 482));
    expect(s).toMatch(/^2026-08-23T14:02:11\.482(?:Z|[+-]\d{2}:\d{2})$/);
  });
});
