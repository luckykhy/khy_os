# Reddit 文案草稿

发到两个 sub，**错开时间**（不要在同一分钟）。先读每个 sub 的规则——
有些要求打 flair，或在特定日子禁止 Show-and-Tell 类帖子。

---

## r/programming

**标题：** `khy: a one-person AI-native OS — hand-written C kernel + a Claude-Code-class agent + a 16-backend AI gateway, in one pip install`

**正文：**

我基本是独自在做 khy：一次把 AI 原生计算机的每一层，塞进一个可安装的
仓库里的尝试。

- **内核（C）：** 抢占式调度器、按需分页、写时复制 `fork`、POSIX 风格
  信号、管道、每进程 fd 表、ELF + PE 双加载器。能在 QEMU 下启动。
  实验性——下一步是真正的键盘 stdin + 块设备持久化。
- **智能体 CLI：** 流式 Ink TUI、带结构化结果 + 循环检测的工具调用循环、
  权限门控、子智能体、目标模式。与 Claude Code / Qwen Code / OpenCode 做过基准对比。
- **AI 网关：** 一个 API 前置 16 个后端（Claude、Qwen、Cursor、Kiro、
  Ollama、Codex…），级联故障转移 + 熔断。自带 key。

安装：`pip install khy-os` 或 `npm i -g @khy-os/khy-os`（同一套工坊，两个渠道）。

它是「源码可得」的（可免费运行/研究/非商业使用），不是 OSI 开源。
演示 GIF 和 QEMU 已测试的能力表都在 README 里。欢迎狠批——尤其是
智能体循环和内核设计。

Repo: <link>

---

## r/LocalLLaMA

**标题：** `khy: bring-your-own-keys agentic CLI that fronts 16 AI backends (incl. Ollama) behind one API — part of a one-person AI-native OS`

**正文：**

khy 中这个 sub 会在意的部分：一个本地优先的 AI 网关 + 智能体终端，
**不会把你锁死在一个供应商上**。

- 一个端点前置 **16 个后端**——Claude、Qwen、Cursor、Kiro、
  Windsurf、Warp、Trae、**Ollama**、Codex、……——带级联故障转移、熔断，
  以及瞬时错误冷却。
- 自带 key；路由到**本地 Ollama** 模型，并在某个渠道挂掉时自动回退到
  托管模型（或反之）。
- 在其之上是一个 Claude-Code 风格的智能体循环：流式 TUI、工具调用、权限
  门控、子智能体、目标模式。
- 如果你想为团队自托管，还有带按用户隔离的多租户网关。

`pip install khy-os` / `npm i -g @khy-os/khy-os`。它是一个更大项目的一个切片——
一个人做的 AI 原生 OS，还包含一个手写 C 内核——但网关 + 智能体
本身就能独立成立。

很想知道这里的人希望它支持什么样的本地模型路由配置。

Repo: <link>

---

**互动提示：** 头 2 小时快速回复评论；Reddit 排名对早期速度非常敏感。
回复要以实质内容开头，而非链接。
