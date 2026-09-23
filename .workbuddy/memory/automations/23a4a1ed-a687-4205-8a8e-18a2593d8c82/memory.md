# 自动化记忆：每日规范巡检（khy-os）

## 执行方式（已固化，2026-09-23 首跑验证）
- 脚本：`D:/Portable/khy-os/.khy/tmp/daily-audit/run-audit.js`（只读，跑 58 个仓库守卫；守卫清单在脚本顶部 GUARDS 数组）
- 运行：Bash 工具 + `run_in_background=true` + 受管 node 绝对路径，约 20 分钟
- 产物：同目录 `<日期>-audit-raw.json`（全量输出）与 `<日期>-audit-report.md`（人读报告）
- 收尾：present_files 交付当日报告 md；在本文件「执行历史」追加高层摘要
- 若脚本丢失需重建：要点 = spawnSync 受管 node 逐个跑仓库守卫（timeout 150s）+ git porcelain 快照 + counts 汇总 + 生成两份产物；不跑 `--changed` 类提交门与 conform:mcp/a2a

## 判读口径
- 非绿 = FAIL(exit≠0) 或 TIMEOUT；S1 守卫（copyright 等）恒 exit 0 只记录不阻断
- 漂移判断：对比前一日 raw json 同一守卫的 counts 行；零漂移 = 既有问题，非零漂移 = 当天新引入
- 工作区常有并行会话巨量未提交变动（首跑时 10189 条：A 9675 / AM 302 / ?? 210）；TIMEOUT 大概率由此导致，不要判成代码问题

## 执行历史
- **2026-09-23 首跑**（chore/tui-ux-nightly 分支）：58 守卫 → 47 PASS / 8 FAIL / 3 TIMEOUT。
  - TIMEOUT ×3：file-ratchet、node-syntax、dependency-size（疑因 10189 条未提交变动拖慢全量扫描）。
  - **env-gateway-pin 2 error（最高优先级）**：`services/.env:5` 与 `services/backend/.env:51` 硬钉 `GATEWAY_PREFERRED_ADAPTER=api` + `STRICT=true`（通道判死 = AI 全灭）；另 3 个 `.env.bak-*` 备份残留同类隐患。2026-09-17 曾第 3 次复发，建议按 LAYOUT-004 隔离备份。
  - **棘轮突破 3 处**（真实新增漂移，与 9675 条 staged 新增强相关）：pattern-coverage 3384>3238(+146)、tui-gates 226>220(+6)、code-standards 3 条基线（COMP-001-func +9 / COMP-001-nest +41 / COM-001 +45）。
  - layout FAIL：dangling-task 76（基线 88，改善中）、cross-layer-require 39（=基线）、root-junk 2 个怪名残留（`0)`、`x[1].toUpperCase()+`）需清理、layer-registry 2（backups、gui-test-screenshots，存量）。
  - arch-debt FAIL：基线悬空 12 条（domain 迁移后未 `--update-baseline`，会同时造成假绿/假红）。
  - reliability FAIL：1/13，toolCalling.js 未检出 Watchdog/timeout 保护。
  - permission-invariants FAIL：旧路径 `services/toolCallingPermissions.js` 找不到 PERMISSION_MODES 字面量（可能与 `services/tool/` 域迁移有关，需核对是真改坏还是守卫路径漂移）。
  - 亮点：版本同步、登记表、反孤儿（91 检查器全接线）、协议一致性/命名/契约、债务台账、软著就绪度（C-E4 自留底档 3/3 核验通过）全绿。
