# prompts/ — 自包含提示词库

每条提示词自带：角色定义、执行流程、khy-os 工程红线、验收标准、验证命令。
**拿到即可独立完成任务，无需补充上下文。**

## 两种使用位置

| 模式 | 操作 | KHYOS_PATH 填法 |
|------|------|----------------|
| A | 在 khy-os 根目录里打开 AI，粘贴提示词 | 「当前目录」 |
| B | 在本项目目录打开 AI，远程指挥 | khy-os 绝对路径 |

## 推荐工作流（让 `khy hq` 替你填占位符）

在 khy-os 仓库根目录执行（模板已随 HQ 能力吸收并入本仓库的 `.ai/hq/prompts/`）：

```bat
:: 登记一个 Bug：

khy hq bug new "状态栏卡在99%" --severity P1 --domain cli ^
       --symptom "..." --repro "..." --suspect "..."

khy hq next                    REM 自动选下一步并渲染提示词
khy hq next --bug BUG-001      REM 指定 Bug
khy hq next --verify BUG-001   REM 修复后回归验证
khy hq next --task T-002       REM 指定路线图任务
khy hq next --copy             REM 结果直接进剪贴板
khy hq status                  REM 只看总览

khy hq bug set BUG-001 in_progress --note "已定位"
khy hq bug set BUG-001 pending_verify --root-cause "..." --fix "..."
khy hq task set T-002 doing

khy hq next --kind distill     REM 模型强项工具化提示词
khy hq next --kind onboard     REM 新机器接入流水线（发给那台机器的 AI）
khy hq next --kind gov         REM 板块规则治理（发给 khy-os 的 AI）
khy hq verify                  REM 改完必跑：数据一致性 + 模板结构体检
```

`--json` 输出机读结果（供 AI/工具程序化消费）；`--out FILE` 写入文件。
渲染时自动判断 KHYOS_PATH 填「当前目录」还是绝对路径（单仓下通常就是当前目录）。

## 模板索引

| 场景 | 文件 | 触发方式 |
|------|------|---------|
| Bug 修复（主） | `bugfix/01-修复指定Bug.md` | open 状态 Bug 自动选中 |
| 回归验证 | `bugfix/02-回归验证.md` | `--verify BUG-XXX` |
| 新功能开发 | `feature/01-新功能开发.md` | type=feature 任务 |
| 手机端APK开发 | `feature/02-手机端APK开发.md` | 手机端APK相关任务 |
| 手机端APK参考项目 | `feature/手机端APK参考项目.md` | 手机端APK参考项目 |
| CRDT 实时协作 | `feature/CRDT-实时协作编辑引擎.md` | 多人同时编辑需求 |
| 模块重构 | `refactor/01-模块重构.md` | type=refactor 任务 |
| 性能优化 | `performance/01-性能优化.md` | type=performance 任务 |
| 测试补齐 | `quality/01-测试补齐.md` | type=quality 任务 |
| 代码审查 | `quality/02-代码审查.md` | 合并前手动使用 |
| 文档完善 | `docs/01-文档完善.md` | type=docs 任务 |
| 能力沉淀 | `meta/01-能力沉淀.md` | `khy hq next --kind distill`（把模型强项工具化） |
| 新机器接入 | `meta/02-新机器接入.md` | `khy hq next --kind onboard`（让新机的 AI 自主部署 khy-os + 计划任务） |
| 同步就绪验证 | `meta/03-同步就绪验证.md` | `khy hq next --kind verify-sync`（验证单仓同步就绪状态） |
| 协作开发端 | `meta/04-协作开发端.md` | `khy hq next --kind worker`（协作开发端提示词） |
| 板块规则治理 | `governance/01-板块规则与协议总纲.md` | `khy hq next --kind gov`（收拢板块/记忆/工具/通信/API 五大规则并工具化） |

## 手工使用

模板文件头部注释说明占位符；正文都在 ```text 围栏内，
手工替换 `{{XX}}` 后整段复制给 AI 即可。

## 维护约定

1. 修改红线措辞时，同步更新 `.ai/hq/CONTEXT.md` 第四节与 khy-os 的 `AGENTS.md`
2. 新增模板后在本表登记，并在 `services/backend/src/cli/hqStore.js` 的 `TYPE_TO_TEMPLATE` 注册
3. 提示词语言：中文指令 + 英文代码术语；面向 AI 的命令一律可复制执行
4. 模板受 `khy hq verify` 的模板结构检查保护：必须有 ```text 围栏、【角色】、【验证命令】，
   且正文占位符必须在头部注释声明——跑一下 `khy hq verify` 就知道哪个模板改坏了

---

*最后更新：2026-09-17*
