# [OPS-MAN-114] 还原字段归属探针（label preservation）

> 本文件由 `scripts/restore-field-attribution.js --gen-doc` 确定性生成，请勿手改；
> 判定逻辑改在 `scripts/lib/restoreFieldAttribution.js`，再重新生成。

## 这一层闭合什么：效应探针「数得到」但「看不见打在哪」的盲区

效应探针（OPS-113）只**数**「某快照头字段动了几道还原门」——它是 breadth-blind，只问
「≥1 门反应吗？」。这抓得住「消费者被摘」（死字段），却抓不住**消费者被挪到错的门**。

设想一次重构把 `crypto.algo` 的效应从 `crypto(110)` 挪到了 `provenance(107)`（来源门的
裁决开始随加密算法而变）。OPS-113 依旧**全绿**——`crypto.algo` 仍然 ≥1 门反应。但这是
**真串扰**：git 溯源的诚实裁决竟被加密算法左右 = 关注点泄漏；而且加密字段一旦能左右
非加密裁决，还是**安全隐患**。本层就是那个缺失的**归属回归守卫**。

## 思想来源：Jacobian lens 的 §4.3.2「label preservation」

源自 Anthropic《Verbalizable Representations Form a Global Workspace in Language Models》。
论文里，广播头（broadcast head）必须**同时**过两道独立评分：

- **gain**：把一个方向放大得够广（≈ 本字段**有没有**效应）；
- **label preservation**：把方向 `v_i` 忠实地映**回它自己**（`cos(W_OV v_i, v_i)` 高），
  而不是把它和别的方向 `v_j` **打散**混在一起（scrambled label）。

两条正交。落到 khy 还原家族：

| 论文 | khy 探针 | 问的问题 | 抓的回归 |
|------|----------|----------|----------|
| gain / breadth | 效应探针 OPS-113 | 字段**有没有**效应？ | 消费者被摘（死字段） |
| label preservation | 归属探针 OPS-114（本层） | 效应打在**对的门**上没？ | 消费者被挪错门（串扰） |

## 怎么判：实际反应门集 vs 声明属主门

声明属主直接取自 OPS-113 `CONTRACT_FIELDS` 每字段的 `wiredBy`（如 `OPS-107`），与门名里的
编号（如 `provenance(107)`）按**数字令牌**匹配。对每个契约字段：

| 归属档 | 条件 | 裁决 | ok |
|--------|------|------|----|
| `faithful` | 恰好只反应其声明的属主门 | label preserved | ✓ |
| `cross-talk` | 反应了**非**属主门 | 串扰 / 关注点泄漏（OPS-113 看不见） | ✗ |
| `partial` | 缺失某个声明的属主门（仅多属主 `wiredBy` 可能） | 声明的消费者掉了一个 | ✗ |
| `dead` | 一门都不反应 | OPS-113 领域，此处照实报 | ✗ |
| `unattributed` | 字段无 `wiredBy` / 取不出编号 | 无从判归属，保守非 ok | ✗ |

- `ok===true` 仅当**每个**契约字段都 `faithful`；否则 `miswired`。
- 若某字段**本应**被多道门消费（真正的广播字段），把 `wiredBy` 写成含多个编号的串
  （如 `OPS-105+108`）——本层按「门名含其中任一编号即算属主」，缺任一属主门 → `partial`。
- `--json` 在非 `ok` 时**退出码 2**：CI / 自驱 agent 据此发现「还原字段归属出现回归」。

## 恒久红线（继承全家族 + 密钥卫生）

- 证据不足（上游效应探针无字段：无门 / 无语料 / 结果畸形）一律判 `unverifiable`：绝不臆造绿灯。
- **绝不读、绝不打印、绝不扰动任何密钥/口令/明文材料**：入参 `probeResult` 已由 OPS-113 保证
  不含快照头取值；本层只碰字段路径与门名，输出只含路径、门名、OPS 号、归属标签，绝不含 header 取值。
- 叶子纯计算、零 IO、绝不改入参、绝不抛；采事实复用 OPS-113 的 `buildEffectProbe`（确定性扰动）。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

