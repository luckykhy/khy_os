# 2026-09-13 Claude Code vs khy-os 终端对齐报告（第 1 次运行）

## 本次实测项
任务单中的「项1：`khy doctor` 健康自检」与「项2：单轮问答速度」两项合并为一次运行（本日为流水线首次运行，任务单尚不存在，已同步创建）。

## 工具可用性基线
- khy CLI：`D:\Portable\khy-os\khy.bat`，版本 v1.1.15（`--help` 输出），`khy doctor` exit=0
- Claude Code：`D:\Portable\Tools\nodejs\npm-global\claude.cmd`，版本 2.1.263

## 实测数据表

| 项目 | 命令 | 启动/命令耗时 | 结果 | 输出一致性 | 功能等价性 |
|------|------|--------------|------|-----------|-----------|
| khy doctor R1 | `khy doctor` | 906 ms | exit 0，输出 5 项检查（Node/npm/依赖/端口/claude CLI）+ 1 警告（双渠道 PATH 共存提示） | 与 Claude Code 无对等物 | khy-os 独有能力，不适用 |
| khy doctor R2 | `khy doctor` | 825 ms | 同上 | 同上 | 同上 |
| khy doctor R3 | `khy doctor` | 692 ms | 同上 | 同上 | 同上 |
| claude -p R1 | `claude -p "回答：Khy OS 项目的版本同步有哪两条轨道？"` | 181,262 ms | **exit 1**：`[claude-code:unrecognized_model] step-3.7-flash`，`Failed to authenticate. API Error: 401` | 无有效输出 | 不适用（鉴权失败，未产生回答） |
| claude -p R2 | 同上 | 183,259 ms | **exit 1**：同上 | 无有效输出 | 不适用 |
| khy -p R1（默认渠道） | `khy -p "1+1 等于几？只用一句话回答。"` | 219,993 ms | exit 2，JSON 错误：多渠道全部失败（Claude Direct ECONNREFUSED 127.0.0.1:3000；Trae 类渠道不可用） | 无有效回答 | 不适用 |
| khy -p R2（relay 渠道） | 同上 + `KHY_FORCE_CHANNEL=relay` | 187,520 ms | exit 0，输出 `Failed to authenticate. API Error: 401`（Codeium relay 渠道） | 无有效回答 | 不适用 |
| khy -p R3（agnes 渠道） | 同上 + `KHY_FORCE_CHANNEL=agnes` | 391,556 ms | exit 0，输出 `Failed to authenticate. API Error: 401` | 无有效回答 | 不适用 |

## 结论
1. **`khy doctor`（项1）—— 已对齐（khy-os 独有能力）**：三次运行 692–906 ms，稳定、输出含「动作+目标」且 5 项检查项均有状态标记；Claude Code 无对应 CLI 自检命令，按规则如实记录为 khy-os 独有，不做强行对齐。
2. **单轮问答速度（项2）—— 未对齐，需修改**：
   - 本机当前**所有 AI 渠道鉴权均失效**：khy 的 relay/agnes 渠道 401，Claude Code 本身也是 401（且提示 `unrecognized_model: step-3.7-flash`，指向某处配置的模型名失效）。
   - 因此**本次未获得任何一方的有效 AI 回答**，速度对比暂无法完成；两侧失败耗时都异常长（180s+ / 390s），疑似上游超时+重试逻辑拖累，建议后续排查（指向 `services/backend/src/services/gateway/aiGateway.js` 的重试/超时策略，以及 `~/.khyquant/config.json` / `.khy/api_keys.json` 的 key 有效性）。
   - 结论标记：**未对齐（需先修复鉴权，非代码功能缺失）**。

## 剩余待实测项清单（来自任务单）
- [x] 项1：khy doctor —— 本次完成
- [ ] 项2：单轮问答速度 —— 本次尝试，因双方鉴权 401 无法获得有效输出，需修复 key 后重测
- [ ] 项3：文件读取能力（AGENTS.md）
- [ ] 项4：CLI 命令执行（`dir /b .`）
- [ ] 项5：多轮上下文保持

## 建议修复项（不阻塞本次流水线）
1. 更新 `services/backend/.env` 中 Codeium relay 与 Anthropic 的 API key（401）。
2. 排查 Claude Code 配置的 `step-3.7-flash` 模型名来源（`[claude-code:unrecognized_model]` 报错），可能是某处遗留的环境变量指向已下线模型。
