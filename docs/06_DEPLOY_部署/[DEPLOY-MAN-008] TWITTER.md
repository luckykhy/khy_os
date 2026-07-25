# X / Twitter 长推草稿

置顶这条长推。把**演示 GIF 放在第 1 条推文上**——在 X 上视频就是全部。
让每条推文都能独立成立。

> 说明：X 主要面向英文受众，以下推文正文请保持英文原文照发。中文仅为对内备注。

---

**1/**
I built an AI-native OS. Mostly by myself.

A hand-written kernel + a Claude-Code-class terminal agent + a gateway over 16 AI
backends — in one `pip install`.

Here's what that actually means 🧵
[attach assets/demo.gif]

**2/**
Layer 1: a real kernel, in C.

Preemptive scheduler, demand paging, copy-on-write fork, POSIX-style signals,
pipes, per-process fd tables, ELF + PE dual loader.

It boots under QEMU. Still experimental — but it's a kernel, not a Linux wrapper.

**3/**
Layer 2: the terminal *is* an agent.

Streaming TUI, a tool-calling loop with structured results + loop detection,
permission gating, sub-agents, goal mode.

Same shape as Claude Code / Qwen Code — but yours, self-hostable.

**4/**
Layer 3: zero vendor lock-in.

One API in front of 16 backends — Claude, Qwen, Cursor, Kiro, Ollama, Codex… —
with cascade failover + circuit breaking.

Bring your own keys. A channel dies, it routes around it.

**5/**
It ships two ways from one codebase:

  pip install khy-os
  npm i -g @khy-os/khy-os

byte-identical workshop, self-healing multi-language dev env.

**6/**
Honest caveats, because they matter:
• kernel = learning-grade, not a daily driver
• "Claude-Code-class" = the loop/TUI feature set, not "beats it everywhere"
• source-available (free to run/study/use non-commercially), not OSI open source

**7/**
Why build all of it instead of one piece?

To see if one person + AI could credibly go kernel-to-agent — and to have a
machine where the whole stack, down to the syscall, is AI-native.

⭐ Repo + demo: <link>
RTs help more than you'd think.
```
```
---

**备注：** 发出长推后，再在最后一条推文下回复一次仓库链接
（有些客户端会隐藏推文串尾部的链接）。对任何好问题用引用推文 + 真实
回答的方式，让话题持续浮现。
