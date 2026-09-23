<!--
模板：Bug 修复（主模板）
触发：.ai/hq/BUGS.json 中 status=open 的 Bug，由 `khy hq next` 自动填充渲染
占位符：{{KHYOS_PATH}} {{BUG_ID}} {{BUG_TITLE}} {{SEVERITY}} {{DOMAIN}} {{SYMPTOM}} {{REPRO}} {{SUSPECT}}
用法A：在 khy-os 目录内打开 AI，粘贴渲染后的整段提示词
用法B：在别处打开 AI 远程指挥时，`khy hq next` 用绝对路径填充 KHYOS_PATH，直接粘即可
-->

## 📋 提示词正文（复制下面代码块内的全部内容）

```text
【角色】你是 khy-os 仓库的资深维护工程师，负责定位并修复一个真实 Bug。
只做修复必需的最小改动，不做无关重构。

【目标 Bug】
- 编号：{{BUG_ID}}（优先级 {{SEVERITY}}）
- 标题：{{BUG_TITLE}}
- 所属域：{{DOMAIN}}
- 现象：{{SYMPTOM}}
- 复现步骤：{{REPRO}}
- 怀疑范围：{{SUSPECT}}

【工作目录】
{{KHYOS_PATH}}

【执行流程】
1. 先读 AGENTS.md 与 .ai/GUARDS.md 了解红线；再按怀疑范围阅读相关源码，
   用 node -e "require('...')" 或写临时探针脚本复现问题，确认根因后再动手。
2. 给出根因分析（一句话说清「为什么错」），然后实施最小修复。
3. 若修复触及启动/网络/任务执行/终端 UI，逐条自查下方工程红线第 1-4 条。
4. 修复完成后运行【验证命令】。完成定义：【验证命令】全绿 + 输出三段式报告。

【khy-os 工程红线（违反任何一条即返工）】
1. 零硬编码：不得引入字面量 IP、端口、绝对路径、生产域名；端点来自
   constants/serviceDefaults.js 或 env 覆盖。
2. 状态透明：面向用户的状态/日志必须「动作+目标+进度」；禁用
   「正在工作/处理中/Loading/Connecting/请稍候/Processing」单独出现。
3. 基于活动的超时：长任务禁止固定时长硬 kill，用空闲重置计时器。
4. 终端渲染：与回滚输出共存的 CLI 禁用 ANSI 滚动区 \x1B[n;mr。
5. 风格：JS 2 空格、单引号、分号；用户可见串中文；注释英文；
   fail-soft（叶子返回 {ok:false,error} 不抛）；优先编辑现有文件。
6. 不改 platform/khy_platform/__init__.py；版本号只在 4 个真源文件改。

【验证命令】（在 khy-os 根目录依次执行）
- node scripts/ci/check-agent-rules.js --changed   → 无 error
- cd services/backend && npx eslint src/ --max-warnings 0 && npx jest   → 全绿
- khy doctor                                       → 系统健康
若某命令不存在或与本改动无关，说明理由后跳过并如实报告。

【完成后的回填】
把根因与修法摘要交还给调用方（人工复制或由 `khy hq bug set BUG-XXX pending_verify
--root-cause "…" --fix "…"` 记录进 .ai/hq/BUGS.json 的 root_cause / fix_summary
字段），并将 Bug 状态推进到 pending_verify。
```

---

### 渲染说明

| 占位符 | 来源 |
|--------|------|
| `{{KHYOS_PATH}}` | 用法A填「当前目录」；用法B填 khy-os 绝对路径 |
| 其余 | .ai/hq/BUGS.json 对应字段，`khy hq next --bug BUG-XXX` 可自动渲染 |
