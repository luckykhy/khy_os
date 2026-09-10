# 测试债务登记 (Test Debt Register)

> **定位**：登记当前已知失败的测试套件，防止"非阻塞"变成"永久忽略"。
> **规则**：
> - 每个失败套件必须登记，包含分类、根因、处置状态
> - 只有 `@env-skip` 类可永久跳过；`@rot`（测试腐坏）与 `@bug` 必须修复
> - 3 个月后：`@bug` 类用例失败时阻断 PR
> - 6 个月后：所有用例阻断 PR
> - 门禁升级路径见 `.github/workflows/pr-gate.yml` 的 `test-baseline` job
>
> **最后更新**：2026-09-08（实测全量基线，替换此前 `tests/cli + tests/utils` 58 套件取样版）

---

## 一、实测基线（2026-09-08）

命令：`services/backend` 目录下 `node node_modules/jest/bin/jest.js`（等价 `npm test`）。
发现 1182 个 `.test.js`，jest 实际纳入 1176（6 个被 `jest.config.js` 的动态忽略排除）。

| 指标 | 修复前 | 2026-09-08 修复后 |
|---|---:|---:|
| 套件失败 | **501** | **465** |
| 套件通过 | 675 | **711** |
| 套件跳过 | 6 | 6 |
| 用例失败 | 866 | **798** |
| 用例通过 | 8227 | **8804** |

本轮回收 **36 个套件 / 577 个用例**，全部来自同一处机械修复（见 §三 A）。
**503 这个数字是准的**——与本次实测的 501 仅差 2，说明报数可靠；错的只有归因。

### 失败分类（465 个失败套件，去重后按根因互斥分桶）

| # | 分类 | 套件数 | 修复前 | 根因 | 处置 |
|---|---|---:|---:|---|---|
| 1 | 其它（含测试文件语法损坏） | 139 | 137 | 混合：见下方子项 | 待拆 |
| 2 | `@rot` 测试代码作用域错误 | 99 | 91 | 测试文件引用未定义标识符（`assert` / `detector` / `makeDetector` / `writeUser` / `mode` / `tmp` / `legacy` / `loadWithEnv` …），多数是 node:test 全局写法混进 jest 文件 | 待修 |
| 3 | 迁移遗留：旧服务路径不存在 | 91 | 139 | `src/services/domain/**` 迁移删掉逐模块文件，只留 barrel `index.js` | **部分已修**（§三 A） |
| 4 | `@bug` 断言失败 | 80 | 74 | 真实行为与断言不符 | 待逐个诊断 |
| 5 | `@bug` API 签名漂移 | 33 | 29 | 被测函数返回 `undefined` / 不再是函数 | 待逐个诊断 |
| 6 | `@rot` 双 runner 皆死 | 19 | 19 | 用 node:test 的 `test.before` / `test.after` 但没 import `node:test` | 待修 |
| 7 | 5s 硬超时 | 4 | 4 | 用例本身跑得慢（实测 5.2–17.6s） | 待加 per-test timeout |
| | **合计** | **465** | 501 | | |

**第 1 桶（139）的子项**，实测首错抽样：
- `SyntaxError: Unterminated string` / `Unexpected token` / `'return' outside function` —— 约 30 个
  测试文件**内容损坏**（集中在 `tests/services/__tests__/`、`tests/services/domain/state/stateMachine/__tests__/`、
  `tests/cli/tui/ink-components/`）。这是**文件层面**的问题，不是断言问题。
- `Error: Task not found: concurrency-w1-02a8-37` 等 —— 测试间共享状态泄漏，隔离不足。
- `● Test suite failed to run` 但日志无首错行 —— jest worker 崩溃或 setup 文件抛错。

---

## 二、与「jest moduleDirectories 解析配置」的澄清

调查最初指向 jest 的模块解析配置。`jest --showConfig` 实测：

```
moduleDirectories: ["node_modules"]      ← 默认值
moduleNameMapper:   []                   ← 空
roots:              ["<rootDir>"]        ← 默认值
haste.enableSymlinks: false
```

**解析配置完全默认，没有任何异常**——503/465 个失败与 jest 配置无关。真正的根因是
`src/services/domain/**` 迁移的兼容性缺口，见 §三。

---

## 三、已定位的根因

### A. domain 迁移删掉了逐模块文件（已部分修复）

`src/services/` 下 **139 个目录被清空成只剩 `index.js`**，例如：

```js
// src/services/plugins/index.js —— 迁移后留下的 barrel
// Auto-generated shim - re-exports from new domain location
exports.pluginContribResolver = require('../domain/extensions/plugins/pluginContribResolver.js');
```

barrel 只声明了**属性级**兼容（`require('services/plugins').pluginContribResolver`），
但**深路径**（`require('services/plugins/pluginContribResolver')`）彻底断了。
测试里 556 处深路径引用全部命中这个缺口。

**处置（2026-09-08 已执行）**：按 barrel 的 `exports.<name> = require('<新路径>')`
反推出正确目标，把测试侧 372 处导入改写过去：

- 298 处深路径 → `src/services/domain/**` 新路径（相对深度一并重算，原有深度本来就是错的）
- 74 处 `tests/services/<dir>/index.test.js` 里的 `require('./index')` → `../../../src/services/<dir>`
- 覆盖 214 个测试文件；`node --check` 全部通过，无语法回归

**改写的安全性**：带坏导入的套件本来就是加载即失败，不可能有通过的用例；
因此该操作只可能把失败套件变成能跑，不会弄坏任何当前通过的套件（实测确实只增不减）。

**未修的部分**：另有 **193 个深路径（296 次引用）指向全树不存在的模块**——
`src/services/desktopControl/backendRegistry`、`memoryEngine/distiller`、`wasm-sandbox/m1Constants`、
`dualTrack/core`、`contextScope/*`、`auditTrajectory/*`、`evoEngine/*`、`trajectoryReplay/*` 等。
这些模块的 barrel 是**空壳**（`exports=0`），全树 basename 检索无命中。
**结论：这些源文件被删除且未迁移，测试无法靠改导入修好，必须先恢复源码。**

### B. 双 runner 皆死的 19 个套件

以 `tests/tools/SaveInstruction.test.js` 为例：文件用 `test.after(...)`（node:test API）
却没有 `import { test } from 'node:test'`。

- 在 **jest** 下：`test` 是 jest 的函数，没有 `.before` / `.after` →
  `TypeError: test.before is not a function`
- 在 **node --test** 下：node:test 不把 `test` 暴露为全局 →
  `ReferenceError: test is not defined`

两个 runner 都跑不通，属真死代码。修法：补 `const { test } = require('node:test');`
（补完 `jest.config.js` 的 `findNodeTestFiles` 会按 `require('node:test')` 标记自动把它们
排除出 jest、交给 `test:node`，不需要改守卫）。注意这些文件用的是 jest 的
`expect()`，`node:assert` 下也跑不通，需一并换成 `assert.*`。

### C. 5s 硬超时

`tests/routes/cache.test.js`（17.6s）、`tests/cli/extensionCommand.test.js`（16.5s）、
`tests/tools/dbTimeout.integration.test.js` 等 4 个套件超时。jest 默认 5000ms 是**固定墙钟**
超时，不是活动超时；对这类真慢用例应逐个加 `test('...', 30000)` 形式的 per-test timeout，
而不是调大全局默认。

---

## 四、如何诊断

```bash
# 单个套件（--changed 无效时直接传路径）
cd services/backend
npm run test:one -- tests/services/memoryEngine/distiller.test.js

# 只看错误签名
npm test -- --silent 2>&1 | findstr /c:"Cannot find module" /c:"is not defined"

# 列出 jest 实际纳入哪些套件
node node_modules/jest/bin/jest.js --listTests
```

> `git` 不在本环境 PATH 上时，`check-agent-rules.js --changed` 会输出
> 「No target files found」；改为显式传文件路径。

---

## 五、下一步（按性价比排序）

| 优先级 | 动作 | 预期收益 |
|---|---|---|
| P0 | 恢复被删的 domain 模块源码（§三 A 尾部 193 个路径） | 解除约 91 个套件的加载阻塞 |
| P1 | 修复约 30 个语法损坏的测试文件 | 直接回收 ~30 套件 |
| P2 | 修 19 个双 runner 皆死套件（补 `node:test` 导入 + `assert.*`） | 回收 19 套件，且 `jest.config.js` 无需改动 |
| P3 | 逐个诊断 80 个断言失败 + 33 个签名漂移（真 bug 与测试腐坏需人工判） | 需按用例读代码 |
| P4 | 给 4 个超时套件加 per-test timeout | 4 套件 |

P0 是硬阻塞：没有源码，测试改什么都是徒劳。
