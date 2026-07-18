<!-- 文档分类: OPS-MAN-008 | 阶段: 运维 | 原路径: docs/指南/deepseek-tui-资源清理对齐.md -->
# DeepSeek-TUI 资源回收与临时文件清理对齐清单

更新时间：2026-05-18  
参考基线：`/home/kodehu03/Downloads/DeepSeek-TUI-main.zip`（解压到`/tmp/DeepSeek-TUI-main`）

## 学习清单（先列清单）

1. 启动期残留临时文件清理（如特定前缀、老化判定、只清理托管目标）
2. 临时文件原子写入（同目录 tmp + rename，避免半写损坏）
3. 后台任务与子代理生命周期回收（cancel / completed / failed 后释放槽位）
4. 活动感知超时（idle/sliding timeout），避免“硬超时误杀活跃任务”
5. 优雅关闭（SIGINT/SIGTERM）与子进程回收（先协作关闭，再兜底 kill）
6. 快照/缓存保留策略（TTL、大小上限、数量上限）
7. 清理可观测性（清理了多少、释放多少、是否失败可追踪）
8. 可测试性（隔离临时目录、启动/清理行为可单测）

## 逐项对齐（状态追踪）

| # | DeepSeek 证据 | KHY-OS 现状 | 对齐动作 | 状态 |
|---|---|---|---|---|
| 1 | `crates/tui/src/snapshot/repo.rs`：`cleanup_stale_pack_temps(...)` 启动期清理 | `cleanupService.cleanOsTempFiles()`仅清理文件，且前缀覆盖不足 | 扩展为“托管前缀白名单 + 文件/目录 + 老化阈值 + 可测临时根目录” | 已完成 |
| 2 | `crates/cli/src/update.rs`：`tempfile_in` + `persist/rename` | `trimTrainingData()`直接覆盖写入 | 引入原子写 `atomicWriteText()`，训练数据裁剪改为原子落盘 | 已完成 |
| 3 | `docs/SUBAGENTS.md`：父取消联动子会话，完成后不占并发槽位 | `backend/src/coordinator/workerAgent.js` 已有级联 shutdown 与并发/深度控制 | 保持现状，补文档映射 | 已具备 |
| 4 | `crates/tui/src/client/chat.rs`：SSE idle timeout；`engine`取消令牌 | `spawnWithIdleTimeout`、`toolUseLoop`、`resourceGuard.startWatchdog` 已采用活动感知策略 | 保持现状，后续补更细粒度指标 | 已具备 |
| 5 | `engine.rs`/`lsp`：优雅 shutdown + fallback | `bootstrap/shutdown.js`、`ai-manage-daemon.js`、`processAgent.js` 已做信号处理与清理 | 保持现状，后续统一 shutdown 诊断输出格式 | 已具备 |
| 6 | `snapshot`：按年龄、体积、数量 prune + gc | `cleanupService`已有快照/日志/训练/遥测清理策略 | 后续考虑把“目录级预算”推广到更多运行时缓存目录 | 部分具备 |
| 7 | 多处日志含清理结果与错误信息 | `runCleanup().summary`已有 freed/actions 汇总 | 已增加“目标级耗时/失败计数 + 最近一次清理报告 + CLI 进度展示” | 已完成 |
| 8 | `tempfile::TempDir` 等隔离测试普遍使用 | 现有 `cleanupService.test.js`较轻量 | 新增 `cleanupService.tempCleanup.test.js` 覆盖老化文件/目录清理行为 | 已完成 |

## 本轮已落地变更

- `backend/src/services/cleanupService.js`
  - 新增 OS 临时目录托管前缀白名单（`khy_`/`khy-`/`khyquant_`/`khyquant-`）
  - `cleanOsTempFiles()`从“只删文件”升级为“可删老化目录 + 递归统计释放字节”
  - 支持 `KHY_OS_TEMP_DIR`（便于测试和灰度验证）
  - 新增 `atomicWriteText()`，并用于 `trimTrainingData()` 的落盘路径
- `backend/tests/services/cleanupService.tempCleanup.test.js`
  - 覆盖：老化托管文件删除、老化托管目录删除、新鲜托管文件保留、非托管文件保留

## 本轮新增落地（继续对齐）

- `backend/src/services/cleanupService.js`
  - `runCleanup()`新增 `metrics`（目标级耗时、失败计数、目标总数）
  - 新增最近一次清理报告缓存 `getLastCleanupReport()`
  - `startPeriodicCleanup({ skipInitial })` 支持跳过首轮，避免启动阶段重复清理
- `backend/src/bootstrap/prefetch.js`
  - 启动延迟任务改为：`runCleanup({ trigger: 'startup' })` 后 `startPeriodicCleanup({ skipInitial: true })`，避免重复执行
- `backend/src/cli/router.js`、`backend/src/cli/handlers/settings.js`
  - `cleanup status` 新增最近一次清理报告（触发源、耗时、失败数、目标进度）
  - `cleanup` 执行时新增“目标+进度”式状态输出，避免模糊文案
- `backend/tests/services/cleanupService.test.js`
  - 增加 `metrics` 与 `getLastCleanupReport()` 结构断言

## 下一步建议（按优先级）

1. 把 `atomicWriteText()`抽到 `backend/src/utils/` 作为通用能力，替换更多直接覆盖写路径。
2. 为 `cleanup status` 增加按目标排序/筛选（按耗时或失败优先）以便快速排障。
3. 将 `cleanup` 可观测指标接入统一遥测上报（仅本地匿名统计），用于版本回归对比。
