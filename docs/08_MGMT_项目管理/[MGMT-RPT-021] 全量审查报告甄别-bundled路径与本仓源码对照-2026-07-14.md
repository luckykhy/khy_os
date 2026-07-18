# [MGMT-RPT-021] 全量审查报告甄别 · bundled 路径与本仓源码对照

> **日期**：2026-07-14
> **性质**：甄别报告（triage）· 不含任何代码改动
> **触发**：一份「Khy-OS 全量审查报告」列出 8 个 Critical + 若干 Warning，要求「修复这些错误」。
> **关键前提问题**：该报告所有文件路径均指向
> `D:/Python312/Lib/site-packages/khy_os/bundled/…`
> ——即一台 **Windows 机器上已 `pip install` 的副本**，而**不是本仓源码树** `/home/kodehu03/Khy-OS`。
> 因此报告中的行号会漂移，且部分发现在本仓源码里**根本不存在**。
> 本报告逐条打开**本仓源码**复核，给出「真 / 误报 / 本仓不存在」三态甄别，供决定修复范围。

---

## 一、方法

- 对每一条 Critical / Warning，在本仓 `/home/kodehu03/Khy-OS` 源码树中 `find` + `grep` + 直接读源码复核。
- 区分「源码文件」与「构建产物副本」：多数被点名文件在本仓有 **4 份拷贝**——
  1 份源码（如 `services/backend/…`、`software/khyquant/…`）+ 3 份 bundled 产物
  （`packaging/npm/bundled/`、`platform/khy_os/bundled/`、`build/lib/khy_os/bundled/`）。
  **任何真修复只应改源码那一份**；bundled 是打包时生成的，改它无意义且会被覆盖。
- **本轮不改任何代码**（按用户指示「先出甄别报告再定」）。

---

## 二、Critical 逐条甄别

| 编号 | 报告说法 | 本仓源码复核结论 | 位置（本仓源码） |
|------|----------|------------------|------------------|
| **C1** | 硬编码数据库密码 `postgres` | ✅ **真** | `software/khyquant/ml/data_collector.py:29-30`（`_get_default_db_config` 返回 `"password":"postgres"`） |
| **C2** | 硬编码生产 IP `47.85.29.215` + ssh/scp | ✅ **真（但为 `print()` 部署提示串，非可执行命令）** | `software/khyquant/ml/train_18_features.py:236,238` |
| **C3** | 硬编码后端端点 `setup_khy_provider.py` | ❌ **本仓不存在**：`scripts/qoder-bridge/` 仅含 `.ps1` + `logs/`，全仓 `find` 无 `setup_khy_provider.py`。该文件只存在于 bundled 副本 | —（不可在本仓落地） |
| **C4** | ML 未来信息泄漏（`shift(-5)` 标签混入特征） | ❌ **误报**：`shift(-5)/shift(-10)` 确实产出 `label_5d/label_10d/return_5d`，但 `feature_engineer.py:538-548` `select_features` 的 `exclude_cols` **显式排除** `label_5d,label_10d,return_5d,return_10d,return_20d` 及所有 soft-label 列。标签不进 X，无泄漏 | `feature_engineer.py:535-555`（已正确防护） |
| **C5** | 特征列表不一致（18 vs 49） | ⚠️ **夸大**：`check_model_features.py` 是一个**诊断工具**（探针 `[18,49]` 看模型期望几列，提示旧 49 列模型需重训），其存在≠线上正在错位。无证据表明当前推理静默错位 | `software/khyquant/ml/check_model_features.py`（诊断脚本） |
| **C6** | 全局模型缓存无线程安全 / 无 TTL / 吞异常 | ⚠️ **部分成立（降级为设计注记）**：`predict.py:67-68` 的 `_MODEL_CACHE/_FEATURE_COLUMNS_CACHE` 确无锁、无 TTL。但本子系统是**单进程 CLI 推理**，线程竞态可能性低；报告所指「L894 吞异常」在 980 行的文件里未定位到，疑似子代理误标行号 | `predict.py:67-68,118-140` |
| **C7** | AI 网关 `Promise.race` 未捕获异常 | ❌ **本仓源码里没有**：`grep "Promise.race" services/backend/src/services/gateway/aiGateway.js` 无命中。或为 bundled/子代理误判 | —（本仓源码不存在该模式） |
| **C8** | API Key 日志泄漏 | ❌ **已被防护（疑误报）**：backend `aiGateway.js` 已有 `_sanitizeFailureMessage()`（L228 定义）并在 11+ 处错误/预览日志上使用；未发现把含 key 的 config 原样 `logger.error` 的调用点 | `aiGateway.js:228`（脱敏函数已存在并广泛使用） |

**Critical 净结论**：8 条里，**真问题 2 条（C1、C2）**；**误报/已防护 3 条（C4、C7、C8）**；**本仓不存在 1 条（C3）**；**夸大/降级为设计注记 2 条（C5、C6）**。

---

## 三、Warning 逐条甄别（本仓源码存在性确认）

| 项 | 结论 | 位置（本仓源码） |
|----|------|------------------|
| 数据源 `sys.path` 硬编码 `../../../数据源/adata-main` | ✅ **真** | `software/khyquant/services/adataService.py:29-30` |
| `inference_server.py` `signal.alarm` 多线程不可靠 + 绑定 `127.0.0.1` 硬编码 | ✅ **真** | `services/backend/inference_server.py:138,184` |
| `docHelper.py` tesseract 子进程调用路径未校验 | ⚠️ **存在子进程调用**（`subprocess`/`pytesseract`），路径穿越风险需看实际 OCR 调用点参数来源才能定性 | `services/backend/src/services/docHelper.py` |
| aiChatCore 活动性超时、appHostHelpers 模糊状态、TLS sidecar/webRelay 127.0.0.1、Redis 竞态、Relay XSS | 未在本轮逐一复核（属报告 Warning 区，非「必修」）；若纳入范围再单独核 | 待定 |

---

## 四、约束：本仓当前处于提交冻结期

- `git status` 显示 **45 个 tracked-M** 文件（并行 session 的进行中工作）。
- 项目红线（CLAUDE.md）：**禁止 AI 自动 commit/push**；真 key/token 不进包不落盘。
- 含义：本轮**只产出本报告**（未跟踪的新叶文件），**不改任何 tracked 源码、不 commit**。
  任何真修复（C1/C2 等）应在解冻后、经用户明确点头，单独走「改源码那一份 → 三守卫 → py 语法门」流程。

---

## 五、建议的修复优先级（供决定，未执行）

1. **C1（硬编码 postgres 密码）** — 改 `_get_default_db_config` 走 `os.environ.get("PG_PASSWORD")`，无值时拒绝真实 DB 连接（注意：本文件当前主路径是**合成数据**，DB 配置是占位；仍应清掉明文默认口令）。
2. **C2（生产 IP）** — 把 `print()` 里的 `root@47.85.29.215` 改为从 env（如 `KHY_DEPLOY_HOST`）读，避免把生产拓扑写死进随包分发的源码。
3. **adataService `sys.path` 硬编码 / inference_server 绑定地址** — 走 env 覆盖（Warning 级，非必修）。
4. **C3/C4/C7/C8** — **不动**：C3 本仓无此文件；C4/C8 已防护；C7 本仓源码无此模式。若要处理，应在 bundled 的**上游源**（若有独立仓）修，而非本仓。

> 甄别一句话：**「修复这些错误」不能按报告字面全照做**——8 个 Critical 里只有 2 个在本仓是真缺陷，其余是误报、已防护、或指向本仓根本不存在的 bundled 文件。盲目照修会为不存在的文件动手、并可能把已正确的防护改坏。

---

**说明**：本报告为纯甄别产出，未改任何 live 配置 / 源码，未 commit，未 push。修复范围待用户在本报告基础上圈定。
