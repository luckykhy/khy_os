<!-- 受众: 人+AI | 用途: skill 集合总说明——怎么安装、有哪些、何时用哪个 -->
# 🧩 Khy 指导 Skill 集合 · 总说明

> **这是什么**：一套可安装进 khy 的 skill，专门用来**指导比强模型更弱的模型正确、安全地使用 Khy-OS**。
> 你平时主要用小模型——把这些 skill 装上，小模型在需要时激活对应 skill，就能拿到本项目的
> 改代码纪律、排错手册、收尾规范、发布自保等"现成脑子"，少犯错、不越改越坏。

本 skill 集合是 [AI 协作预设包](../00_INDEX_总入口.md) 的可执行版本：文档是给你/AI 读的，skill 是让模型**在 khy 里随时调用**的。

---

## 🧑 给人看 · 怎么安装到 khy

每个 skill 是一个目录（含 `manifest.json` + `prompt.md`），khy 原生格式，装上后会有 `/` 斜杠命令。

**方式 A：逐个导入（推荐，最稳）**
```bash
# 在仓库根目录，把某个 skill 目录导入
node services/backend/bin/khy.js skill import docs/AI协作预设包/skills/khy-onboarding
node services/backend/bin/khy.js skill import docs/AI协作预设包/skills/khy-safe-change
# ……其余同理
```

**方式 B：批量导入（一条命令装全部）**
```bash
for d in docs/AI协作预设包/skills/*/; do
  node services/backend/bin/khy.js skill import "$d"
done
```

**方式 C：直接放进用户 skill 目录**（khy 启动时自动发现）
把 `docs/AI协作预设包/skills/` 下各目录拷到 `~/.khy/skills/` 即可。

**装好后验证**：
```bash
node services/backend/bin/khy.js skill list        # 应能看到 khy-onboarding 等
```
之后在对话里输入 `/khy-onboarding` 等即可激活；小模型也能在合适场景自动触发（除非该 skill 设了 disable-model-invocation，本集合默认允许模型调用）。

> 导入后 skill 落在 `~/.khy/skills/<name>/`，默认启用。要停用某个：`skill disable <name>`。

---

## 🤖 给 AI 看 · 这套 skill 是什么、何时激活哪个

你是在 Khy-OS 里工作的模型。遇到下面的处境，**主动激活对应 skill** 获取该场景的正确做法：

| 处境 | 激活 | 作用 |
| --- | --- | --- |
| 刚开始为本项目工作、不了解结构 | `/khy-onboarding` | 一次读懂项目/去哪改/红线 |
| 要修改或新增任何代码 | `/khy-safe-change` | 加法式改动纪律 + 叶子/接线模板 |
| 你是较弱/较小模型，或任务复杂 | `/khy-weak-model-guardrails` | 一次一步、防截断、防上下文爆、工具调用规范 |
| 不知道下一步做什么 | `/khy-pick-task` | 优先级决策 + 转成加法式小任务 |
| 出错/没生效/怀疑改坏 | `/khy-troubleshoot` | P/W/B/G/E 五类错误自查 |
| 网关 404 / 鉴权 / 模型路由异常 | `/khy-gateway-fix` | 网关五类坑对症修法 |
| 准备发布 pip 或改动影响分发 | `/khy-release-safety` | 发布前最小闭环 + 版本一致 |
| 准备说"做完了" | `/khy-honest-closure` | 诚实收尾模板，防未交付截断 |

**典型串联**：`/khy-onboarding` → （弱模型再加 `/khy-weak-model-guardrails`）→ `/khy-pick-task` → `/khy-safe-change` → 出错 `/khy-troubleshoot`（网关问题 `/khy-gateway-fix`）→ `/khy-honest-closure` →（发布）`/khy-release-safety`。

---

## 集合清单（8 个）

| Skill | 触发 | 一句话 |
| --- | --- | --- |
| khy-onboarding | `/khy-onboarding` | 接手速成：项目是什么/去哪改/红线 |
| khy-safe-change | `/khy-safe-change` | 加法式改动纪律 R1–R9 + 模板 |
| khy-weak-model-guardrails | `/khy-weak-model-guardrails` | 弱模型护栏：一次一步、防截断 |
| khy-pick-task | `/khy-pick-task` | 选活决策 + 转加法式小任务 |
| khy-troubleshoot | `/khy-troubleshoot` | 错误自查 P/W/B/G/E |
| khy-gateway-fix | `/khy-gateway-fix` | 网关/模型路由五类坑 |
| khy-release-safety | `/khy-release-safety` | 发布前自保 + 版本一致 |
| khy-honest-closure | `/khy-honest-closure` | 诚实收尾防未交付 |

---

## 与文档的关系

- **文档**（`给人看/` `给AI看/`）：读一遍理解全局，或整段复制粘贴给外部 AI。
- **Skill**（本目录）：装进 khy，模型在 khy 会话内**随时激活**，把纪律变成可调用的动作。

两者内容同源、互补。文档用于"讲清与传阅"，skill 用于"现场执行"。

*集合入口：本文件；整套包入口：[`../00_INDEX_总入口.md`](../00_INDEX_总入口.md)。*
