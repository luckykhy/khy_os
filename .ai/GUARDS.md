<!-- khy-metadata:auto khy-metadata/4 fingerprint=6b2e4f9fa380e6db -->
<!-- 机器生成，可被 `khy metadata refresh` 覆盖。删除此标记行即人工接管。项目特有红线请写在「项目特有红线」小节，刷新不会动那一节以外的人工补写——但为安全起见，接管整文件时请删除本标记。 -->
# GUARDS — khy-os 红线与维护指南 (khy 自动生成种子文档)

> 本文保证：**即便没有 AI**，维护者也能据此安全改动本项目。
> 自动探测部分是事实；`TODO(人工)` 部分需第一位维护者补全项目特有红线。

## 探测到的事实（改动前先看）
- **入口点**: `platform/packages/shared/src/index.js`, `platform/packages/ui-shared/src/index.js`, `services/backend/server.js`, `services/backend/bin/khy.js`, `services/backend/bin/khy.js`, `services/backend/bin/khy.js` — 改这些文件影响启动行为。
- **配置/敏感文件**: `fly.staging.toml`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `pyproject.toml`, `packaging/.env`, `services/.env`, `services/.env.bak-cleanup`, `apps/ai-frontend/.env.example` — 含运行参数/密钥，勿提交真实密钥到版本库。
- **技术栈**: node, monorepo, python, docker — 工具链需与之匹配。

## 如何在没有 AI 的情况下维护本项目
1. 读本目录三件套：`MAP.md`（去哪找代码）→ `CONTEXT.yaml`（谁调用谁/有哪些符号）→ 本文（哪些不能碰）。
2. 复现构建：`npm install` → `pip install -e .`。
3. 改动后跑测试验证：`npm test --workspaces --if-present` ; `pytest`。
4. 小步改动、改完即验证、保持 `.ai/` 三件套与代码同步更新。

## 通用红线（适用于多数项目）
- 不提交密钥/令牌到版本库（用 env 或密钥管理；检查 `config_files` 列出的文件）。
- 不在未跑测试的情况下改动入口点或公共接口。
- 不引入与既有技术栈冲突的工具链/包管理器。
- 不删除看不懂用途的文件——先在 `CONTEXT.yaml`/`MAP.md` 查它被谁引用。
- 不制造“上帝文件”：单个源文件只承担一个内聚职责，超出体量上限或开始混入无关职责时按职责拆分，而不是继续堆积。
- 不重复造同功能版块：新增模块/文件前先在本目录与 `MAP.md` 查是否已有同职能实现，有则扩展复用；同一能力只应存在一处，杜绝并行近似副本。

## 项目特有红线（待维护者补全）
- TODO(人工): 列出"改了会运行期炸/数据损坏"的具体约束（如某字段格式、某调用顺序、某硬编码常量及其位置）。
- TODO(人工): 列出对外契约（API/协议/文件格式）中不可破坏向后兼容的部分。

