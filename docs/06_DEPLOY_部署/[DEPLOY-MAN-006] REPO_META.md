# GitHub 仓库元数据（在 Settings → General + About 侧栏设置）

可发现性是「病毒式传播」的一半——GitHub 搜索、topic 页面与社交卡片都从
这些字段读取。在你去任何地方发帖之前先设好它们。

## About → Description（≤350 字符）

> An AI-native operating system in one install: a hand-written C kernel, a
> Claude-Code-class agentic CLI, and a gateway over 16 AI backends (bring your
> own keys, no vendor lock-in). `pip install khy-os` / `npm i -g @khy-os/khy-os`.

## About → Website

指向文档索引或 PyPI 页面：`https://pypi.org/project/khy-os/`

## Topics（全部加上——它们喂给 topic 页面与搜索）

```
ai
agent
agentic
llm
cli
operating-system
kernel
osdev
ai-gateway
claude
ollama
developer-tools
terminal
tui
self-hosted
```

## 社交预览图（Settings → General → Social preview）

把 `assets/banner.svg` 导出为 1280×640 的 PNG 并上传。这是仓库被分享到
X / Slack / Discord / HN 时显示的卡片——一张空白的会浪费掉大部分点击。

## 其他一次性设置

- 启用 **Discussions**（社区问答带来回访 + star）。
- 启用 **Issues**（模板已在 `.github/ISSUE_TEMPLATE/`）。
- 在你的个人主页置顶该仓库。
- 在 GitHub 上为当前版本发一个 release，让 **Releases** 侧栏不为空
  （链接到 `CHANGELOG.md`）。
