# Khy-OS 错误自查（先分类，再对症）

出错、没生效、或怀疑改坏时，**先判断属于哪一类**，再按该类修法处理。

## 先做只读体检（不改任何东西）

```bash
node services/backend/bin/khy.js maintain freshness   # 与时俱进体检
node services/backend/bin/khy.js health                # 顶层自助诊断
```

---

## P 类 · 流程错误（最常见，也最隐蔽）

| 症状 | 真因 | 修法 |
| --- | --- | --- |
| 声称"已实现"但功能没生效 | **没接到真实入口**（隔离测试骗了你） | 确认能从 `executeTool`/`toolUseLoop.js`/`aiManagementServer.js` `require` 到 |
| 逻辑重复、行为不一致 | **造了第二份真源** | 删掉新的，复用既有唯一权威实现 |
| 关掉 `KHY_` 开关行为变了 | **破坏了逐字节回退** | 接线加 `try/catch`，门关时保留旧值 |
| 只报进度不给结论就停 | **未交付收尾** | 激活 `/khy-honest-closure` |
| 守卫红了想绕过 | 守卫红=有真问题 | **修问题，绝不 `--no-verify`** |
| 引用了不存在的文件/函数 | **幻觉** | 先 `grep`/读文件确认存在再引用 |
| 单文件越改越大 | 堆成上帝组件 | 抽纯叶子，原文件 re-export；单文件 ≤2500 行 |

**在产自查命令**（确认叶子真被接进来）：
```bash
grep -rl "require(.*/<模块名>" services/backend/src --include=*.js | grep -vE "/<模块名>/|tests/"
```

## W 类 · 小模型专属坑

结果过大撑爆上下文 / `max_tokens` 太低被截断 / `role:'tool'` 被某些 provider 拒 / JSON 被包在代码块里解析不出。
→ **别破坏已有兼容层**；细节激活 `/khy-weak-model-guardrails`。

## B 类 · 代码缺陷原型（写新代码时对照预防）

裸 `startsWith` 边界未锚定 · 大小写未折叠 · 正则缺锚点 · 越界码点崩溃 · 密钥脱敏漏现代 key · cron step=0 死循环 · `slice(-0)` 语义反转 · 闭包捕获过期 `resolve`/监听器泄漏 · 字符集乱码 · SSRF 等价表示形绕过 · 破坏性命令 flag 大小写/顺序敏感 · 数值格式边界错档 · 阈值小窗口下溢为负。

**通用预防自问**（处理外部输入/安全判定时）：
> 边界锚定了吗？大小写折叠了吗？越界/空/0/负都处理了吗？坏输入是崩溃还是 fail-soft？等价形都覆盖了吗？

## G 类 · 网关/模型路由

- G1 模型名泄漏给不认识它的通道 → 404
- G2 默认值散落硬编码
- G3 鉴权形态过时
- G4 请求侧新字段被丢弃
- G5 视觉模型被误判纯文本退回 OCR

→ 细节激活 `/khy-gateway-fix`。

## E 类 · 环境

- Node ≥ 20。
- **改了源码没重打包，pip 用户拿不到**。
- 版本号多处不一致（backend `package.json` 与发布版本对齐）。
- `node:test` 传**文件**别传目录；别与 jest 混跑。

---

## 兜底

慌乱止血 → `docs/传承/紧急恢复卡片.md`。
要回退某文件：`git checkout <好的哈希> -- <文件>`。
