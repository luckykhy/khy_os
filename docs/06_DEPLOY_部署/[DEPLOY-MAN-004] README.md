# khy 发布工具包

把 khy 从「已推到 GitHub」带到「登上首页」所需的一切。这些都是草稿——
把口吻改成你自己的，但结构是按各平台实际奖励什么样的帖子而调校过的。

> **关于「病毒式传播」的唯一实话：** 你无法*强求*它，但你可以
> 消除一个项目*传不开*的每一个理由。一份出色的 README、一段 30 秒的
> 「惊叹」、零摩擦的安装，以及一个人们愿意复述的故事。khy 有实质
> （一个人做的 AI 原生 OS）。这个工具包让实质变得可读。

## 钩子（到处都用）

> **一个人做的 AI 原生 OS：手写内核 + Claude-Code 级智能体
> + 16 后端 AI 网关，一次 `pip install` 即得。**

「这一切都是一个人做出来的」这个角度，就是传播机制。人们分享的是
*奇观*和*故事*，不是功能清单。

## 起飞前清单（在任何地方发帖之前做）

- [ ] **录好演示**（`docs/06_DEPLOY_部署/[DEPLOY-MAN-001] DEMO.md`）→ 提交 `assets/demo.gif`。没有
      演示 = 只能拿到一小部分 star。这是杠杆最大的单项。
- [ ] 把 README 徽章里的 GitHub slug `kodehu03/khy-os` 换成真实的。
- [ ] 设置 GitHub 仓库 **About**：描述 + topics（`docs/06_DEPLOY_部署/[DEPLOY-MAN-006] REPO_META.md`）。
- [ ] 上传一张**社交预览图**（Settings → Social preview）——用 banner。
- [ ] 验证 `pip install khy-os` 与 `npm i -g @khy-os/khy-os` 在干净机器上可用。
- [ ] 打开 **Discussions**；预置 1–2 个起始话题。
- [ ] 从 git remote 里**清除泄露的 GitLab token**（见仓库安全说明）。
- [ ] 确保 CI 为绿，这样徽章才会绿。

## 上线当天序列（时机很重要）

1. **周二–周四，约 08:00 ET**——Hacker News 与 Reddit 流量的最佳窗口。
2. 先发 **Show HN**（`docs/06_DEPLOY_部署/[DEPLOY-MAN-007] SHOW_HN.md`）。守在电脑前 3–4
   小时，快速回复每一条评论——早期互动决定排名。
3. 约 2 小时后，发到 **r/programming** + **r/LocalLLaMA**
   （`docs/06_DEPLOY_部署/[DEPLOY-MAN-005] REDDIT.md`）。不要同时交叉发帖；错开时间。
4. 发 **X/Twitter 长推**（`docs/06_DEPLOY_部署/[DEPLOY-MAN-008] TWITTER.md`）并置顶。
5. 可选：把 **Product Hunt** 排到下一个周二
   （`docs/06_DEPLOY_部署/[DEPLOY-MAN-002] PRODUCT_HUNT.md`）。

## 标题 A/B 选项（凭直觉选）

- "Show HN: khy – a one-person AI-native OS (hand-written kernel + agentic CLI)"
- "Show HN: I built an OS where the terminal is an AI agent"
- "Show HN: khy – Claude Code, a 16-backend gateway, and a real kernel, in one install"

## 什么会毁掉一次上线（要避免）

- 没有演示。（先修这个。）
- 过度宣称。HN 会对「OS」和「Claude-Code 级」施加压力测试——保留 README
  里已有的「QEMU 已测试 / 实验性」这些限定说明。
- 发完就消失。头一小时的回复比帖子本身更重要。
- 在帖子正文里乞讨 star。让作品自己去要。
