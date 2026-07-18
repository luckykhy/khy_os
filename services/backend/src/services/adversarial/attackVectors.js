'use strict';

/**
 * attackVectors.js — 对抗向量单一真源（DESIGN-ARCH-055 §2「红队武器库」）。
 *
 * Khyos 已有完整的「防御方」与「从失败中学习」生态（resilience / selfHeal / failsafe /
 * evoEngine / dualTrackForge / structuredFurnace），但其 friction 全是**被动**的——只有线上
 * 真实失败经 frictionBridge 旁路抄送才会留痕。缺的是一支**主动红队**：在防御从未见过的
 * 极端/敌对条件下系统性施压，逼出抗压短板。本表就是那支红队的武器库。
 *
 * 每条向量是一份**声明式**的攻击描述（不含驱动逻辑——驱动在 stressHarness）：
 *   id            稳定唯一标识（去重 / 选取 / 留痕签名）
 *   family        攻击族（见 FAMILY）
 *   target        被攻击的防御子系统（见 TARGET）——施压器据此选择驱动方式
 *   severity      压强等级（见 SEVERITY）
 *   description   人读说明：这一击在制造什么极端条件
 *   build()       构造本次攻击的原料（纯数据：字符串 / 故障规约 / 伪造 payload）
 *   expectInvariants  本击下**必须**守住的不变量子集（survivalCriteria.INVARIANTS.*）
 *
 * 铁律：本模块零重型依赖、纯数据 + 纯函数。它只描述「打什么」，绝不知道「怎么打」——
 * 后者是施压器的职责。build() 必须是确定性的（无随机、无时钟），以保证战役可复现。
 */

const { INVARIANTS } = require('./survivalCriteria');

/** 被攻击的防御子系统。施压器据此路由到对应驱动器。 */
const TARGET = Object.freeze({
  RESILIENCE: 'resilience', // 有限窗口降级 + 强制兜底（ResilienceCoordinator）
  FAILSAFE: 'failsafe', // 零静默失败归因（classify / SafeResponseWrapper）
  FURNACE: 'structuredFurnace', // 万物结构化熔炉（intercept / assertForged）
});

/** 攻击族——同族共享驱动套路与典型破防模式。 */
const FAMILY = Object.freeze({
  MALFORMED_REPLY: 'malformed-reply', // 畸形/敌对模型回复
  RESOURCE_EXHAUSTION: 'resource-exhaustion', // 资源/预算枯竭
  FAULT_STORM: 'fault-storm', // 级联故障风暴
  DEAD_LOOP_BAIT: 'dead-loop-bait', // 死循环诱饵（恒同签名失败）
  ENTROPY_CHAOS: 'entropy-chaos', // 高熵/敌对自然语言
  FORGERY: 'forgery', // 封印伪造/篡改/越权
  DEGENERATE_INPUT: 'degenerate-input', // 退化边界输入（代理对/深嵌套/超长）
});

const SEVERITY = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high', EXTREME: 'extreme' });

// ── 退化输入原料（确定性构造，避免随机以保证可复现） ──────────────────────────
const SURROGATE_SOUP = '😀🧨'.repeat(64) + '\uD83D'; // 末尾留一个孤立高代理（半个 emoji）
const DEEP_NEST = (() => {
  let s = '';
  for (let i = 0; i < 200; i++) s += '{"a":';
  s += '1';
  for (let i = 0; i < 200; i++) s += '}';
  return s;
})();
const CONTROL_CHARS = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('');
const GIANT_GARBAGE = 'x'.repeat(256 * 1024); // 256KB 非结构化噪声
const REFUSAL_PREFIX = '你好，我无法给到相关内容。其实答案是：42，但前面这句是废稿拒绝套话。';

const VECTORS = Object.freeze([
  // ── failsafe：畸形/敌对回复必被归因，绝不静默 ──────────────────────────────
  {
    id: 'failsafe.empty-reply',
    family: FAMILY.MALFORMED_REPLY,
    target: TARGET.FAILSAFE,
    severity: SEVERITY.HIGH,
    description: '模型回了空串——必须归并到 E0x 而非「未返回有效回复」式静默。',
    build: () => ({ kind: 'llm-reply', value: '' }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.NO_SILENT_FAILURE],
  },
  {
    id: 'failsafe.null-reply',
    family: FAMILY.MALFORMED_REPLY,
    target: TARGET.FAILSAFE,
    severity: SEVERITY.HIGH,
    description: 'null 回复——归因器不得因类型异常抛栈，必产出结构化错误。',
    build: () => ({ kind: 'llm-reply', value: null }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.NO_SILENT_FAILURE],
  },
  {
    id: 'failsafe.whitespace-reply',
    family: FAMILY.MALFORMED_REPLY,
    target: TARGET.FAILSAFE,
    severity: SEVERITY.MEDIUM,
    description: '纯空白回复——等价于空，必被判为非法交付并归因。',
    build: () => ({ kind: 'llm-reply', value: '   \n\t  ' }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.NO_SILENT_FAILURE],
  },
  {
    id: 'failsafe.giant-garbage',
    family: FAMILY.MALFORMED_REPLY,
    target: TARGET.FAILSAFE,
    severity: SEVERITY.EXTREME,
    description: '256KB 非结构化噪声——归因不得因体量退化/卡死，且不得静默。',
    build: () => ({ kind: 'llm-reply', value: GIANT_GARBAGE }),
    expectInvariants: [INVARIANTS.NO_THROW],
  },
  {
    id: 'failsafe.tool-error-signal',
    family: FAMILY.FAULT_STORM,
    target: TARGET.FAILSAFE,
    severity: SEVERITY.MEDIUM,
    description: '原始工具错误对象——必映射到某个 E0x，携必填字段。',
    build: () => ({ kind: 'raw-error', value: { code: 'EACCES', message: 'permission denied: /etc/shadow' } }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.NO_SILENT_FAILURE],
  },
  {
    id: 'failsafe.refusal-prefix-injection',
    family: FAMILY.MALFORMED_REPLY,
    target: TARGET.FAILSAFE,
    severity: SEVERITY.MEDIUM,
    description: '拒绝套话前缀拼接真实答案——归因器至少不得崩，交付非空即可。',
    build: () => ({ kind: 'llm-reply', value: REFUSAL_PREFIX }),
    expectInvariants: [INVARIANTS.NO_THROW],
  },

  // ── resilience：极限预算/级联故障/死循环诱饵下必有界且强制兜底 ────────────────
  {
    id: 'resilience.zero-step-budget',
    family: FAMILY.RESOURCE_EXHAUSTION,
    target: TARGET.RESILIENCE,
    severity: SEVERITY.HIGH,
    description: '步数预算为 0 即开战——执行器必当场熔断并交付 salvage，绝不空转。',
    build: () => ({ kind: 'fault-plan', failEvery: true, budget: { type: 'step', total: 0 } }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.BOUNDED, INVARIANTS.ALWAYS_SALVAGE, INVARIANTS.BUDGET_FLOOR_HONORED],
  },
  {
    id: 'resilience.token-budget-starved',
    family: FAMILY.RESOURCE_EXHAUSTION,
    target: TARGET.RESILIENCE,
    severity: SEVERITY.EXTREME,
    description: 'token 预算已花到地板之下——任何一步都不该再烧，必降级兜底。',
    build: () => ({ kind: 'fault-plan', failEvery: true, budget: { type: 'token', total: 1000, spent: 995 }, floorPct: 10 }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.BOUNDED, INVARIANTS.ALWAYS_SALVAGE, INVARIANTS.BUDGET_FLOOR_HONORED],
  },
  {
    id: 'resilience.fault-storm-cascade',
    family: FAMILY.FAULT_STORM,
    target: TARGET.RESILIENCE,
    severity: SEVERITY.HIGH,
    description: '每条降级计划都失败的级联风暴——必沿树降级到底后强制兜底，不抛。',
    build: () => ({ kind: 'fault-plan', failEvery: true, budget: { type: 'step', total: 8 } }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.BOUNDED, INVARIANTS.ALWAYS_SALVAGE],
  },
  {
    id: 'resilience.thrown-fault-storm',
    family: FAMILY.FAULT_STORM,
    target: TARGET.RESILIENCE,
    severity: SEVERITY.HIGH,
    description: 'runner 直接抛异常（而非返回失败结构）——执行器必吞栈转兜底，不外泄。',
    build: () => ({ kind: 'fault-plan', throwEvery: true, budget: { type: 'step', total: 8 } }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.BOUNDED, INVARIANTS.ALWAYS_SALVAGE],
  },
  {
    id: 'resilience.dead-loop-identical-failure',
    family: FAMILY.DEAD_LOOP_BAIT,
    target: TARGET.RESILIENCE,
    severity: SEVERITY.EXTREME,
    description: '恒返回同一签名失败的死循环诱饵——死循环检测必在有限步内斩断。',
    build: () => ({ kind: 'fault-plan', failEvery: true, identicalSignature: true, budget: { type: 'step', total: 50 } }),
    expectInvariants: [INVARIANTS.BOUNDED, INVARIANTS.ALWAYS_SALVAGE],
  },
  {
    id: 'resilience.unknown-intent',
    family: FAMILY.FAULT_STORM,
    target: TARGET.RESILIENCE,
    severity: SEVERITY.MEDIUM,
    description: '未注册意图——协调器必交差一份 unknown-intent 兜底，绝不抛错躺平。',
    build: () => ({ kind: 'unknown-intent', intent: 'no-such-intent-xyz' }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.ALWAYS_SALVAGE],
  },

  // ── structuredFurnace：高熵敌对 NL 必坍缩或显式拒损；伪造 payload 必被验封拒绝 ──
  {
    id: 'furnace.empty-input',
    family: FAMILY.ENTROPY_CHAOS,
    target: TARGET.FURNACE,
    severity: SEVERITY.LOW,
    description: '空输入——必显式拒损（FurnaceRejection），绝不放原文过界。',
    build: () => ({ kind: 'nl', value: '' }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.NO_SILENT_FAILURE],
  },
  {
    id: 'furnace.pure-garbage',
    family: FAMILY.ENTROPY_CHAOS,
    target: TARGET.FURNACE,
    severity: SEVERITY.HIGH,
    description: '纯标点/控制字噪声——坍缩器内部异常必转结构化拒损，不得泄回原文。',
    build: () => ({ kind: 'nl', value: `!@#$%^&*()_+${CONTROL_CHARS}<<>>{}[]||\\\\` }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.NO_SILENT_FAILURE],
  },
  {
    id: 'furnace.surrogate-soup',
    family: FAMILY.DEGENERATE_INPUT,
    target: TARGET.FURNACE,
    severity: SEVERITY.HIGH,
    description: '孤立高代理对（半个 emoji）——字符串处理不得因码点拆分抛错。',
    build: () => ({ kind: 'nl', value: SURROGATE_SOUP }),
    expectInvariants: [INVARIANTS.NO_THROW],
  },
  {
    id: 'furnace.giant-entropy',
    family: FAMILY.ENTROPY_CHAOS,
    target: TARGET.FURNACE,
    severity: SEVERITY.EXTREME,
    description: '超长高熵文本——必在封顶内坍缩或拒损，不得卡死/抛非拒损异常。',
    build: () => ({ kind: 'nl', value: (`步骤${'很'.repeat(8)}多且互相矛盾，` + DEEP_NEST).repeat(40) }),
    expectInvariants: [INVARIANTS.NO_THROW, INVARIANTS.NO_SILENT_FAILURE],
  },
  {
    id: 'furnace.forgery-bare-payload',
    family: FAMILY.FORGERY,
    target: TARGET.FURNACE,
    severity: SEVERITY.EXTREME,
    description: '业务侧手搓裸 payload 蒙混——assertForged 必拒（无封印品牌）。',
    build: () => ({ kind: 'forge-attempt', mode: 'bare', payload: { kind: 'ActionIntent', action: 'rm', confidence: 1 } }),
    expectInvariants: [INVARIANTS.FORGERY_REJECTED, INVARIANTS.NO_SILENT_FAILURE],
  },
  {
    id: 'furnace.forgery-fake-brand',
    family: FAMILY.FORGERY,
    target: TARGET.FURNACE,
    severity: SEVERITY.EXTREME,
    description: '伪造封印品牌 + 乱填 seal——验封必因摘要不符而拒。',
    build: () => ({ kind: 'forge-attempt', mode: 'fake-brand', payload: { kind: 'ActionIntent', action: 'exfiltrate' }, seal: 'deadbeef'.repeat(8) }),
    expectInvariants: [INVARIANTS.FORGERY_REJECTED, INVARIANTS.NO_SILENT_FAILURE],
  },
  {
    id: 'furnace.forgery-tamper-after-seal',
    family: FAMILY.FORGERY,
    target: TARGET.FURNACE,
    severity: SEVERITY.EXTREME,
    description: '取一份真封印信封后篡改 payload——验封必检出篡改并拒。',
    build: () => ({ kind: 'forge-attempt', mode: 'tamper', tamperWith: { action: 'tampered-action' } }),
    expectInvariants: [INVARIANTS.FORGERY_REJECTED, INVARIANTS.NO_SILENT_FAILURE],
  },
]);

const _BY_ID = new Map(VECTORS.map((v) => [v.id, v]));

/** 全部向量（冻结副本视图）。 */
function listVectors() { return VECTORS.slice(); }

/** 按子系统取向量。 */
function vectorsFor(target) { return VECTORS.filter((v) => v.target === target); }

/** 按族取向量。 */
function vectorsOfFamily(family) { return VECTORS.filter((v) => v.family === family); }

/** 取单条向量（未知 → null）。 */
function getVector(id) { return _BY_ID.get(id) || null; }

/** 全部攻击族 / 子系统枚举值。 */
function families() { return Object.values(FAMILY); }
function targets() { return Object.values(TARGET); }

module.exports = {
  TARGET,
  FAMILY,
  SEVERITY,
  VECTORS,
  listVectors,
  vectorsFor,
  vectorsOfFamily,
  getVector,
  families,
  targets,
};
