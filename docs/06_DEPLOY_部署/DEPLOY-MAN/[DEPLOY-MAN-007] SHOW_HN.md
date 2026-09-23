# Show HN 文案草稿

**标题：**
`Show HN: khy – a one-person AI-native OS (hand-written kernel + agentic CLI)`

**URL：** GitHub 仓库（不是博客文章——HN 更偏好源码）。

**首条评论（提交后立刻由你自己发出）：**

---

Hi HN. khy is a project I've been building largely solo. It's an attempt to put
every layer of an "AI-native" computer in one repo you can `pip install`:

- a hand-written OS kernel in C — preemptive scheduler, demand paging,
  copy-on-write `fork`, POSIX-style signals, pipes, per-process fd tables, and a
  dual ELF + PE loader. It boots and runs under QEMU. It is still experimental
  (next up: real keyboard stdin and block-device persistence), and I'd rather
  undersell it than oversell it.
- a terminal agent in the Claude Code / Qwen Code mold — streaming TUI, a
  tool-calling loop with structured results and loop detection, permission
  gating, sub-agents, and a goal mode.
- a gateway that fronts 16 AI backends (Claude, Qwen, Cursor, Kiro, Ollama,
  Codex, …) behind one API, with cascade failover and circuit breaking, so you
  bring your own keys and aren't locked to one vendor.

It ships through two parallel channels (`pip install khy-os` and
`npm i -g @khy-os/khy-os`) that carry a byte-identical workshop, with a self-healing
multi-language dev environment.

Why build all of it instead of one piece? I wanted to see whether a single
person, with AI assistance, could credibly span kernel-to-agent — and to have a
machine where the terminal *is* an agent, end to end, with no vendor lock-in.

Honest caveats: the kernel is a learning-grade microkernel/monolithic hybrid, not
a daily driver; "Claude-Code-class" means the loop/TUI feature set, benchmarked
against those tools, not that it beats them on every task. The license is
source-available (free to run/study/use non-commercially), not OSI open source —
happy to discuss that choice.

I'd love brutal feedback on: (1) the agent loop's correctness vs Claude Code,
(2) the kernel design, (3) whether the gateway's failover model makes sense.

Repo: <link>  ·  Demo: <gif link>

---

> 说明：HN 是英文社区，上面的标题与首条评论请保持英文原文照发，
> 不要翻译成中文再投递。以下为对内团队的中文备注。

**互动提示：**
- 在头 90 分钟内回复*每一条*顶层评论。
- 当有人质疑「这真的是 OS 吗？」——认同其中的细微之处，附上
  QEMU 已测试的能力表。不要辩护式回应；坦然承认局限。HN
  奖励坦诚，惩罚炒作。
- 备好演示 GIF；「让我看它跑起来」是第一诉求。
