<!--
  README owner/repo slug note (maintainer):
  Badges and clone URLs below use `kodehu03/khy-os` as the GitHub slug.
  Confirm/replace with the real GitHub owner/repo before publishing.
-->

<p align="center">
  <img src="assets/banner.svg" alt="khy — the AI-native operating system" width="100%">
</p>

<h1 align="center">khy</h1>

<p align="center">
  <b>The AI-native operating system.</b><br>
  A hand-written OS kernel + a Claude-Code-class agentic CLI + a 16-backend AI gateway.<br>
  One install, batteries included.
</p>

<p align="center">
  <a href="https://pypi.org/project/khy-os/"><img alt="PyPI" src="https://img.shields.io/pypi/v/khy-os?logo=pypi&logoColor=white&label=pip%20khy-os"></a>
  <a href="https://www.npmjs.com/package/@khy-os/khy-os"><img alt="npm" src="https://img.shields.io/npm/v/@khy-os/khy-os?logo=npm&label=npm%20%40khy-os%2Fkhy-os"></a>
  <a href="https://github.com/kodehu03/khy-os/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/kodehu03/khy-os/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/kodehu03/khy-os/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/kodehu03/khy-os/actions/workflows/codeql.yml/badge.svg"></a>
  <br>
  <img alt="License" src="https://img.shields.io/badge/license-Source--Available-blue">
  <img alt="Python" src="https://img.shields.io/badge/python-%E2%89%A53.8-3776AB?logo=python&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white">
  <img alt="Platforms" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="Made with C / JS / Python / MoonBit" src="https://img.shields.io/badge/built%20with-C%20%C2%B7%20JS%20%C2%B7%20Python%20%C2%B7%20MoonBit-orange">
</p>

<p align="center">
  <a href="#-60-second-tour">60-Second Tour</a> ·
  <a href="#-what-is-khy">What is khy</a> ·
  <a href="#-quickstart">Quickstart</a> ·
  <a href="#-the-three-pillars">The Three Pillars</a> ·
  <a href="#-how-it-compares">Compare</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

---

## 🤯 What is khy

**khy is a full AI-native operating system — written almost entirely by one
person.** It spans every layer most projects only touch one of:

- a **hand-written OS kernel** in C (preemptive scheduler, demand paging,
  copy-on-write `fork`, POSIX-style signals, pipes, per-process fd tables, a
  dual **ELF + PE** loader) that boots and runs under QEMU;
- a **Claude-Code-class agentic CLI** — streaming TUI, tool-calling loop,
  permission gating, sub-agents, workflows, goal mode, context compaction;
- a **16-backend AI gateway** that fronts Claude, Qwen, Cursor, Kiro, Windsurf,
  Warp, Trae, Ollama, Codex and more behind one API, with cascade failover and
  circuit breaking — **no vendor lock-in**;
- shipped through **two parallel package channels** (`pip install khy-os` /
  `npm i -g @khy-os/khy-os`) with a self-healing, multi-language dev environment.

> It's the kind of project that usually takes a team and a few years. Here it's
> one repo you can `pip install` in 30 seconds and run today.

---

## ⚡ 60-Second Tour

```bash
pip install khy-os        # or:  npm install -g @khy-os/khy-os
khy                       # launch the agentic terminal
```

```text
┌─ khy ─────────────────────────────────────────────── 18% ctx ─┐
│ › refactor the gateway adapter cascade and add a test          │
│                                                                │
│ 💭 思考 · 142 字 (Ctrl+O 展开)                                 │
│ ▸ 读取 · 编辑 · 执行命令 · 4 个步骤  ✓✓✓✓                       │
│   ✓ 完成                                                        │
│ ⠹ 生成中… · 12s · ~340 tok                                      │
└────────────────────────────────────────────────────────────────┘
```

> 📽️ **Demo recording:** drop an asciinema cast or GIF at `assets/demo.gif`
> and it renders here. See [`docs/launch/DEMO.md`](docs/06_DEPLOY_部署/%5BDEPLOY-MAN-001%5D%20DEMO.md) for the
> exact 45-second script that shows the kernel booting *and* the agent coding.

---

## 🚀 Quickstart

### Install (pick one channel — both ship the identical workshop)

```bash
# pip channel
python3 -m pip install -U khy-os

# npm channel
npm install -g @khy-os/khy-os
```

### Run

```bash
khy                       # agentic terminal (the headline experience)
khy preflight             # diagnose PATH / Node / deps / claude before first run
khy ai "summarize this repo"      # one-shot AI, no REPL
khy gateway status        # see which of the 16 AI backends are live
```

### Boot the actual OS

```bash
khy iso build --output dist/khy-os.iso     # build a bootable ISO
# then attach dist/khy-os.iso in QEMU / VMware / VirtualBox
```

New here? Follow the **0-to-power-user ladder**: [`新手成长路线`](docs/07_OPS_运维/%5BOPS-MAN-043%5D%20从0到高手-新手成长路线与pip安装后清单.md) (post-install checklist → configure AI → daily use → advanced → mastery).

Full guides: [`文档索引`](docs/00_INDEX_文档索引.md) · Windows + VMware: [`windows-vmware-清单`](docs/07_OPS_运维/%5BOPS-MAN-025%5D%20windows-vmware-清单.md)

---

## 🧱 The Three Pillars

### 1. A real, hand-written kernel

Not a wrapper around Linux — a kernel built from boot sector up, validated under
QEMU at every phase:

| Capability | Status |
|---|---|
| Preemptive scheduler + PS/2 keyboard + line-edited shell | ✅ QEMU-tested |
| Demand paging · copy-on-write `fork` · fault isolation | ✅ QEMU-tested |
| POSIX-style signals (`sigaction`/`sigreturn`) · pipes · per-process fd tables | ✅ QEMU-tested |
| Standard streams (fd 0–2) · shell pipelines (`\|`) | ✅ QEMU-tested |
| Dual binary loader: **ELF + PE** | ✅ QEMU-tested |

> Hybrid micro/monolithic design — performance paths in kernel space, I/O through
> IPC. Roadmap: real keyboard `stdin` and block-device persistence.

### 2. A Claude-Code-class agent in your terminal

- Streaming **Ink TUI** with collapsible process groups, persisted thinking,
  real context-fill meter, and a live token/stall indicator.
- A full **tool-calling loop** with structured results, loop detection, and
  `max_tokens` recovery — benchmarked against Claude Code / Qwen Code / OpenCode.
- **Permission gating**, `AskUserQuestion`, **sub-agents**, **goal mode**, and a
  **visual workflow editor** with a native execution engine.

### 3. A 16-backend AI gateway

One endpoint in front of every model you already pay for — **bring your own
keys, keep your data local**:

```
Claude · Qwen · Cursor · Kiro · Windsurf · Warp · Trae · Ollama · Codex · …
```

Cascade failover, circuit breakers, transient-error cooldown, and per-user
multi-tenant isolation. Falls back automatically when a channel goes down.

---

## 🗺️ Architecture

```text
            ┌──────────────────────────────────────────────┐
            │  khy CLI  ·  Ink TUI  ·  agent loop  ·  goals │   ← what you touch
            └───────────────┬──────────────────────────────┘
                            │
        ┌───────────────────┴────────────────────┐
        │   AI Gateway (16 adapters, failover)    │   ← bring your own keys
        │   Claude · Qwen · Cursor · Ollama · …   │
        └───────────────────┬─────────────────────┘
                            │
   ┌────────────────────────┴───────────────────────────┐
   │  Node backend  ·  tools  ·  workflows  ·  services  │   ← runtime
   └────────────────────────┬───────────────────────────┘
                            │
            ┌───────────────┴──────────────────┐
            │  khy kernel (C)  ·  ELF/PE loader │   ← the OS underneath
            │  scheduler · paging · IPC · fork  │
            └──────────────────────────────────┘

   Shipped as one workshop through two channels:  pip install khy-os  /  npm i -g @khy-os/khy-os
```

---

## 🆚 How It Compares

| | **khy** | Claude Code | Ollama | A Linux distro |
|---|:---:|:---:|:---:|:---:|
| Agentic coding CLI | ✅ | ✅ | ❌ | ❌ |
| Multi-provider, no lock-in | ✅ (16) | ❌ (1) | ✅ (local only) | — |
| Self-hostable / bring-your-own-keys | ✅ | ❌ | ✅ | — |
| Built-in AI gateway w/ failover | ✅ | ❌ | ❌ | ❌ |
| Hand-written OS kernel | ✅ | ❌ | ❌ | ✅ (a team) |
| One-command install | ✅ | ✅ | ✅ | ❌ |

> khy isn't trying to beat any one of these — it's the only project that is **all
> of them at once**, from the kernel to the agent.

---

## 📦 What's in the box

```text
platform/    Python launcher + bundled runtime + shared JS    (pip entrypoint)
services/    Node backend: CLI, gateway, adapters, tools, workflows
apps/        Vue management UI + upper-layer apps
kernel/      The OS: boot, src, ELF/PE loader, MoonBit (native/C output), ISO build
software/    khyquant — the default built-in app (quant trading)
docs/        架构 (architecture) · 指南 (guides) · 修复记录 (changelogs)
packaging/   npm channel (@khy-os/khy-os) mirroring the pip workshop
```

---

## 🛣️ Roadmap

- [ ] Real keyboard `stdin` + block-device persistence in the kernel
- [ ] Recorded boot-to-agent demo (`assets/demo.gif`)
- [ ] More gateway adapters + adapter capability matrix in docs
- [ ] Hosted playground

Changelog: [`CHANGELOG.md`](CHANGELOG.md)

---

## ⭐ Star history

<p align="center">
  <a href="https://star-history.com/#kodehu03/khy-os&Date">
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=kodehu03/khy-os&type=Date" width="640">
  </a>
</p>

---

## 🤝 Contributing & community

- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a PR.
- Be kind — see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
- Found a vulnerability? See [`SECURITY.md`](SECURITY.md) (please don't open a public issue).

---

## 📜 License

**Source-available.** khy is **free to download, run, study, and use
non-commercially** — see [`LICENSE`](LICENSE). Copying, modifying, or
redistributing the source, and commercial use, require written permission from
the author (孔浩原 / Kong Haoyuan). For commercial licensing or collaboration,
reach out.

---

<p align="center">
  <b>If a one-person AI-native OS is the kind of thing you want to exist,</b><br>
  ⭐ <b>star the repo</b> — it's the cheapest way to tell the author to keep going.
</p>
