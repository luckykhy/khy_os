# [DESIGN-TOOL-001] 工具与扩展升级废弃规范

<!-- RULES-REGISTRY: TOOLING-002, TOOLING-003 -->


> **定位**：`[DESIGN-GOV-001]` GOV-TOOL-003 的契约冻结真源。
> 上位法 `[DESIGN-TOOL-002]` 管「发现→惰性激活→停用」与 manifest 基础形状；本文只补 069 未覆盖的**升级/废弃生命周期**。
> 字段清单以 069 与归一器 `services/backend/src/services/domain/extensions/extensions/extensionRoots.js` 为准。

## 1. manifest 生命周期字段（冻结）

`khy.extension.json` 新增可选块 `lifecycle`：**active 扩展可省略**（缺省 = active，不回填存量）；进入废弃流程的扩展**必须**带完整块：

```json
"lifecycle": {
  "status": "active | deprecated | sunset",
  "deprecatedSince": "1.2.0",
  "sunsetVersion": "2.0.0",
  "replacement": "khy-newtool | null",
  "migration": "一句话迁移说明 + 文档链接；无迁移写 null"
}
```

| 字段 | 必填条件 | 语义 |
|---|---|---|
| `status` | 进入废弃流程 | `deprecated`：仍可加载，启动时报一行弃用提示；`sunset`：加载器拒绝激活 |
| `deprecatedSince` | 同上 | 废弃自哪个 khy-os 版本 |
| `sunsetVersion` | 同上 | 预计移除版本（必须先于移除**登记**） |
| `replacement` | 有替代时 | 替代扩展 `id`；无则 `null` |
| `migration` | `status=deprecated` | 迁移说明（见上） |

**红线**：移除公开扩展目录且无 `migration` 说明、无台账登记的，违反 GOV-TOOL-003。

## 2. 工具名（模型可见 API）改名/移除

`tools[].name` 与 `aliases` 是对模型的**契约**，改名/移除 = 破坏性变更：

1. 先在新版本注册替代工具（新名 + 旧名进 `aliases`），旧名标 `deprecated: true`（工具条目内新增可选字段：`deprecated` / `replacement`，形状同 §1 块）；
2. **兼容期**至少到一个 khy-os 大版本（x.0.0），期内旧名可用但每次调用报一行弃用提示；
3. 移除前在 `CHANGELOG.md` 与 `docs/04_IMPL_实现/` 各登记一行（替代名 + 移除版本）；
4. **豁免**：核内策略表按原名点名的内置工具（如 `NotebookEdit`，见 `extensions/tools/khy-notebook/khy.extension.json` 的 `_note`）不做原地改名——改名等于换工具，只走「新增新工具 → 本流程弃用旧工具」。

## 3. 版本策略

`version` 走 semver，变更分级：

| 变更 | 版本 |
|---|---|
| 新增工具 / 新增 alias / 收紧 `permissions`（能力面只减不增） | patch |
| 新增能力（新 `capabilities`、新权限位、manifest 新字段） | minor |
| 工具改名/移除、`inputSchema` 收紧必填、`engines.khy` 下界上移 | major，且必须走 §1–§2 兼容期 |

`engines.khy` 为**冻结必填**（存量已全声明）：下界不得高于当前发布版，升级下界属 major。

## 4. 最小权限边界（冻结）

**现状口径**：归一器把缺省 `permissions` 归一为 `{}`（全能力位关闭）；归一后字段清单：
`name/displayName/version/description/engines/main/entry/capabilities/provides/tools/commands/skills/mcp/permissions`
（`lifecycle` 块为本文新增冻结项，见 §1）。

```json
"permissions": { "network": false, "spawn": false, "database": false }
```

- 交付网络外发 / 子进程 / 数据库写能力的扩展**必须**显式 `true` 并在 `description` 说明用途（用户可见）；
- `{}`（缺省）一律按**最小权限**解释：消费侧只认显式 `true`，缺省字段不得被解释为放开；
- 新增第四类能力位（如 `filesystem_write`）前，先在本表登记再实现。

## 5. 守卫现状与计划

- **已机械化**：manifest 存在性与分类名白名单 → `check:layout` 的 `extension-contract`；工具注册契约 → `node scripts/ci/check-tool-contract.js`（GOV-TOOL-002）。
- **待工具化**（登记在 070 §3，落地前先读本文）：① `lifecycle` 形状 + 「deprecated 必带 migration」校验；② `sunsetVersion` 已到达但目录仍在 `extensions/` 的残留检查；③ manifest 声明 `false` 而代码实际发起网络/spawn 的越权检测（可复用 `check:agent-rules` 端点扫描）。
