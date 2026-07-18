# [OPS-MAN-131] 重复代码检测门 + OCR 网关公共测试脚手架

> 症状 → 子系统速查：当你看到「测试文件里成片复制粘贴的脚手架」「想统一维护重复函数」
> 「CI 该拦下大段抄代码」时读本手册。单一真源见 `docs/维护者/维护映射表.json` 的
> `ci-duplication-guard` area。

## 背景（goal 2026-07-12）

用户诉求（逐字）：**「第一，把所有重复的函数提取成公共库，统一维护。第二，在 CI 里加了
重复代码检测，超过三行相同就报警。」**

OCR 网关测试族（`services/backend/tests/gateway/` 下 20 个 `.test.js`）在过去十几轮送别礼
里反复复制粘贴同一套测试脚手架（`_wireGateway` / `_makeRecordingAdapter` /
`_makeRejectAdapter` / `_realExtractImageOcrDetails` / `_haveTesseract` / `_findPython` /
PIL 渲图 / env 存还原）。人肉盯梢挡不住复制粘贴；本次把它一次性抽成公共库并加机器门。

## 两件事

### 1) 公共测试脚手架 `services/backend/tests/gateway/_ocrGatewayHarness.js`

**参数化工厂**，一处实现吸收 20 个文件的差异（最终 content 串、单/级联适配器形态、
是否捕获图、describe 分支、prompt 文案、env key 列表、渲染文字），与各文件原地 harness
**逐字节等价**。下划线前缀 → 不被 `*.test.js` 选中。**本文件确有 IO**（spawnSync/fs/
imageService），头注释**不作**「纯叶子/零 IO」声明（否则 `check-leaf-contract` 的 leaf-io
规则命中）。

导出 API：`makeRecordingAdapter(opts)→handle`（`handle.finalPrompt/finalImages` 实时观测，
取代 20 处 `let _finalPrompt`）、`makeRejectAdapter()`、`wireSingle`/`wireCascade`、
`realExtractImageOcrDetails`、`haveTesseractLang`/`tesseractPresent`/`findPython`/
`findPythonWithPil`、`renderPng`、`makeRunner`（`run`/`runCapture`/`uniq`）、`envSandbox`、
`imagesStripped`。

迁移契约：各测试文件读法从 module 变量改为句柄字段
（`let _finalPrompt` → `const rec = makeRecordingAdapter(...); rec.finalPrompt`），
测试体/断言/describe-test 名/env key/content 串/特性注释**全部保持不变**。

### 2) 自研重复代码检测 `scripts/check-duplication.js` + `scripts/lib/duplicationGuard.js`

仿本仓 `check-leaf-contract` / `check-agent-rules` 的「薄 CLI + 纯 guard 核心」分层。

- `scripts/lib/duplicationGuard.js`：纯叶子判定核心（只用 `crypto`/`path`，零 IO、确定性、
  fail-soft）。主闸 `KHY_DUPLICATION_GUARD`（显式 `0/false/off/no` 关）。集合级
  `assess({files,baseline,mode,minBlock,env}) → {findings,classes}`。
- `scripts/check-duplication.js`：一切 IO（递归 walk / 读文件 / 读写基线 / git diff）。
- `.duplication-baseline.json`（仓库根）：存量重复白名单，指纹 = 归一化窗口内容 hash
  （非 file+line，抗位移；抽公共库删掉重复副本后其 hash 自动从语料消失）。

**算法**：行归一化（trim + 折叠空白，跳过空行/纯注释/纯结构标点）→ 滑窗 `MIN_BLOCK=4`
有效行（即「超过三行」）→ sha1 → 某 hash ≥2 处出现即克隆类 → 同文件相邻窗口合并极大跨度 →
每（文件,跨度）一条 finding。

**阶段化（用户决策：先告警 + 基线，迁移后转硬门）**：
- 阶段一 `DEFAULT_MODE='warn'`：全部 → warning，存量重复绝不红 CI。独立存在，
  **不**进阻塞聚合 `check:small-model:safety`。
- 阶段二 `--gate` / `KHY_DUPLICATION_MODE=gate`：∈基线 → warning、∉基线 → error（新重复挡回）。
- **翻转成硬门 = 一处可评审 diff**：改 `DEFAULT_MODE` 为 `'gate'` + 重跑 `--write-baseline`
  （迁移后基线应更小）+ 把 `check:duplication` 并入安全聚合。

## 命令

```
npm run check:duplication            # warn 扫默认 scope（services/backend/tests/gateway）
npm run check:duplication:strict     # 有 warning 即 exit 1
npm run check:duplication:gate       # 硬门:∉基线 → error
npm run check:duplication:baseline   # 生成/刷新 .duplication-baseline.json
npm run test:maintainer:duplication  # 两支测试(guard 核心 in-process + CLI e2e)
```

## verify（会亮红灯 = 未完成）

```
node --check scripts/lib/duplicationGuard.js scripts/check-duplication.js
node --test scripts/tests/duplicationGuard.test.js scripts/tests/check-duplication.test.js
npm run check:duplication            # warn:存量重复只告警不红
```

## HOW-TO-EXTEND

- 扩大扫描范围：`scripts/check-duplication.js` 顶部 `DEFAULT_SCOPE`（或跑时传 positional 目录）。
- 调整「几行算重复」：`duplicationGuard.js` 的 `DEFAULT_MIN_BLOCK`（当前 4 = 超过三行）。
- 加跳过类别（如导入行）：`duplicationGuard.js` 的 `COMMENT_LINE_RE` / `PUNCT_ONLY_RE` / `isSignificant`。
- 翻转硬门：见上「阶段二」，改 `DEFAULT_MODE` + 重写基线 + 并入聚合，一处 diff。
