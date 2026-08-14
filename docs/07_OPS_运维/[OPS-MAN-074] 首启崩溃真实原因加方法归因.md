# [OPS-MAN-074] 首启崩溃：真实原因 + 方法归因

> 送别礼「错误真实原因加方法」角度。pip 与 npm 是仅有的两条离机渠道。他机装完
> **首次运行**时，最阴险的失败不是「装不上」，而是「装上了、进程也起来了、深层
> `require` 才崩」——今日只吐一行**裸 stack**，使用者根本看不懂发生了什么、更不知怎么修。
> 本子系统把该崩溃归因成一句「真实原因」+ 几条照抄即用的「解决方法」。

## 它补的真实缺口

- `platform/khy_platform/cli.py:2305` 早已为「`bin/khy.js` 文件缺失」示范了
  「真实原因 + 解决方法」的好样子，但它**只管文件不在**的情形；且 Unix 上
  `os.execvpe` 之后 Python 侧的归因已不可达。
- 更常见的是**依赖不齐**：文件在、`node -e` 起来、加载 backend 时深层 `require`
  抛 `MODULE_NOT_FOUND`。两条渠道都会汇到这里：
  - pip：`_bootstrap.py` 首启 hydrate 失败 → marker 未写 → 仍继续启动 → 崩。
  - npm：`postinstall.js` / `devenv.js` 吞掉 hydrate 失败 → `exit 0` → 首启才崩。
- 崩点在 `services/backend/bin/khy.js` 的 `_emitFatal`（`uncaughtException` /
  `unhandledRejection` 兜底）。归因逻辑仓内早有（`scripts/lib/hydrationHealth.js`
  的 `_RULES`），但它只在 doctor CLI 跑，**从不在崩溃路径**。本子系统把「崩溃现场
  的 `err`」→「真实原因 + 方法」，交给 `_emitFatal` 追加呈现（保留裸 stack 供维护者）。

## 与四件构建期送别礼的区别

`restore-readiness` / `install-integrity` / `hydration-health` / `bundle-launch-contract`
四件都是**构建/发布期**守卫，在发布仓跑、**不进 bundle**。本件是**运行时**错误增强，
随 backend 源码树一起打包进 pip/npm，故落在 `services/backend/src/bootstrap/`，而非
`scripts/lib/`。

## 分层（同 windowsSpawnHardening）

- **纯核心** `services/backend/src/bootstrap/startupFailureExplain.js`：零 IO、无时钟、
  无随机、同输入恒同输出、**绝不抛**（任何异常退化为安全 `null`）。
- **IO / 呈现** 在 `bin/khy.js` 的 `_emitFatal`；且对纯叶子的 `require` 亦包 `try/catch`
  ——崩溃现场依赖可能就缺，**绝不让归因本身加重致命路径**。

## 门控

`KHY_STARTUP_FAILURE_EXPLAIN`（default-on，CANON off 4 词：`0/false/off/no`）。
关 → `explainStartupFailure` 返回 `null` → `_emitFatal` **逐字节回退**今日裸 stack 行为。
刻意**不进 flagRegistry**（sibling 门；注册表对未登记 flag 会回默认开、吞掉 `off`，且
崩溃现场 `require` 注册表可能命中缺失依赖），直读 env 最简且最安全。

## 当前归因类别

| id | 触发信号 | 真实原因 | 方法要点 |
| --- | --- | --- | --- |
| `module-not-found` | `err.code === 'MODULE_NOT_FOUND'` 或 message 含 `Cannot find module 'X'` | 后端依赖未装齐（首启 hydrate 未完成/被中断/半装），点名缺失模块 | 重跑 khy 触发 hydrate；仍缺则删 marker+lock 全量重装；win32 先 `khy stop` 再 pip 重装；源码则 `npm install` |
| `native-abi-mismatch` | `err.code === 'ERR_DLOPEN_FAILED'` 或 message 含 `.node` / `shared library` / `different Node` | 原生模块与本机 Node/平台 ABI 不匹配（跨平台复制未重建） | `npm rebuild better-sqlite3` 或删 `node_modules` 重跑；确认 Node ≥ 20 且一致 |

未识别的 `err` → 返回 `null` → 逐字节回退今日裸 stack（保守，不瞎归因）。

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

1. 新增一类首启崩溃归因 → 往 `_CLASSIFIERS` 追加一条 `{ id, match(ctx), build(ctx) }`。
   `match(ctx)` 纯谓词（`ctx = {code, message, missingModule, platform}`）；`build`
   返回 `{ cause, fixes:{common,win32,unix} }`。
2. 修法务必安全——不得含 `git commit`/`git push`/`rm -rf`/`curl`/`wget`/`npm publish`
   等危险动作（`_DANGER_TOKENS` 自检守此线，命中则整条放弃、回退 `null`）。
3. 改完跑：`npm run test:startup-failure-explain`（node:test，须全绿）。

## 验证

```bash
npm run test:startup-failure-explain
# 或直接
node --test services/backend/tests/bootstrap/startupFailureExplain.test.js
```

## 相关

- `platform/khy_platform/cli.py:2305`（文件缺失情形的姊妹归因，本件补依赖不齐情形）
- `scripts/lib/hydrationHealth.js`（同源归因逻辑，doctor 路径；本件把它带到崩溃路径）
- [OPS-MAN-070] hydration 健康自检、[OPS-MAN-073] 离机渠道启动入口契约
