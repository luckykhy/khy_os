# [DESIGN-ARCH-071] 通道选择决策矩阵

> **定位**：任何操作者（AI 助手、agent 工具循环、REPL、人类、外部脚本）要对 khy-os 做「一次读取或一次操作」时，在五条通道之间做选择的**单一真源**。
> **适用边界**：只裁决「用哪条通道完成这次操作」，不新增运行时业务逻辑，不替代 `[DESIGN-ARCH-068]`（代码层级与依赖方向）、`[DESIGN-ARCH-070]`（治理板块）、`[DESIGN-ARCH-056]`（桌面操控实现）；冲突时以各单一真源为准。
> **首屏速查**：`AGENTS.md` 架构速查的「通道选择判定」节是本矩阵的压缩版，二者必须同步修改。

---

## 0. 五通道定义与真源

| 通道 | 名称 | 入口 / 真源 | 前置条件 |
|---|---|---|---|
| CH-1 直接读状态 | 只读数据文件 | 数据目录（`src/utils/dataHome.js` 解析：env → `.khy/.location.json` → established-wins → 兜底；legacy `~/.khyquant`） | schema 已知且稳定；**仅限只读** |
| CH-2 服务层直调 | 同进程函数调用 | `require('.../src/services/<模块>')`（`AGENTS.md` 关键入口点表为索引） | 调用方与 backend 同一 Node 进程 |
| CH-3 CLI | `khy <命令>` | `src/cli/router.js`（大 switch）+ `aliases.js`（中文/拼音别名） | 本机可运行 khy（Python 启动器 → `bin/khy.js`） |
| CH-4 Web API | HTTP/WS/SSE → `src/routes/` | `server.js`（Express + WS 同端口）+ `constants/serviceDefaults.js`（端口真源）；运行时发现：数据目录 `ai_manage_runtime.json` 的 `apiPort` | server 在跑，或可被 CH-3 拉起（`khy server start`） |
| CH-5 看屏幕 | 截图与视觉观察 | `services/desktopControl/`（`screenCapture.js` + `safetyGate.js`）、`services/computerUse/`、L6 `tools/deepseek-eyes`（截图→VL 模型→文字） | `KHY_DESKTOP_CONTROL` 总闸开启 + safetyGate 审批放行 |

---

## 1. 判定顺序（五问，自上而下首个命中即停）

```text
Q0 目标信息是否只存在于第三方 GUI 画面，或需要人工视觉验证渲染效果？
   是 → CH-5（最后手段；先确认目标没有结构化接口）
   否 ↓
Q1 这次操作要改变系统状态吗（写/删/装/发/交易/审批…）？
   是 → 禁止 CH-1 直写状态文件 → 进 Q4 选「带副作用的正门」（CH-2/3/4）
   否 ↓
Q2 纯只读，且同时满足：schema 稳定、文件即最终真相、无需业务规则聚合加工？
   是 → CH-1（例：读 token_usage.json；从 ai_manage_runtime.json 发现 apiPort）
   否（需要聚合/校验/结论，如 doctor 体检、state 的 FSM 聚合）↓
Q3 调用方与 backend 在同一 Node 进程内吗（CLI handler、REPL/agent 工具循环、单测）？
   是 → CH-2（零序列化开销；遵守 fail-soft {ok, error} 叶子契约）
   否 ↓
Q4 调用方是谁 / 在哪？
   人 · Shell 脚本 · CI · 跨语言（Python 等）       → CH-3（别名表保证中文命令可达）
   前端页面 · 远程机器 · 多并发消费者 · WS/SSE 流式 → CH-4
   不确定 server 是否在跑：先按服务发现探测 CH-4（env → ai_manage_runtime.json），
   不可达 → 降级 CH-3（khy server start 拉起，或该事本可由 CLI 完成）
```

判定原则一句话：**结构化优先、只读才直读、写必走正门、视觉只兜底。**

---

## 2. 各通道适用 / 禁止 / 降级

| 通道 | 适用 | 禁止（反例） | 不可用时的降级 |
|---|---|---|---|
| CH-1 直接读状态 | 只读 + schema 稳定 + 文件即真相 | 任何写入（含「顺手修一下 JSON」）；读有校验逻辑包裹的聚合结论 | schema 不明 → CH-3 查 `khy state` / `khy doctor` 输出 |
| CH-2 服务层直调 | 同进程调用；单测；CLI handler 组合服务 | 前端（L3）require 后端（L2）源码——068 已禁，L3→L2 仅 HTTP；跨进程硬 require | 不在同进程 → CH-3 / CH-4 |
| CH-3 CLI | 人机交互；Shell/CI 脚本；跨语言；一次性运维 | 机器高频消费面向人的表格输出（优先找 `--json` 或用 CH-4） | 命令不存在 → 按「别名表→handler→router」三步加命令，不绕路模拟 |
| CH-4 Web API | 前端；远程；并发消费者；流式/长驻能力 | 端点写死 `localhost:3000`（工程规则 1 红线，`check-agent-rules.js` 拦截） | 探测不可达 → CH-3（`khy server start` 或等效 CLI 命令） |
| CH-5 看屏幕 | 第三方 GUI 的信息获取；自家前端的视觉验证 | 读取 CH-1/CH-3 可得的结构化信息；无审批的交互操控 | —（本身即兜底，无再降级） |

---

## 3. 反模式（命中即返工）

1. **直写状态文件改状态**：直接改 `.khy/` 下 JSON/SQLite 完成写操作——校验、审计、FSM 都在门内，必须走 CH-2/3/4 正门。
2. **看屏幕读自家结构化状态**：CH-1/CH-3 可得的信息（终端输出、JSON 状态）用截图/OCR 获取——既慢又不可靠。
3. **前端绕过 HTTP**：`apps/` 里 require `src/services/`（违反 068 依赖方向）。
4. **硬编码端点调 API**：违反工程规则 1；端点必须来自 serviceDefaults / env / 运行时发现三合法来源。
5. **有正门却模拟人**：存在现成 CLI/API 却用键鼠模拟点自家 UI 完成同样的事。
6. **REPL 内绕层直改文件**：agent 工具循环里新功能绕过服务层直接改数据文件。

---

## 4. 与既有治理的关系

- `[DESIGN-ARCH-068]` 管**代码**的层级与依赖方向（`npm run check:layout` 强制）；本文管**操作者**的通道选择。二者汇合点：L3→L2 仅 HTTP（即前端只走 CH-4）。
- `[DESIGN-ARCH-070]` 的 GOV-ACP / GOV-API 管**契约形状**（消息/字段/错误码）；本文管**该不该走这条通道**，不重复其条款。
- `[DESIGN-ARCH-056]` 是 CH-5 的实现真源（眼耳嘴体系、safetyGate 审批）；本文只登记「何时允许用它」。
- 机械可判定部分已由既有守卫覆盖（check:layout / check-agent-rules.js / check-tool-contract.js）；「操作者选错通道」属会话行为，靠本矩阵 + `AGENTS.md` 首屏曝光约束。若未来需要进一步工具化（如 lint 禁止 routes→cli 反向依赖），按 070 §6 模式登记缺口后另行立项。

---

## 5. 维护与验证

- 修改本文后运行：

```powershell
node scripts/ci/check-gov-rules.js
npm run check:layout
node scripts/ci/check-agent-rules.js --changed
```

- 新增第六条通道（如新的 IPC 通道）时：先在 §0 表加行，再过一遍 §1 五问确认不打乱判定顺序，最后同步 `AGENTS.md` 首屏速查与本目录 `00_INDEX`。

---

*创建：2026-08-28 · 指挥部任务 T-010 · 隶属 [DESIGN-ARCH-070] 治理体系的通道裁决层*
