# [OPS-MAN-076] 三面镜子矛盾冲突检测

> 本文件由 `scripts/restore-conflicts.js --gen-doc` 确定性生成，请勿手改；
> 规则改在 `scripts/lib/restoreConflictDetector.js` 的 `_CONFLICT_RULES`，再重新生成。

## 这份检测是干什么的

khyos 有三面独立还原镜子，探同一批事实却走不同代码路径：

- `restore-check`（OPS-MAN-068）：这台机器能不能还原？
- `verify-install`（OPS-MAN-069）：已装副本完整吗？
- `hydration-doctor`（OPS-MAN-070）：首启水合成功了吗？

`restore-plan`（OPS-MAN-075）把三者**合成**成一份有序还原方案——但它**默认三面镜子一致**。
不同代码路径可能给出**互相矛盾的结论**。一个 agent 若拿着**自相矛盾的世界模型**
去无人值守自动还原，会照着一面绿灯猛冲、无视另一面红灯。本检测补上这层**元诊断**：
在 agent 信任方案、开始自动还原**之前**，先问「三面镜子彼此一致吗？」。

```bash
node scripts/restore-conflicts.js --json   # landing agent 先读这个
# safeToAutodrive=false（有硬矛盾）→ agent 必须停下：重探或升级交人
```

## 两级冲突

- **`contradiction`（硬矛盾）**：两面镜子对重叠事实给出逻辑不相容的结论，
  或某面镜子自身顶层判定与明细自相矛盾。→ 世界模型不可信，**禁止自动还原**。
- **`severity`（分级分歧）**：两面镜子认同同一事实但给了不同严重度
  （如 node_modules 尚未水合：一面当首启正常提醒、一面当拦路项）。→ 事实一致、
  不阻断自动还原，但如实标注供 agent 权衡。

消解取向恒为**安全优先**：矛盾时一律信更悲观那面镜子；每条冲突的自主度恒为
`human`（不确定就交人，绝不让 agent 替你赌）。`safeToAutodrive` 为 false 当且仅当
存在 `contradiction` 级冲突。

## 检测的冲突规则

| 规则 id | 级别 | 涉及镜子 | 信谁 | 症状 |
|---------|------|----------|------|------|
| `ready-but-bundle-incomplete` | 硬矛盾 | restore ✕ integrity | integrity | 还原自检说「就绪」，但完整性自检说「已装副本缺运行时关键文件」——两面镜子结论相悖 |
| `ready-but-hydration-blocked` | 硬矛盾 | restore ✕ hydration | hydration | 还原自检说「就绪」，但水合自检说「不健康（有拦路项）」——两面镜子结论相悖 |
| `intact-but-restore-bundle-missing` | 硬矛盾 | integrity ✕ restore | restore | 完整性自检说「副本完整」，但还原自检说「bundled 源码缺失」——同一 bundle 既完整又缺失，传感器互斥 |
| `restore-internal-inconsistent` | 硬矛盾 | restore | blockers | 还原自检自相矛盾：顶层判「就绪」却带着非空拦路项清单 |
| `integrity-internal-inconsistent` | 硬矛盾 | integrity | missing | 完整性自检自相矛盾：顶层判「完整」却带着非空缺失清单 |
| `hydration-internal-inconsistent` | 硬矛盾 | hydration | blockers | 水合自检自相矛盾：顶层判「健康」却带着非空拦路项清单 |

> 注：`ready-but-hydration-blocked` 会在运行期按 hydration 的 blocker 内容动态降级——
> 若 blocker 全是首启正常态（node_modules 尚未水合）则降为 `severity`，否则维持硬矛盾。

## 保证（继承项目章程）

- 纯比对、零 IO、绝不抛：异常退化为「不放行自动还原」（不确定不自动，安全优先）。
- 处置建议绝不含 commit/push/rm/curl/publish 类危险动作；来源若不慎命中则隐去。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

