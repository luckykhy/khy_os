# [DESIGN-QUAL-002] 官方一致性套件接入规范

> **状态**：生效中
> **作者**：协议与工程规范整改（2026-09-15）
> **前置**：[DESIGN-QUAL-001] 门禁基线与债务台账规范、[DESIGN-NAM-002] A2A 与 ACP 命名及术语规范
> **配套守卫**：`scripts/ci/check-protocol-conformance.js`（自审一致性矩阵）、`scripts/ci/conformance-runner.mjs`（官方套件编排，降级安全）

---

## 1. 目标与边界

本规范回答两件事：**怎么接入官方一致性套件**，以及**必须产出什么**。

- **为什么要接**：`check-protocol-conformance.js` 是**自审**——它校验「khy 自己声明的协议面是否自洽」。它无法证明 khy 与
  *外部* 规范（MCP 规范、A2A 规范）一致。外部读者、跨厂商互操作、以及真正的安全/合规审计，都依赖官方套件出具的**独立证据**。
- **边界**：官方套件验证的是**协议层行为**（JSON-RPC 信封、生命周期、方法面、Agent Card 形状、状态机）。它**不**替代：
  功能语义测试、鉴权滥用面、租户隔离、压测、密钥扫描、破坏性操作控制。这些仍由各业务测试与 [DESIGN-QUAL-001] 门禁负责。

---

## 2. 上游工具（权威清单）

> 以下包名/命令来自上游官方仓库，接入前请再次向官方 README 核对 CLI flag（本文件锁定的是包与门禁语义，不是每个 flag 的永久形态）。

### 2.1 MCP

| 工具 | 包 | 用途 | 形态 |
|------|----|------|------|
| **Conformance** | `@modelcontextprotocol/conformance` | 官方一致性测试框架，覆盖 client/server 两模式 | `npx` 运行；结果落 `results/` |
| **Inspector (CLI)** | `@modelcontextprotocol/inspector` | 交互/脚本化调试；CLI 模式可做 `tools/list`、`tools/call` 冒烟 | `npx` 运行 |

- 服务器模式（khy 用这个）：`npx @modelcontextprotocol/conformance server --url <KHY_MCP_ENDPOINT> [--spec-version <VER>]`
- 列场景：`npx @modelcontextprotocol/conformance list`
- 结果：每次运行在 `results/server-<host>/checks.json` 写出**逐场景 pass/fail 数组**；每个场景外加两条合成检查：
  - `wire-schema-valid` —— 被测实现发出的任何 JSON-RPC 消息违反协商版本的 JSON Schema 即失败；
  - `wire-schema-harness-error` —— harness 自己发了非法消息（说明套件有 bug，不是实现问题）。
- 当前（2026 年中）官方发布协议版本为 **2025-11-25**；套件还包含 2026 draft（draft 场景非发布要求）。**khy 当前仅宣称 `2024-11-05`**（见 `check-protocol-conformance.js` 输出），首轮 conformance 必须以 khy 实际协商的版本运行。

### 2.2 A2A

| 工具 | 包 | 用途 | 形态 |
|------|----|------|------|
| **TCK** | `a2a-tck`（`@a2aproject`，PyPI + GitHub） | 官方 Technology Compatibility Kit，pytest | Python 3.11+，`uv` 安装；`reports/` 产物 |
| **Inspector** | `a2a-inspector`（`@a2aproject`） | 官方合规检查与调试工具 | Python |

- 运行：`./run_tck.py --sut-host <KHY_ACP_A2A_BASE_URL> [--level must|should|may] [--transport grpc,jsonrpc,http_json]`
- 运输由 Agent Card 的 `supportedInterfaces` 决定；TCK 先 `GET /.well-known/agent-card.json` 再为每声明接口建客户端。
- 报告：`reports/compatibility.json`（机器可读，逐需求/逐运输分解）、`reports/compatibility.html`、`reports/junitreport.xml`、`reports/tck_report.html`。
- RFC 2119 分级：`must`=硬失败；`should`=预期失败（xfail，不挡兼容）；`may`=可选（未声明能力则跳过）。

---

## 3. 接入前提（本地适配器）

官方套件**不**要求实现任何 server-adapter API——它只认**可达端点**。khy 侧需要的是把真实实现通过「它期望的传输」暴露出来：

### 3.1 MCP 前提

- 一个**已启动且健康**的 MCP 端点。优先用 `Streamable HTTP`（`/mcp`）或 `SSE`；纯 stdio 服务器需由 harness 以 `--command` 拉起（conformance client 模式）。
- 端点绑 `127.0.0.1`，校验 `Origin`，非本地端点必须鉴权（套件安全建议，不是断言）。
- 必填配套：独立 health 路由、确定性的 fixture 依赖、正确的进程终止转发。
- **khy 现状**：`mcpServerProtocol.js` 目前仅实现 `2024-11-05`，且以 stdio 为主。接入前需决定：① 以 stdio 由 harness 拉起，或 ② 先实现 Streamable HTTP 端点（推荐，便于 CI 与跨进程）。详见 §8。

### 3.2 A2A 前提

- `/.well-known/agent-card.json` 可被 GET（khy 已实现，见 `routes/wellKnown.js`）。
- Agent Card 的 `supportedInterfaces` 必须**只声明真实实现的能力**（诚实原则，见 [DESIGN-A2A-002] §capability-honesty）。
- 任务处理面：`message/send`、`tasks/get`、`tasks/cancel`、`tasks/resubscribe`（及可选 `message/stream`、`tasks/pushNotificationConfig/*`）需真实可调用。
- **khy 现状**：目前**只有 Agent Card 发布，没有任务处理面**（这是最大的一步缺口）。见 §8。

---

## 4. 接入方式（分步）

### 步骤 A — 钉版本（可复现底线）

```bash
# MCP：锁精确版本，本地与 CI 解析同一包
npm install --save-dev --save-exact @modelcontextprotocol/conformance@0.1.16
npm exec -- conformance --version
npm exec -- conformance list --server --spec-version 2024-11-05   # khy 当前宣称版本

# A2A：用 uv 管理 Python 环境
git clone https://github.com/a2aproject/a2a-tck.git .ci/a2a-tck
cd .ci/a2a-tck && uv venv && uv pip install -e . && cd -
```

> 接入前记录：套件包版本 + lockfile digest、khy 协商的协议版本、MCP/SDK 与 khy commit、端点传输与鉴权方式、fixture 数据集修订、运行机 OS/Node 版本、suite/scenario 选择器。
> **场景成员会随套件版本变化，命令输出比本文的计数更权威。**

### 步骤 B — 启动 khy 端（harness 职责）

MCP：启动生产 server 入口，暴露 health 路由，等待就绪。
A2A：启动 agent，确认 `/.well-known/agent-card.json` 200 且 `supportedInterfaces` 与实现一致。

### 步骤 C — 运行并产出报告

```bash
# MCP（以 khy 实际协商版本为准）
npx @modelcontextprotocol/conformance server \
  --url http://127.0.0.1:<PORT>/mcp \
  --spec-version 2024-11-05 \
  --expected-failures .ci/mcp-expected-failures.yaml

# A2A（先跑 MUST 级建立基线）
./.ci/a2a-tck/run_tck.py --sut-host http://127.0.0.1:<PORT> --level must
```

### 步骤 D — 登记已知失败基线（只缩不扩）

- MCP：`--expected-failures` 指向一份 YAML，列出**当前确实不支持**的场景（如尚未实现的 2025-06-18 sampling/elicitation）。门禁规则：**基线只缩不扩**——新增一条 known-failure 必须带 owner/dueBy/plan，登记进 `scripts/ci/debt-ledger.json`。
- A2A：首轮 `must` 级运行会暴露尚未实现的任务方法。把它们的失败固化进 TCK 的 expected-failures（或债务台账），并设定归零期限。

---

## 5. 所需产出（门禁验收物）

| 协议 | 产物 | 格式 | 保管 | 门禁判定 |
|------|------|------|------|----------|
| MCP | `results/server-<host>/checks.json` | JSON（逐场景 pass/fail + `wire-schema-valid`） | CI artifact，保留 ≥ 14 天 | 任一 `fail` 且不在 `--expected-failures` → 门禁红 |
| MCP | Inspector CLI 冒烟记录 | stdout（`tools/list`、`tools/call` 真实调用） | CI log | 调用返回非结构化/`[object Object]` → 红（回归 guard 已防） |
| A2A | `reports/compatibility.json` | JSON（逐需求/运输） | CI artifact | `must` 级任一 FAIL 且未登记 → 红 |
| A2A | `reports/compatibility.html` | HTML | 人工复核 | 人工看板 |
| A2A | `reports/junitreport.xml` | JUnit XML | 接入现有 JUnit 汇总 | 标准 xunit 门禁 |
| 两者 | 版本/环境快照 | YAML/JSON | `scripts/ci/conformance-meta.json` | 版本漂移告警 |

**判定口径**：不要说「全部 MCP 行为通过」——若只跑了 `active`、单场景、单传输，结论只能覆盖那部分。报告里必须标注实际运行的 suite/scenario/transport/level 选择器。

---

## 6. 版本钉扎与可复现

- MCP 套件用 `npm install --save-exact`，A2A 用 `uv` + 锁定 commit；升级套件是**受审变更**，不是 `latest` 自动副作用。
- `--spec-version` 显式传入；khy 升级协议版本时，门禁版本**同步升级**（见 §8 路线）。
- `scripts/ci/conformance-meta.json` 记录每次运行的：套件版本、协议版本、khy commit、端点传输、fixture 修订、OS/Node。

---

## 7. CI 接线

- **不**把官方套件塞进每次 PR 的 `check:all-standards`（会引入网络依赖、拖慢 PR、且目前必红）。
- 新增独立 release 门禁 `conform:all`（`npm run conform:mcp && npm run conform:a2a`），由 `scripts/ci/conformance-runner.mjs` 编排；**仅在 release 流水线 / 手动 `workflow_dispatch` 触发**，产物作为 artifact 留存。
- 本地 `npm run conform:all` 在套件未安装时**降级为 SKIPPED**（写 `conformance-report.json` 标注 `available:false`），不阻塞开发机；CI 中通过 `required:true` 标志强制必须产出真实报告。

```yaml
# .github/workflows/conformance.yml（手动触发，产物留存）
on: workflow_dispatch
jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run conform:all -- --required
      - uses: actions/upload-artifact@v4
        with: { name: conformance-report, path: .khy/conformance-report.json }
```

---

## 8. khy 现状与缺口（诚实登记）

| 协议 | 现状 | 接入官方套件的首轮结果 | 归零路线 |
|------|------|------------------------|----------|
| MCP | 仅实现 `2024-11-05`；stdio 为主 | conformance 以 `2024-11-05` 运行可基线化；2025-03-26 起的 SSE 流式 / `Last-Event-ID` / sampling / elicitation 全部为 known-failure | S2：实现 Streamable HTTP 端点 → 升 `2025-11-25` → 将 known-failure 逐条移出门禁 |
| A2A | 仅 Agent Card 发布；**无任务处理面** | TCK `must` 级会失败 `message/send`/`tasks/*` 等 | S3：实现标准任务方法面（服务端）→ 暴露 `supportedInterfaces` → TCK 逐运输通过 |

> 这两步是「能被发现 → 能被调用」的质变，也是 `check-protocol-conformance.js` 已声明但实现缺失的部分。详见 `_产物/khy-os-协议与工程规范分步改进计划-2026-09-15.md` 的 S2~S5。

---

## 9. 分工：自审守卫 vs 官方套件

| 守卫 | 验证什么 | 能证明什么 | 不能证明什么 |
|------|----------|------------|--------------|
| `check-protocol-conformance.js` | khy 自声明协议面的内部自洽（一致性矩阵 + 反面断言） | 「我们说的和我们做的自洽」 | 「我们与外部规范一致」（需官方套件） |
| `check-protocol-naming.js` | A2A/ACP 命名纪律 | 「没把私有方言叫成标准 A2A」 | 协议行为正确性 |
| `check-debt-ledger.js` | 门禁债务责任归属 | 「每个指标有人管、只降不升」 | 协议行为正确性 |
| **官方套件（本规范）** | 与外部规范的独立一致性 | 「外部可验证的一致证据」 | 业务语义/安全滥用/压测 |

四者互补：**自审守卫保证日常不退化，官方套件提供对外可信证据。**
