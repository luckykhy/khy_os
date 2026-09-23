<!-- 文档分类: OPS-MAN-061 | 阶段: 运维 | 主题: 发布门禁(可阻断的全新环境发布彩排) -->
# [OPS-MAN-061] 发布门禁 · 可阻断的发布彩排

> **参考手册** · 新版上线前，把「安装—启动—诊断—升级—发布物一致性」这条链变成一条
> **可阻断的硬门禁**，而不是人工 checklist。任一 must 阶段失败即 `exit 1`，阻断发布。
>
> **一句话定位**：`npm run gate:release` 顺序跑完仓库既有的确定性硬检查，首个 must
> 失败即阻断，并对无法在本机确定性执行的环节（干净容器装 / 升级 / 前后端实连 / 回滚）
> **诚实标为 MANUAL**，绝不静默放行。

---

## 为什么是它

新版上线最大的风险通常不是「少一个功能」，而是**装不上、起不来、连不上、升级坏掉**。
Khy OS 是 Python launcher + Node backend + 多前端 + 打包 的组合系统，链路长，最容易在
集成边界翻车。这个门禁把发布质量、用户首印象、售后成本、舆情风险一次性收口。

它**不重新发明**任何检查——只是把仓库里已经存在、且已被验证的 `check:*` /
`test:maintainer:*` 命令**编排成一条可阻断、分层、可判定的链**。

---

## 用法

```bash
npm run gate:release            # tier=must:最小硬门槛(默认)
npm run gate:release:all        # must + recommended:完整彩排(含测试集 + pip 纯度审计)
node scripts/release/release-gate.js --json        # 机器可消费 JSON,退出码同上
node scripts/release/release-gate.js --keep-going  # 不在首个失败停,跑完全部再汇总(诊断用)
```

**退出码**：`0` = 自动化门禁 GO（确定性检查全过）；`1` = NO-GO（存在 must 阶段失败）。

---

## 阶段构成

### 确定性阶段（本机可执行，门禁自动跑）

| 阶段 | tier | 命令 |
| --- | --- | --- |
| 版本三源一致 | must | `npm run check:version-sync` |
| 打包 manifest 同步 | must | `npm run check:manifest-sync` |
| khyos 工具链无漂移 pin | must | `npm run check:khyos-pins` |
| Node / Python 语法 | must | `npm run check:node-syntax` / `check:python-syntax` |
| 仓库红线 | must | `npm run check:small-model:safety` |
| 维护映射表 + 安全门禁 | must | `npm run check:maintainer:safety` |
| AI Chat UI 控制请求 | must | `npm run check:ai-chat-ui-control-request` |
| khy doctor 只读体检 | must | `khy doctor --check`（**不自愈**，只诊断） |
| 维护者测试集 | reco | `npm run test:maintainer:all` |
| pip 发布物纯度审计 | reco | `npm run check:pip-packaging` |

> `doctor` 只用只读的 `--check`（等价 `khy preflight`）。会写盘 / 自愈的裸 `khy doctor`
> 属于下面的**环境门手动步骤**，不在自动链内。

### 环境门（MANUAL，本机无法确定性执行，须人工彩排）

门禁会把这些**打印为 MANUAL 并附确切命令**，计入最终人工 Go/No-Go，但**永不静默 PASS**：

1. **干净环境新装**：`pip install khy-os && khy --version && khy doctor`
   （npm 通道：`npm install -g @khy-os/khy-os && khy --version`）
2. **旧版升级冒烟**：在存有旧配置的机器上升级到本版，验证启动正常、旧会话/token/app
   数据不被无声破坏，迁移失败时能说清「已完成什么、剩什么」；至少覆盖「上一正式版 → 本版」。
3. **前端连通后端**：启动前后端，验证前端拿到真实端口并连上；端口占用时自动漂移，
   不出现 `EADDRINUSE` 直接启动失败（可参考 `npm run test:maintainer:runtime`）。
4. **回滚路径**：降级到上一版，验证配置保留、数据目录兼容、回滚后仍可再次升级。

---

## Go / No-Go 规则

**可以发布**（全部满足）：

1. `npm run gate:release:all` 自动化门禁 = GO（所有 must 确定性阶段通过）
2. 4 项环境门手动彩排全部完成且通过
3. 无已知 P0/P1：装不上、起不来、连不上、升级坏掉、错误误导

**不应发布**（出现任一即阻断）：

1. 任一 must 确定性阶段失败（版本不同步 / manifest 漂移 / 语法 / 红线 / 安全门禁 /
   doctor 有阻塞项）
2. pip 发布物纯度审计失败
3. 升级会破坏旧配置 / 旧会话 / 旧数据
4. 端口冲突会直接把服务打死
5. 需要靠开发机环境残留才能跑起来

---

## 设计边界（诚实声明）

门禁**只对本机可确定性执行的环节自动判定**。干净容器新装、真实旧版升级、前后端实连、
回滚——这些依赖真实环境，本机无法确定性复现，因此门禁**标为 MANUAL 而非静默通过**。
这样它既能在 CI 里阻断确定性缺陷，又不会谎称「已覆盖全部彩排」。全平台矩阵（macOS /
Linux / Windows × 新装 / 升级 / 缺依赖 / 弱网 / 端口冲突）的自动化是后续迭代项。

**相关文件**：`scripts/release/release-gate.js`（运行器）·
`scripts/release/lib/releaseGateStages.js`（阶段与判定纯叶子）·
`scripts/tests/release-gate.test.js`（契约测试）。
