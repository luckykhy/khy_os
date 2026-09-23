# [OPS-MAN-079] 三面镜子矛盾冲突消解

> 本文件由 `scripts/restore-resolve.js --gen-doc` 确定性生成，请勿手改；
> 消解逻辑改在 `scripts/lib/restoreConflictResolver.js`，再重新生成。

## 这一层在解决什么

还原家族已有四层，本文件是**第四层**：

1. 三面镜子 `restore-check` / `verify-install` / `hydration-doctor`（各自诊断）；
2. `restore-plan`（OPS-MAN-075）把三者**合成**为有序还原方案——默认三镜子一致；
3. `restore-conflicts`（OPS-MAN-076）**检测**三镜子是否矛盾——发现硬矛盾即一刀切
   「止步交人」（每条冲突 autonomy 恒为 `human`）；
4. `restore-resolve`（本文件）**消解**——把那记一刀切的红灯，升级成一套*有原则、
   有序、安全优先*的恢复程序，并**精确标出**自动化在哪一步必须交人。

检测只回答「矛不矛盾」；消解回答「矛盾了，agent 该怎么安全地一步步解开、到哪必须停手」。
这正是 khy 此前缺的 agent 创新点：系统不再只亮红灯，而是主动交出一份可自驱的恢复链。

```bash
node scripts/restore-resolve.js --json   # landing agent 先读这个
# autoResolvable=true → 按 moves 顺序自主消解后继续自动还原
# autoResolvable=false → 跑到 firstHumanMove 即止步交人
```

## 为什么不能把矛盾全丢给人

检测器出于安全，对任何硬矛盾都盖一句「止步交人」。但矛盾其实分层：

- **瞬时/竞态读数**（装到一半时抢跑）→ 最便宜的解法是重探一次，可能直接消失；
- **单面镜子自相矛盾**（顶层布尔与明细清单打架）→ 采信一手证据即当场化解，无需外部动作；
- **跨镜子真分歧**（两面都自洽却结论互斥）→ 安全优先采信更悲观者并跑其补救；
- 只有**重探不消失、且补救本身越界**（重装/查安装路径）的，才真正需要人。

把这四类不加区分地全丢给人，等于让 agent 在本可自愈的场景下也干等——既拖慢还原，
也违背「让系统自己讲清如何自主恢复、并精确止步升级」的初衷。

## 四种消解策略

| 策略 | 成本序 | 自主度 | 什么时候用 |
|------|--------|--------|------------|
| `reprobe`（重探） | 10 | agent | 重跑起分歧的探测器；最便宜、幂等、零风险，可能直接消解 |
| `reconcile`（自洽消解） | 20 | agent | 单面镜子内部打架时，采信明细清单（一手证据）而非顶层布尔（派生结论） |
| `trust-pessimistic`（采信悲观） | 30 | agent／human | 跨镜子真分歧时采信更悲观者并跑其补救；补救幂等→agent，越界→human |
| `escalate`（升级交人） | 90 | human | 重探不消失、无安全自动解法（如安装路径级互斥）→ 残留冲突 |

每条矛盾配一条**有序恢复链**（reprobe → reconcile → trust-pessimistic → escalate），
逐条判定 `autoResolvable`（终局落 agent 且全链不含 escalate）。整体 `autoResolvable`
当且仅当**每条**矛盾都可 agent 自主消解（无残留交人）；此时 `safeAfterResolution` 为真。

## 冲突 → 消解方案对照

| 冲突 id | 消解链 | 收敛到 |
|---------|--------|--------|
| `ready-but-bundle-incomplete` | 重探(agent) → 采信悲观(human) | 收敛到「未就绪、需补齐缺失文件」的一致结论 |
| `ready-but-hydration-blocked` | 重探(agent) → 采信悲观(human) | 首启常态→跑一次 khy 收敛；真拦路项→收敛到「未就绪、按水合补救」 |
| `intact-but-restore-bundle-missing` | 重探(agent) → 升级交人(human) | 重探对齐则消解；仍互斥则残留为需人工排查安装路径的冲突 |
| `restore-internal-inconsistent` | 自洽消解(agent) | 以明细拦路项为准（视为未就绪），自相矛盾当场消解 |
| `integrity-internal-inconsistent` | 自洽消解(agent) | 以明细缺失清单为准（视为不完整），自相矛盾当场消解 |
| `hydration-internal-inconsistent` | 自洽消解(agent) | 以明细拦路项为准（视为不健康），自相矛盾当场消解 |

> 注：`ready-but-hydration-blocked` 的消解链在运行期按 hydration 的 blocker 内容动态成形——
> 首启常态只需一次重探；含结构性拦路项（缺种子等）则采信悲观步落 `human`。

## 保证（继承项目章程）

- 纯计算、零 IO、绝不抛：异常退化为「不可自动消解、须人工」（不确定不自动，安全优先）。
- 每条消解 action 先过危险令牌自检；命中 commit/push/rm/curl/publish 即强制交人并隐去原文。
- 消解器每个冲突 id 都必须与检测器 `_CONFLICT_RULES` 一一对应（有漂移守卫测试盯着）。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

