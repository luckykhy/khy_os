# [OPS-MAN-117] 还原完整性对账 · 运行时接线（让 khy restore 横幅诚实）

> 本文件为手写维护文档（此层是 bundled 运行时接线，无 `--gen-doc` 生成器）。
> 裁决逻辑改在 `services/backend/src/services/restoreCompletenessCheck.js`，
> 接线改在 `services/backend/src/cli/handlers/publish.js` 的 `_restoreFromSnapshot` /
> `handleRestore`。

## 这一层闭合什么：把 OPS-095 的能力真正接进运行时 restore

OPS-MAN-095 早已诊断出「快照头 `fileCount` 是个死字段」并写好对账裁决逻辑
（`scripts/lib/restoreCompletenessVerifier.js`），还 LIVE 验证过口径——**但它只被
一个 dev CLI（`scripts/restore-verify-complete.js`）消费，从未接进真正的运行时还原
命令 `khy restore`**。于是运行时 `handleRestore` 依旧只把 `header.fileCount`
**原样打印**（“共 N 个文件 · 目录布局原样”），陌生机器上的普通用户要额外跑一条
dev 脚本才能知道「数量真吻合吗」——绝大多数人不会跑。= **能力存在、没接线的代码**。

本层就是那条缺失的接线：在 bundled 运行时里，解包成功后立即拿磁盘上真正落地的
文件数与快照清单对账，让 `khy restore` 的横幅自己诚实起来，无需任何额外命令。

```bash
khy restore ./Khy-OS        # 解包后自动对账：落地数 === 清单数 才敢说「完整还原」
```

## 为什么 tar 退出 0 仍可能少解

`_extractTarGz` 只看 `tar` 的退出码；`header.sha256` 只防**整包传输损坏**，都不防
**解包阶段少落地**：磁盘中途写满、路径过长（Windows MAX_PATH）、不被支持的条目
类型、权限/符号链接被跳过……tar 都可能退 0 却少写文件。此时旧横幅绿字「源码已
完整还原」而磁盘缺文件 = 对用户最重要那条路径上的最毒假绿。

## 判定档（最保守优先 · 纯叶 `verifyRestoreCompleteness`）

| 档 | 条件 | 裁决 | ok |
|----|------|------|----|
| 1 | 期望缺失/非正 或 实际缺失/非法 | `unverifiable`：证据不足，**保持旧横幅**，绝不多喊「完整」 | ✗ |
| 2 | 实际 **<** 期望 | `incomplete`：**静默少解**（断桥要抓的假绿） | ✗ |
| 3 | 实际 **>** 期望 | `over-extracted`：目标目录疑有残留，据实提示 | ✗ |
| 4 | 实际 **===** 期望 | `complete`：唯一敢说「源码已完整还原」 | ✓ |

- 上游若已因 `sha256` 不符 / `tar` 非 0 退出而 `throw`，根本到不了对账点，故本叶
  不重复 `corrupt` 档——只对账两个计数。
- **对账口径**：`expected` = 快照头 `fileCount`（`makeSourceSnapshot` 用
  `git ls-tree -r --name-only` 数出、`git archive` 同一 treeish 打包的应有文件数）；
  `actual` = `sourceHealService._collectRelFiles(dest).length`（递归数还原目录里的
  常规文件，跳过 `node_modules`/`.git`/`__pycache__`/`.pytest_cache`）。两者对齐
  `git archive` 落地口径，故干净成功还原时 `actual === expected`（OPS-095 已 LIVE 证实）。

## 横幅行为（诚实但克制）

- `complete` / `unverifiable` / 门关 → **保持原横幅字节等价**（不多喊、不误降级）。
- `incomplete` → 降级为 ⚠️ 告警，打印「落地 A · 清单 B · 缺 C」+ 排障提示（清空目录后
  加 `--force` 重试）。
- `over-extracted` → 成功横幅 + ⚠️ 提示目标目录可能有残留。

## 恒久红线

- **纯诊断叠加层：绝不让还原失败**。对账最坏只把成功横幅降级为 ⚠️ 告警，
  `handleRestore` 仍 `return true`，绝不 `_markFailure`。
- 门控 `KHY_RESTORE_VERIFY_COMPLETENESS`（default-on；仅 env ∈ {0,false,off,no}
  归一后关闭）：关 → 不对账、横幅字节等价旧行为。
- 证据不足绝不谎报 `complete`；`ok===true` 仅当 `status === complete`。
- 叶子纯计算、零 IO、绝不抛；真正数磁盘的 IO 在 handler 里、fail-soft（异常吞掉、
  不附 verdict → 回退旧横幅）。
- 真 key/token 永不进包、不落盘；对账只碰**文件计数**，不触任何密钥/头值；
  pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

## 验证

```bash
npm run test:restore-completeness-check      # 纯叶单测（11 用例）
# LIVE：真快照还原横幅显「完整」；人为抽掉一个落地文件后再对账 → incomplete 告警
```
