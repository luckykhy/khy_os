# [OPS-MAN-153] 会话快照损坏兜底修复接线

## 背景（能力存在但没接线）

`services/backend/src/services/sessionFileRepair.js` 是一枚**全实现且有单测**的叶子
（`repairSessionFile` / `tryParsePartialJson` / `extractValidMessages` / `validateSession`
/ `validateSessionFile`），但此前**唯一的消费者是它自己的单测**——生产代码里没有任何
路径调用它。这正是送别礼要清理的「能力存在，但没接线」孤儿叶。

同时，`sessionPersistence.restoreSession` 的「退回 JSON 快照」兜底路径此前是：

```js
try {
  const raw = fs.readFileSync(_filePath(sessionId), 'utf-8');
  return { ...JSON.parse(raw), _source: 'json' };
} catch {
  const checkpoint = loadCheckpoint(sessionId);
  if (checkpoint) return { ...checkpoint, _source: 'checkpoint' };
  return null;
}
```

即：JSON 快照一旦损坏/截断（写盘中途断电、磁盘满写坏、传输截断），`JSON.parse` 抛错
→ **整段会话直接丢给 checkpoint 或 null**。这与送别礼诉求「换电脑/换系统后**完整的
简单的还原**」直接冲突——本可 salvage 的会话被整段丢弃。

## 接线

在 `restoreSession` 的 JSON 快照 `catch` 分支里，在回退到 checkpoint/null **之前**，
先经门控委派 `sessionFileRepair` 叶尝试修复/salvage：

1. `repairSessionFile(snapPath, { dryRun:false, backup:true })`
   - 若返回 `repaired:true`（叶发现无效消息 → 丢弃 → 原子重写 + `.bak` 备份）：
     re-read 干净结果，`_source:'json-repaired'` 还原。
2. 若 `repaired:false`（截断前缀 partial-parse 出的对象本身「有效无警告」，叶按约定
   不落盘，但磁盘仍是坏的）：最后一搏用**同叶** `tryParsePartialJson` 从原始字节
   salvage 出可用会话（`messages` 非空才采纳），同样 `_source:'json-repaired'`。
3. 以上任何异常 → fail-soft 落回既有 checkpoint/null 兜底。

## 门控（byte-revert 不变量）

- `KHY_SESSION_FILE_REPAIR`（`flagRegistry`，`mode: default-on`，off: CANON）。
- 关（env ∈ `{0,false,off,no}`）→ **完全跳过**修复分支，逐字节回退到旧的
  checkpoint/null 兜底；不 require 修复叶、不生成 `.bak`。

## 验证

```
node services/backend/tests/services/sessionFileRepairWiring.test.js   # 8/8 接线+门控+源级断言
node --check services/backend/src/services/sessionPersistence.js
node --check services/backend/src/services/flagRegistry.js
```

`sessionFileRepairWiring.test.js` 覆盖：
- 叶基线（`repairSessionFile` 重写+`.bak`；`tryParsePartialJson` salvage）；
- `restoreSession` 修复重写路径 → `_source:'json-repaired'`、`.bak` 生成；
- `restoreSession` partial-salvage 路径（`repaired:false` → `tryParsePartialJson`）；
- **门控关**（`KHY_SESSION_FILE_REPAIR=0`）→ 损坏快照返回 `null`、绝不生成 `.bak`（byte-revert）；
- 合法快照不受影响 → `_source:'json'`（零回归）；
- 源级接线断言（require 叶、调 `repairSessionFile`、用 `tryParsePartialJson`、读门控、
  off-word 模式）+ 门控 default-on 登记。

叶自身的既有单测 `services/backend/tests/services/sessionFileRepair.test.js`（jest）
继续覆盖叶行为。
