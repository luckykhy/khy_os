# 演示视频（把它录下来——这是第一杠杆）

像 khy 这样的项目，成败系于一段 30–45 秒的片子，让人看完惊呼
「等等，这是*一个人*做出来的？」。录一次，就能在 README / HN / X / PH 上反复复用。

## 要拍什么（45 秒脚本）

故事线：**安装 → 智能体干真活 → 内核是真的。**

1. **（0–6s）安装。** 一个干净的终端：
   ```bash
   pip install khy-os && khy --version
   ```
   让版本号打印出来。快速切镜。

2. **（6–26s）智能体做点真事。** 启动 `khy`，敲一个真实任务：
   ```
   › add a /healthz route to the backend and a test for it, then run it
   ```
   让真实的 TUI 展现出来：折叠的 `💭 思考`、`▸ 读取 · 编辑 · 执行命令`
   进程组一路 `✓✓✓`、实时的 `⠹ 生成中… · Ns · ~tok` spinner，以及最后
   一个通过的测试。**不要**做不自然的加速——真实感才是重点。

3. **（26–40s）内核是真的。** 切到：
   ```bash
   khy iso build --output dist/khy-os.iso
   qemu-system-x86_64 -cdrom dist/khy-os.iso
   ```
   展示内核启动和一个 shell 提示符；敲一条命令（例如一个管道
   `ls | …`）来证明这是活的 shell，不是截图。

4. **（40–45s）尾卡。** 切回 README banner / 仓库 URL。

## 如何录制

- 终端部分用 **asciinema**（清晰、体积小、可复制粘贴）：
  ```bash
  asciinema rec demo.cast
  # ...do the steps...  then Ctrl-D
  ```
  用 `agg demo.cast assets/demo.gif` 转成 GIF（或保留 .cast 并嵌入
  asciinema 播放器链接）。
- QEMU 启动部分，录制窗口画面（例如 `peek`、`ffmpeg` 或 OBS），
  再与 asciinema GIF 拼接。

## 接进 README

一旦 `assets/demo.gif` 就位，把 `README.md` 里的占位块
（那段「📽️ Demo recording」备注）替换为：

```markdown
<p align="center"><img src="assets/demo.gif" alt="khy in action" width="800"></p>
```

把文件控制在 ~5 MB 以内，好让它在 GitHub 上瞬间加载——必要时裁剪或降低
帧率。一段要 8 秒才加载出来的演示，等于没人看的演示。
