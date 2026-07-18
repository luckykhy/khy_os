# [OPS-MAN-130] 还原来源可溯性 · 接线运行时横幅（让 khy restore 诚实告知「这份源码等于哪个 git 状态」）

> 本文件为手写维护文档（此层是运行时接线，无 `--gen-doc` 生成器）。承接 OPS-MAN-107（dev 侧
> 来源可溯性对账 `scripts/lib/restoreProvenance.js`）。
> 运行时判定改在 `services/backend/src/services/restoreProvenanceCheck.js`（bundled 纯叶·零 IO·绝不抛），
> 接线改在 `services/backend/src/cli/handlers/publish.js` 的 `handleRestore` 成功横幅。

## 这一层闭合什么：captureMode / includesUncommitted / dirty 是运行时死三字段

快照头（`snapshot.json`）由 `makeSourceSnapshot.js` 忠实记录这份快照是**怎么捕获**的
（`makeSourceSnapshot.js:240-248`）：

| 字段 | 值 | 含义 |
|---|---|---|
| `captureMode` | `'working-tree'`（默认）\| `'head'` | 从工作树打包，还是从某个提交 archive |
| `includesUncommitted` | `true` \| `false` | 是否含未提交改动（tracked 改动 + untracked） |
| `dirty` | `true` \| `false` | 捕获时工作树是否脏 |
| `gitCommit` | `'<sha>'` | 捕获时 HEAD 所在提交 |

dev 侧早已写好纯叶 `scripts/lib/restoreProvenance.js`（`assessRestoreProvenance`，OPS-107）能据此
裁决「这份还原源码到底等于哪个 git 状态」，但它**只被 dev CLI 消费**（`scripts/restore-provenance.js` /
`restore-effect-probe.js`），**从未接进运行时还原路径**。运行时 `handleRestore` 的成功横幅
**只打印 `gitCommit`**：

```
共 4312 个文件 · commit 44a491fb · 目录布局原样
```

`grep captureMode` / `grep includesUncommitted` 在 `services/backend/src/` 的还原代码里**零消费者**
= 死三字段（断桥）。

## 离机场景为什么最毒

**默认 shipped 快照就是脏捕获**（`captureMode='working-tree'` · `includesUncommitted=true`——
`makeSourceSnapshot.js:241` `includesUncommitted: mode === 'working-tree'`）。也就是说，还原出来的
源码 = 提交 `44a491fb` **加上未提交增量**，**不等于** `44a491fb` 这个干净提交。但陌生机器上的
维护者只看到横幅那句「commit 44a491fb · 目录布局原样」→ 合理地误判「我还原的就是 44a491fb」→

- 拿它去 `git diff 44a491fb` 看到一堆幻影差异，以为还原坏了；
- 或把它当成「发布的那份代码」——全错，因为它比那个提交多了未提交的活儿。

本层就是那个缺失的**横幅期消费者**：把一句会误导的「commit X」，补上「这份源码到底等于哪个
git 状态」的诚实裁决 + 一行诚实横幅。

## 和已接线的三层还原诊断正交（读的字段完全不重叠）

| OPS | 阶段 | 读的字段 | 管什么 |
|---|---|---|---|
| 119 restore-preflight-check | 解密**前** | format / formatVersion / crypto.* | 本机解不解得开密文 |
| 128 restore-archive-extract-check | 解密后、解包**前** | plaintextFormat / layout | 本机 tar -xzf 认不认识这团归档 |
| （completeness）restore-completeness-check | 解包**后** | fileCount | 落地文件数量对不对 |
| **130 restore-provenance-check（本层）** | 还原成功、打**横幅**时 | captureMode / includesUncommitted / dirty | 这份源码等于哪个 git 状态 |

四者覆盖还原路径四个不同阶段，字段集互不重叠。

## 怎么判：来源诚实门（最保守优先 · 没有正面证据绝不谎称 clean）

`assessRestoreProvenance(header)` 纯函数、绝不抛。判定链（越像「不该说 clean」越靠前）：

1. header 非对象 / 数组 → `unverifiable`（无从判断来源）。
2. 无 `gitCommit`（非串 / 空）→ `no-provenance`（没记录任何提交）。
3. 脏捕获（`includesUncommitted===true` 或 `dirty===true`）→ `dirty`（== 提交 X + 未提交增量）。
4. 有正面 clean 证据（`captureMode==='HEAD'|'head'`，或 `includesUncommitted===false`）→ `clean`（== 提交 X）。
5. 其余（有提交、非脏、无正面 clean 证据）→ `indeterminate`（保守不臆断）。

`ok===true` **仅当** `status==='clean'`。其余 4 档一律 `ok:false`。

> 大小写注记：`makeSourceSnapshot` 的 head 模式写 `captureMode='head'`（小写）且 `includesUncommitted=false`，
> 故第 4 档即便只匹配 `'HEAD'` 也会被 `includesUncommitted===false` 兜住判为 clean；本叶两种大小写都认，稳妥。

## 横幅渲染：buildProvenanceBannerLine(verdict) → {severity, line} | null

把裁决翻成一行给运行时 restore 横幅：

- `dirty` → `severity:'warn'`（`printWarn` 诚实告警：不等于干净提交，提到 `git diff <short>`）；
- `clean` → `severity:'info'`（`printInfo` 附注：可证等于干净提交）；
- `indeterminate` / `no-provenance` → `severity:'info'`（保守附注）；
- `unverifiable` / 裁决畸形 → `null`（不打行，横幅字节等价旧行为）。

渲染是纯函数、可单测；严重度路由（printWarn vs printInfo）留给 `publish.js`。

## 修法：handleRestore 成功横幅后追加诚实行

`publish.js` `handleRestore`（require 处 + 门助手 `_restoreProvenanceEnabled` + 横幅块之后）：

```js
// 来源可溯性诚实行（门 default-on）
if (_restoreProvenanceEnabled()) {
  try {
    const _pv = assessRestoreProvenance(result.header);
    const _pl = buildProvenanceBannerLine(_pv);
    if (_pl && _pl.line) {
      if (_pl.severity === 'warn') printWarn(_pl.line);
      else printInfo(_pl.line);
    }
  } catch { /* 来源把关异常 → 不打行，横幅字节等价旧行为 */ }
}
```

纯诊断叠加：**绝不改变还原成败、绝不 `_markFailure`**；证据不足 / 门关 / 抛错 → 不打行（字节等价）。

## 门控 / fail-soft

- 门 `KHY_RESTORE_PROVENANCE`（默认开；env ∈ {0,false,off,no} 归一后关）。关 → 横幅不附来源行、
  字节等价旧行为（只印 commit）。
- 纯叶各函数绝不抛；接线处 `try/catch` 兜底。

## 恒久红线

- 没有正面 clean 证据绝不谎称 clean：任何脏 / 不确定 / 缺来源 → `ok:false`，诚实披露。
- 只披露不阻拦：dirty 是**合法且完整**的还原（内容一字不缺），只是不等于干净提交——本层把
  静默误导变成诚实标注，不改变还原本身的成败。
- 只读来源字符串，绝不碰任何密钥；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。
- 本叶逻辑须与 dev 叶 `scripts/lib/restoreProvenance.js` 判定链保持一致（同一诚实标准的两处实现）。

## 验证

```bash
npm run test:restore-provenance-check     # 纯叶 + 横幅渲染单测(22 用例)
npm run test:restore-archive-check        # OPS-128 无回归
npm run test:restore-preflight            # OPS-119 无回归
# LIVE(真 encrypt + 真 tar.gz 驱动真实 handleRestore):
#   默认脏工作树快照(includesUncommitted=true) → 横幅追加 warn 行「= 提交 X + 未提交增量，不等于干净提交」;
#   includesUncommitted=false → info 行「可证等于干净提交 X」;
#   KHY_RESTORE_PROVENANCE=0 → 横幅不附来源行(字节等价旧行为);
#   缺 gitCommit → info 行「无从溯源」(保守 no-provenance)。
```
