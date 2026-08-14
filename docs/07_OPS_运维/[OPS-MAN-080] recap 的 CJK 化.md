# [OPS-MAN-080] /recap 的 CJK 化：让会话回顾在中文会话下产出内容

> 送别礼「khy 缺少了 recap」角度。用户反馈截图：khy 里 `/recap` 命令在、接线全，
> 但对 khy 实际运行的**中文会话**产不出内容 —— 决策 / 洞见 / 未决问题三段全空，
> 文件名还被全角标点截断。本子系统把 recap 的抽取器 CJK 化。

## 真实原因（数据级证实）

`services/backend/src/services/sessionRecapService.js` 的抽取器全是**英文正则**：

- `_extractDecisions`：`/(?:I'll|I will|Let me|decided to|created|wrote|...)/`
- `_extractInsights`：`/(?:important|note|the root cause|because|...)/`
- `_extractOpenQuestions`：只按 ASCII `?` 切句
- `_extractFileReferences`：右边界不含 CJK 全角标点（`。，；！？`）

而 khy 是**中文优先**工具 —— assistant 用中文说话。对真实中文会话跑
`generateRecap`：

```
输入(中文会话):
  assistant: 我将创建一个纯叶子模块。根本原因是白名单只放行五种协议。
             重要:mihomo 原生支持 hysteria2。我已经创建了 proxyCoreConfigGen.js，...
  user:      那 tuic 呢？还有 wireguard 支持吗？

修前输出:
  decisions:     []          ← 全空
  keyInsights:   []          ← 全空
  openQuestions: []          ← 全空
  filesChanged:  ["router.js"]  ← proxyCoreConfigGen.js 被全角逗号「，」截断而漏抓
```

`/recap` 命令在、`router` / `routerDispatchSlash` / `commandSchema` 全接线，却对 khy
实际运行的语言**产不出内容**。这就是「缺少了 recap」的真身。

## 解决方法（本子系统所做）

**全 additive · 门 `KHY_RECAP_CJK`（default-on）· 关字节回退。**

### 1. 纯叶子 `services/backend/src/services/sessionRecapCjk.js`

纯函数、零 IO、绝不抛（异常保守返回空）。四个 CJK 抽取器，与英文侧**加性合并**
（union），绝不替换：

- `extractCjkDecisions` —— 冻结词干表 `_CJK_DECISION_MARKERS`（我将/决定/创建/修复/
  重构/回滚…），以词干起、到下一个 CJK 终结符止取片段。
- `extractCjkInsights` —— `_CJK_INSIGHT_MARKERS`（重要/根本原因/因为/之所以…），只看
  最近 5 条 assistant 消息。
- `extractCjkQuestions` —— 抽以全角「？」结尾的句子。
- `extractCjkFileReferences` —— 文件名正则的左右边界纳入 CJK 全角标点
  （`。，；！？、（）「」【】：`），补齐被截断的引用。

**含子去重** `_pushContainmentUnique`：同一句可能同时命中多个词干（「我已经创建了 X」
既中「我已」又中「创建」），只保留最完整的片段一次。

### 2. 服务层最小接线（`sessionRecapService.js`）

防御式 `require('./sessionRecapCjk')`（缺失也不致命），在 decisions / filesChanged /
openQuestions / keyInsights 四个抽取点做 `_mergeUnique(英文结果, CJK结果)`。门关或 CJK
叶子缺失 → 各 helper 返回 `[]` → union 空 → **逐字节回退**到原英文行为。

### 修后输出

```
decisions:     ["我将创建一个纯叶子模块","我已经创建了 proxyCoreConfigGen.js","修复了白名单",...]
keyInsights:   ["重要:mihomo 原生支持 hysteria2","根本原因是白名单只放行五种协议",...]
openQuestions: ["那 tuic 呢？","还有 wireguard 支持吗？"]
filesChanged:  ["proxyCoreConfigGen.js","proxyUriParsers.js"]  ← 全角标点后的文件名补齐
```

## 诚实边界

- `/recap` 仍是**确定性**抽取（无模型、离线、可复现），CJK 化只扩大抽取覆盖，不引入模型。
- `formatRecap` 的段标题（Topics / Key Decisions / …）仍为英文，属渲染层，本次未动
  （外科手术式，不顺手扩范围）。
- 门 `KHY_RECAP_CJK` 为 sibling 问题类门，不进 flagRegistry（同家族先例）。

## 验证

```
npm run test:recap-cjk        # 叶子契约 18/18 + 服务层合并 4/4
node --test services/backend/tests/services/sessionRecapCjk.test.js
node --test services/backend/tests/services/sessionRecapService.cjk.test.js
```

## 相关

- 命令薄壳：`services/backend/src/cli/handlers/recap.js`（门 `KHY_RECAP`）
- 底座服务：`services/backend/src/services/sessionRecapService.js`
- 对齐参考：Claude Code `/recap`（离开期间的模型生成回顾；khy 无 away 边界，故对整段
  当前会话做确定性回顾）
