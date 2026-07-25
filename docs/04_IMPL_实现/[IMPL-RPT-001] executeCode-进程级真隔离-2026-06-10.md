<!-- 文档分类: IMPL-RPT-001 | 阶段: 实现 | 原路径: docs/修复记录/executeCode-进程级真隔离-2026-06-10.md -->
# executeCode 进程级真隔离修复

**日期**：2026-06-10
**域**：执行臂（Agent 网关 / 工具执行器 — 零信任域）
**级别**：🔴 需人工介入 → ✅ 已解决
**文件**：`services/backend/src/tools/executeCode.js`

---

## 一、缺陷本质

`executeCode` 工具执行 Agent 可控的任意 JavaScript。历史实现用 `vm.runInNewContext`
并注入宿主域 intrinsics，逃逸轻而易举：`Date.constructor("return process")()` 直达宿主
RCE（fs / child_process / 环境变量外泄）。

12 小时重构引擎的第 6 次循环做了**进程内 vm 加固**（默认禁用 + 严格 IIFE + 不注入宿主对象），
极值推演发现仍有 1/7 向量逃逸：

```js
globalThis.constructor.constructor("return process")()  // → [object process]
```

根因：vm 上下文的**全局对象本身不可避免是宿主对象**，`globalThis.constructor` 即宿主
`Object`，`.constructor` 即宿主 `Function`，于是重新桥回宿主域。Node 官方文档原文：
*"the vm module is not a security mechanism. Do not use it to run untrusted code."*
进程内 vm **无法**密封此逃逸，遂标记 🔴 需人工介入。

## 二、修复方案：把代码移出本进程的 V8 域

真正的隔离要求代码离开主进程 realm。新实现在**全新 fork 的 `node --permission` 子进程**
中执行用户代码（Node Permission Model，Node 20+/24 稳定）：

- **不授予任何 `--allow-*`**：即便内层 vm 被逃逸，代码落在一个**无能力**进程里 ——
  文件读写、子进程派生、worker 线程、原生插件全部由 Node 在系统调用边界拒绝。
- **最小 env**：子进程只拿到源码字符串（`__KHY_SRC__`），不继承任何宿主密钥。
- **双超时**：内层 vm 超时（默认 5s）界定同步代码；外层进程超时（默认 8s）是
  `SIGKILL` 硬兜底。
- **fail-closed**：无 sentinel 结果（被杀 / 启动失败）一律返回结构化错误，**绝不回退**
  进程内执行。

三层纵深防御：
1. 默认禁用，仅 `KHY_ENABLE_EXECUTE_CODE=1` 时运行（运维知情决策）。
2. 子进程内仍走严格模式 vm 包装（不注入宿主对象，顶层 `this === undefined`）。
3. 子进程本身无 fs / process / worker / addon 能力。

关键标记位于文件头 `[SAFE]` 注释块与各 Layer 注释。

## 三、极值推演（对生产模块实测）

`KHY_ENABLE_EXECUTE_CODE=1`，6 个逃逸向量 + 功能 + 超时 + 默认禁用：

| 向量 | 结果 |
|------|------|
| `globalThis.constructor.constructor` → `fs.readFileSync('/etc/passwd')` | contained |
| `this.constructor.constructor` → `process.env.HOME` | contained |
| `Date.constructor` → `process.pid` | contained |
| `globalThis.constructor.constructor` → `child_process.execSync('id')` | contained |
| `globalThis.constructor.constructor` → `fs.writeFileSync('/tmp/khy_pwn_prod')` | contained |
| `globalThis.constructor.constructor` → `JSON.stringify(process.env)` 外泄 | contained（仅见 `__KHY_SRC__`） |

- **总逃逸数：0**
- 合法代码：`Math.max(2,40)+...` → 46；`JSON.stringify` 正常；多行 map/reduce → 14。
- 失控循环 `while(true){}`：vm 超时 5047ms 被杀，返回结构化超时错误。
- `/tmp/khy_pwn_prod` 未创建。
- 默认禁用路径：正确拒绝。

回归：`jest 'tools|security|executeCode'` → **15 suites / 167 tests 全绿，零回归**。

**推演通过。**

## 四、遗留风险（已记录，非致命）

Node Permission Model **尚不拦截出站网络**。逃逸代码仍可开 socket —— 但来自一个
**无文件系统访问、env 无密钥**的进程，本地无物可读、无密可泄，爆炸半径有界。
彻底封网络需 OS 级沙箱（seccomp / namespaces）或 isolated-vm，列为未来工作，不阻断本次闭环。

## 五、白皮书残留项更新

原 🔴 需人工介入条目（executeCode opt-in vm 逃逸）**降级为 ✅ 已解决**。
处置从「已默认禁用兜底」升级为「默认禁用 + 进程级权限沙箱真隔离，逃逸即无能力」。
