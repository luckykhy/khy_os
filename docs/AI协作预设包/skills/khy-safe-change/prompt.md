# Khy-OS 加法式改动纪律（改代码前照做）

在 Khy-OS 改代码**只有一种被接受的姿势**。严格照做，否则守卫会拦、或把项目改坏。

## 九条铁律（R1–R9）

- **R1 加法式**：新逻辑只加不改。先 `grep` 有没有现成实现可复用；绝不为同一概念写第二份真源。
- **R2 纯叶子**：新逻辑写成一个**纯叶子模块**——零 IO、确定性、**绝不抛异常**（坏输入返安全默认）、可单测、不 `require` 重依赖。
- **R3 门控**：用一个 `KHY_XXX` 环境变量门控，**默认开**；登记到 `services/backend/src/services/flagRegistry.js`；父门控关 → 子门控必关。
- **R4 逐字节回退**：`KHY_XXX` 关闭时，行为和改动前**逐字节相同**。接线处 `try/catch`，叶子异常 fail-soft 回退旧行为。
- **R5 严格超集**：只在旧路径**漏做/做错**处补正，绝不改变既有正确路径的输出；安全向只多封锁/多清理，不放宽。
- **R6 真接线**：必须能从 `executeTool`（`toolCalling.js`）/ `toolUseLoop.js` / `aiManagementServer.js` 之一被 `require` 到才算"在产"。**隔离单测全绿 ≠ 在产。**
- **R7 守卫绿**：改完跑相关单测；提交前守卫 `scripts/check-*.js`（git 钩子自动触发）必须**全绿**；绝不用 `git --no-verify` 跳过。
- **R8 不建上帝组件**：单文件不超 **2500 行**；拆分把内聚分节抽成纯叶子，原文件同名别名 re-export 保契约。
- **R9 诚实收尾**：如实说测了什么/几个绿/跳过了什么/哪些没做。（收尾模板见 `/khy-honest-closure`。）

## 可照抄的模板

**纯叶子模板**（新建 `services/backend/src/services/xxxGuard.js`）：
```js
function isEnabled(env = process.env) {
  try {
    const v = env && env.KHY_XXX;
    if (v == null) return true;                 // 默认开
    return !['0', 'false', 'off', 'no'].includes(String(v).trim().toLowerCase());
  } catch { return true; }
}
function decide(input) {
  try {
    // 纯计算，坏输入返安全默认
    return { ok: true, value: /* ... */ };
  } catch { return null; }                       // 绝不抛
}
module.exports = { isEnabled, decide };
```

**接线模板**（在真实消费点接入，保留旧值兜底）：
```js
let result = legacyValue;
try {
  const leaf = require('./xxxGuard');
  if (leaf.isEnabled(process.env)) {
    const d = leaf.decide(input);
    if (d) result = d.value;
  }
} catch { /* 保持 legacyValue，逐字节回退旧行为 */ }
```

**验回退**：临时设 `KHY_XXX=off` 跑同样输入，输出应与改动前**逐字节相同**。

## 动手前先声明（每次）

一句话说清：
> 我要改 `<文件>`，新增纯叶子 `<xxxGuard>`（门控 `KHY_XXX`，默认开），接线在 `<真实入口>`；关掉 `KHY_XXX` 逐字节回退旧行为。

用户确认后再改。

## fail-open vs fail-closed 别搞反

- 能力/约束**求解**异常 → fail-**open** 回旧管线（不因求解器崩了就卡死功能）。
- 红线/审批**判定** → 必须 fail-**closed**（判定失败按"不放行"处理）。

## 做完

跑相关单测 + 提交前守卫全绿，然后激活 `/khy-honest-closure` 诚实收尾。
