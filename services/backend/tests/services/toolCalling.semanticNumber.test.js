'use strict';

/**
 * toolCalling.semanticNumber.test.js — CC `src/utils/semanticNumber.ts` 对齐的**端到端**集成。
 *
 * 对齐目标(CC 后端逻辑):LLM 生成的工具调用 JSON 偶发把数字加引号——
 * `{"head_limit":"30"}` 而非 `{"head_limit":30}`。CC 在 schema 校验**前**用 z.preprocess
 * 把「合法十进制字面量字符串」强制转成 number(对模型仍声明 type:'number',纯客户端隐形容错),
 * 故工具不会因模型的引号而调用失败。
 *
 * Khy 真缺口:`tools/_baseTool.js validateParams` 对 type:'number' 形参做 `typeof===number`
 * 严格判定 → 模型传 `"30"` 时 actualType='string'≠'number' → 整次工具调用被「Validation failed」拒。
 *
 * 本测试注册一个 risk:'safe'(自动放行 → 直达校验 + handler)的合成 builtin 工具,
 * 携带扁平 schema `{ head_limit: { type:'number' } }` 与一个**记录入参**的 handler,经真实
 * `executeTool` 漏斗验证:
 *   - 门控开:引号数字 `"30"` 通过校验,且 handler 收到的是 number 30(非字符串);
 *   - 门控关:逐字节回退旧行为 → 引号数字被校验拒,handler 绝不执行;
 *   - 真数字 `30` 两态恒通过(归一不影响合法数字路径);
 *   - 非法字面量 `"abc"`/`"1e3"` 两态恒被拒(绝不 Number() 兜底掩盖 bug)。
 */

const toolCalling = require('../../src/services/toolCalling');

const TOOL = '__semnum_probe__';
let received = null;

beforeAll(() => {
  toolCalling.registerTool({
    name: TOOL,
    description: 'test-only semantic-number coercion probe',
    risk: 'safe', // 自动放行,使非投机路径直达校验 + handler
    parameters: { head_limit: { type: 'number' } },
    handler: async (params) => { received = params; return { success: true, output: 'ran' }; },
  });
});

const SAVED = {};
// 隔离系统调用网关 / 持久权限库 / 人审门:它们各有独立放行 + 熔断路径,会拦截合成工具
// 的重复调用(无关本测试考查的「校验前数字归一」)。只留 executeTool 漏斗自身的校验/执行。
const ENV_KEYS = ['KHY_SEMANTIC_NUMBER', 'KHY_SYSCALL_GATEWAY', 'KHY_PERMISSION_STORE', 'KHY_HUMAN_GATE', 'KHY_CC_VALIDATION_ERROR'];
beforeEach(() => {
  received = null;
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  process.env.KHY_SYSCALL_GATEWAY = 'off';
  process.env.KHY_PERMISSION_STORE = 'false';
  process.env.KHY_HUMAN_GATE = 'off';
  // 本测试考查「校验前数字归一」(handler 是否收到 number / 是否被拒),与「校验失败消息
  // 的 CC 分组格式」(ccValidationError, KHY_CC_VALIDATION_ERROR)正交 → 钉到 off,断言留在稳定
  // 历史串 `Validation failed: …`。格式对齐由 tests/toolCalling.builtinSchemaValidation.test.js 专测。
  process.env.KHY_CC_VALIDATION_ERROR = 'off';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('semanticNumber coercion — executeTool 端到端', () => {
  test('门控开(默认):引号数字 "30" 通过校验且 handler 收到 number 30', async () => {
    delete process.env.KHY_SEMANTIC_NUMBER; // 默认开
    const res = await toolCalling.executeTool(TOOL, { head_limit: '30' }, {});
    expect(res.success).toBe(true);
    expect(received).not.toBeNull();
    expect(received.head_limit).toBe(30); // 字符串 → number
    expect(typeof received.head_limit).toBe('number');
  });

  test('门控关:引号数字 "30" 逐字节回退 → 校验拒,handler 绝不执行', async () => {
    process.env.KHY_SEMANTIC_NUMBER = 'off';
    const res = await toolCalling.executeTool(TOOL, { head_limit: '30' }, {});
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/Validation failed/);
    expect(String(res.error)).toMatch(/head_limit must be of type number, got string/);
    expect(received).toBeNull(); // handler 从未运行
  });

  test('真数字 30 两态恒通过(归一不影响合法数字路径)', async () => {
    for (const gate of [undefined, 'off']) {
      received = null;
      if (gate === undefined) delete process.env.KHY_SEMANTIC_NUMBER;
      else process.env.KHY_SEMANTIC_NUMBER = gate;
      const res = await toolCalling.executeTool(TOOL, { head_limit: 30 }, {});
      expect(res.success).toBe(true);
      expect(received.head_limit).toBe(30);
    }
  });

  test('非法字面量 "abc" 两态恒被拒(不 Number() 兜底)', async () => {
    for (const gate of [undefined, 'off']) {
      received = null;
      if (gate === undefined) delete process.env.KHY_SEMANTIC_NUMBER;
      else process.env.KHY_SEMANTIC_NUMBER = gate;
      const res = await toolCalling.executeTool(TOOL, { head_limit: 'abc' }, {});
      expect(res.success).toBe(false);
      expect(String(res.error)).toMatch(/must be of type number, got string/);
      expect(received).toBeNull();
    }
  });

  test('科学计数 "1e3" 即便门控开也被拒(CC 反对 Number() 兜底,继续诚实报错)', async () => {
    delete process.env.KHY_SEMANTIC_NUMBER; // 门控开
    const res = await toolCalling.executeTool(TOOL, { head_limit: '1e3' }, {});
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/must be of type number, got string/);
    expect(received).toBeNull();
  });
});
