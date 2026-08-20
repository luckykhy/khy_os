<!-- 文档分类: OPS-MAN-174 | 阶段: 运维 | 原路径: 新建 -->
# [OPS-MAN-174] 任务入口总表

> **运维手册 · 根 `package.json` 任务 surface 的逐条说明** · 回答四个问题：这条入口**干什么**、跑的是**哪个脚本**、它**守住什么**、**什么时候**该跑。
>
> **定位**：命名规约（`<域>:<动作>[:<变体>]`）的真源是 `[DESIGN-ARCH-068] 仓库层级板块规范` 第五节；**可执行清单**的真源是仓库**根** `package.json` 的 `scripts` 块。本文是它的人类可读解释层，两者冲突时以 `package.json` 为准。
>
> **两条硬规则**（真源 DESIGN-ARCH-068 §5.1）：① 每个入口必须指向一个**已存在**的脚本文件；② **不为单个测试文件建入口**——跑某一个测试用 `npm run test:one -- <path>`。
>
> **守卫**：`npm run check:layout` 的 `dangling-task` 规则扫描全仓被引用的 `npm run <目标>`，凡是解析不到脚本定义的即计为违规并进基线（只降不升）。

---

## 一、怎么用这张表

- 全部入口都在**仓库根**跑（`cd` 到 `C:\khy-os` 或仓库根）。
- 加参数用 `--` 透传：`npm run check:layout -- --list=dangling-task`。
- workspace 专属脚本（如 `arch:god`）不在根 surface 上，须带 `--workspace services/backend`。

---

## 二、`check:` —— CI 守卫（会亮红灯）

真源脚本目录 `scripts/ci/`。这一组是「做完的定义」：任一红即未完成。

| 入口 | 脚本 | 守住什么 | 何时跑 |
| --- | --- | --- | --- |
| `check:layout` | `check-repo-layout.js` | 层级登记 / 根目录白名单 / docs 索引 / 任务入口不断裂 | 新增文件、新增顶层目录、改 docs 结构后 |
| `check:version-sync` | `check-version-sync.js` | 红线 R3：pip / npm / backend 三处版本号一致 | 发布前、改任一 `version` 后 |
| `check:change-safety` | `check-change-safety.js --changed` | 改动面失控、误删、跨区域散射 | 每一步改动之后（三守卫之一） |
| `check:agent-rules` | `check-agent-rules.js --changed` | `AGENTS.md` 工程规则 1–4（零硬编码 / 状态透明 / 活动式超时 / 无滚动区 UI） | 同上（三守卫之二） |
| `check:leaf-contract` | `check-leaf-contract.js --changed` | 纯叶子契约（无副作用、可单测） | 改 `services/backend/src/services/**` 叶子后 |
| `check:node-syntax` | `check-node-syntax.js` | 全仓 JS 语法可解析 | 大批量改 JS 后 |
| `check:python-syntax` | `run-python.js check-python-syntax.py` | 全仓 Python 语法可解析 | 改 `platform/` / `software/khyquant/` 后 |
| `check:duplication` | `check-duplication.js` | 重复代码块不超基线 | 抽取/复制代码后 |
| `check:duplication:gate` | 同上 `--gate` | 同上，超基线即阻断 | CI |
| `check:duplication:strict` | 同上 `--gate --strict-warnings` | 同上，全部 warning 升 error | 收紧一轮时 |
| `check:duplication:baseline` | 同上 `--write-baseline` | 修完一批后**下调**基线 | 只在真降下来时 |
| `check:manifest-sync` | `release/check_manifest_sync.py` | pip 打包清单与实际文件一致 | 改 `MANIFEST.in` / 新增包内资源后 |
| `check:flag-registry` | `check-flag-registry.js` | 每个 `KHY_*` 开关都登记在 flagRegistry SSOT | 新增环境开关后 |
| `check:model-hardcoding` | `check-model-hardcoding.js` | 模型 id 不写死在业务代码里 | 接新模型 / 改网关后 |
| `check:pattern-coverage` | `check-pattern-coverage.js` | 注册表与磁盘一致：未标注 / 幽灵条目 / 非 GoF 模式名（三项走 `pattern-coverage-baseline.json` 棘轮） | 新增源文件、删文件、改 `docs/_设计模式/模式注册表.json` 后 |
| `check:tool-contract` | `check-tool-contract.js` | 工具调用契约（入参/出参 schema） | 新增/改工具后 |
| `check:skill-evals` | `check-skill-evals.js` | 每个技能有 eval | 新增技能后 |
| `check:skill-scenarios` | `check-skill-scenarios.js` | 技能场景覆盖 | 同上 |
| `check:lifecycle-policy` | `check-lifecycle-policy.js` | 生命周期策略声明齐全 | 改服务生命周期后 |
| `check:moonbit-layout` | `check-moonbit-layout.js` | MoonBit 侧目录布局 | 改 `kernel/` MoonBit 部分后 |
| `check:frontend-size` | `check-frontend-size.js` | 前端产物体积不超基线 | 改 `apps/ai-frontend/` 依赖后 |
| `check:json-schemas` | `validate-json-schemas.js` | 仓库内 JSON 合 schema | 改任一配置 JSON 后 |
| `check:protocol-contracts` | `validate-protocol-contracts.js` | 协议契约不破坏兼容 | 改网关协议后 |
| `check:reliability` | `validate-reliability.js` | 可靠性不变量 | 改重试/超时/降级逻辑后 |

**组合入口**（省打字，不是新规则）：

| 入口 | 展开 |
| --- | --- |
| `check:structure` | `check:layout` → `check:pattern-coverage` → `check:json-schemas` → `check:node-syntax` → `check:build-artifacts` → `check:runtime-placement` |
| `check:changed` | `check:change-safety` → `check:agent-rules` → `check:leaf-contract` |

---

## 三、`docs:` —— 文档站构建与体检

| 入口 | 脚本 | 守住什么 | 何时跑 |
| --- | --- | --- | --- |
| `docs:build` | `build_docs_site.js` | 每个 `.md` 生成同名 `.html` 孪生件 + 刷新 `docs/_assets/nav-data.js` | **新建/改名/删除任何文档后** |
| `docs:verify` | `verify_docs_site.js` | 硬门：缺 HTML、本地断链、离线资产缺失即非零退出 | 紧跟 `docs:build` |
| `docs:lint` | `lint_docs_widgets.js` | 互动件语法（callout / quiz / flip / popover / timeline / scene） | 用了互动件之后 |
| `docs:check-beginner` | `check_beginner_docs.js` | `02_CONCEPTS_*` / `09_STORY_*` 禁孤儿页、禁死链、禁死胡同页 | 改这两个目录后 |
| `docs:pdf` | `md-to-pdf.js` | —（产出物，非守卫） | 需要 PDF 交付时 |
| `docs:gen-evolution-prompts` | `gen-evolution-prompts.js` | 从维护映射表生成进化提示词 | 改 `docs/_维护者/维护映射表.json` 后 |

---

## 四、`test:` —— 测试

| 入口 | 展开 | 说明 |
| --- | --- | --- |
| `test:one` | `node --test` | **跑单个文件用它**：`npm run test:one -- scripts/tests/xxx.test.js` |
| `test:scripts` | `node --test "scripts/tests/**/*.test.js"` | 工程脚本测试 |
| `test:docs` | `node --test "scripts/docs/**/*.test.js"` | 文档站脚本测试 |
| `test:backend` | `npm run test:all --workspace services/backend` | 后端全量 |
| `test:frontend` | `npm test --prefix apps/ai-frontend` | 前端 |
| `test:all` | `test:scripts` → `test:docs` → `test:backend` | 提交前 |

> **刻意不提供** ~95 个 `test:<单场景>` 目标（`test:ocr-*`、`test:vision-*`、`test:restore-*`、`test:maintainer-*` 等）。它们只是「跑某一个测试文件」，全部由 `test:one` 覆盖。文档里对它们的残留引用由 `dangling-task` 基线跟踪，逐步清理，**不通过伪造入口来消灭告警**。

> **通配符必须加引号**：Node 22+ 把 `--test` 的位置参数当 **glob 模式**而非目录。写裸目录（`node --test scripts/tests/`）会被当成 entry point，报 `Cannot find module`；不加引号则由 shell 先展开，Windows 上行为不一致。故上表两条写作 `node --test "…/**/*.test.js"`。

---

## 五、`maintainer:` / `maintenance:` —— 维护映射与生成物

真源数据 `docs/_维护者/维护映射表.json`。

| 入口 | 脚本 | 守住什么 | 何时跑 |
| --- | --- | --- | --- |
| `maintainer:map` | `ci/print-maintainer-map.js` | 打印「改了这里该找谁 / 跑什么验证」 | 接手陌生模块前 |
| `maintainer:triage` | `diagnostics/triage.js` | 症状 → 责任区域分诊 | 出故障不知从哪查时 |
| `maintenance:codeowners` | `maintenance/gen-codeowners.js` | 从映射表 + `.github/maintainers.json` 重生成 `.github/CODEOWNERS` | 改映射表或名册后 |
| `maintenance:triage-doc` | `diagnostics/triage.js --gen-doc` | 从映射表确定性重生成 `[OPS-MAN-067] 症状分诊速查表` | 改映射表后（`maintainerTriage.test.js` 会断言落盘件与生成器逐字节一致） |
| `maintenance:pattern-registry` | `ci/generate-pattern-registry.js` | 重生成设计模式注册表 | 新增模式标注后 |
| `maintenance:dimension-health` | `ci/export-dimension-health.js` | 导出 `docs/_报告/维度健康.json` | 定期体检 |
| `maintenance:quality-dashboard` | `ci/export-quality-dashboard.js` | 导出 `docs/_报告/质量看板.json` | 定期体检 |

---

## 六、`gate:` —— 发布门

| 入口 | 脚本 | 守住什么 | 何时跑 |
| --- | --- | --- | --- |
| `gate:release` | `release/release-gate.js` | 发布前必过项（版本同步、纯净度、测试集） | 发包前 |
| `gate:release:all` | 同上 `--tier=all` | 全档位，最严 | 大版本发布前 |
| `gate:release:json` | 同上 `--json` | 机器可读结果 | CI 消费 |
| `gate:runtime-placement` | `release/verify-runtime-placement.js` | 运行时文件落位正确 | 改打包布局后 |
| `gate:changelog-new` | `release/changelog-new.js` | 起一条新的 CHANGELOG 条目 | 发版起草时 |

---

## 七、`restore:` —— 源码恢复流程（18 阶段 1:1 映射）

`restore:plan` `restore:check` `restore:check:archive` `restore:check:crypto` `restore:check:format`
`restore:authorize` `restore:conflicts` `restore:resolve` `restore:apply` `restore:converge`
`restore:verify-complete` `restore:recourse` `restore:navigate` `restore:ledger`
`restore:provenance` `restore:trace` `restore:effect-probe` `restore:field-attribution`

每条 1:1 指向 `scripts/restore/restore-<名>.js`。整套流程的语义、顺序与授权要求见 `_source/` 下的恢复说明与 `docs/07_OPS_运维/` 的恢复类手册——本表只登记入口，不复制流程。

---

## 八、`portable:` / `hooks:` / `verify:` / `bench:` / `doctor:`

| 域 | 入口 | 用途 |
| --- | --- | --- |
| `portable:` | `build:dev` `build:runtime` `plan:dev` `plan:runtime` `package` `package:runtime` `package:dev` `verify` `repair` | 便携版构建、打包、体检、修复（`extensions/scripts/khy-portable/*`） |
| `hooks:` | `hooks:install` | 安装 git 钩子（`extensions/scripts/khy-installer/install-git-hooks.js`） |
| `verify:` | `verify:install` | 安装完整性自检 |
| `bench:` | `startup` `startup-probe` `ab-compare` `git-spawn` | 性能基准（`extensions/scripts/khy-diagnostics/bench/*`） |
| `doctor:` | `hydration` `model-types` | 诊断（`extensions/scripts/khy-diagnostics/*`） |

---

## 九、旧名 → 新名（文档里的历史引用照这张表改）

引入本规约前，文档与 CI 里散落着一批**从未存在过**或**已改名**的目标。下表给出对应关系；改文档时按这张表替换，`dangling-task` 计数即随之下降。

| 文档里的旧写法 | 现在应写 | 备注 |
| --- | --- | --- |
| `restore-plan` / `restore-check` / `restore-authorize` / `restore-conflicts` / `restore-converge` / `restore-recourse` / `restore-resolve` | `npm run restore:plan` … | 连字符 → 冒号，域分隔符统一 |
| `triage` | `npm run maintainer:triage` | 归入 maintainer 域 |
| `gen-triage-doc` | `npm run maintenance:triage-doc` | 生成动作归入 maintenance 域；脚本一直存在（`diagnostics/triage.js --gen-doc`），此前只是没有入口 |
| `verify-install` | `npm run verify:install` | 同上 |
| `hydration-doctor` | `npm run doctor:hydration` | 归入 doctor 域 |
| `maintainer:check` | `npm run maintainer:map` + `node --test scripts/tests/maintainerMapDocCoverage.test.js` | 原目标从未定义；等价能力拆成两条 |
| `bench` | 选具体一条 `bench:*` | 无「全部基准」聚合入口 |
| `test:<单场景>` | `npm run test:one -- <path>` | 见第四节 |

**至今仍无对应脚本**（引用存在、实现不存在，**不伪造入口**，只登记）：
`check:khyos-pins`、`check:pip-packaging`、`check:small-model:safety`、
`check:maintainer:safety`、`check:maintainer:bootstrap`、`check:ai-chat-ui-control-request`、
`maintenance:generate`、`docs:pdf:onboarding`、`dev:frontend`、`dev:install`、`deploy`。
`arch:god` 存在但只定义在 `services/backend/package.json`，须带 `--workspace services/backend`。

---

## 关联文档

- `[DESIGN-ARCH-068] 仓库层级板块规范`——命名规约与两条硬规则的真源（第五节）。
- `[OPS-MAN-169] 项目规则总纲-命名·skill·权限·mcp`——验收门禁「做完的定义」。
- `[OPS-MAN-042] 发布手册-pip与npm-无AI照做` / `[OPS-MAN-061] 发布门禁`——`gate:` 域的展开。
- `docs/_维护者/维护映射表.json`——每个区域的 `verify` 字段即「改了这里该跑哪几条入口」。
