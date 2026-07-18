# [OPS-MAN-149] 编辑与探索读取工具接入统一读前防卡死前检

## 背景与缺口

OPS-147 建立了合成读前防卡死前检 `filePreReadHangGuard.classifyPreReadHang`,并接入两个次级读取工具(`inspectDocument` / `replaceAtLocation`)。系统盘点**所有会触碰字节的模型可调工具**后,仍有两个未接:

- `editFile.js`(别名 `edit_file` / `edit` / `replace`)—— 模型**最常用**的编辑工具。`execute()` 在 `existsSync` 后立刻 `const original = fs.readFileSync(absPath, 'utf-8')`(第 103 行),**零防卡死守卫**。模型把 `edit` 指向 FIFO / 设备节点 / `/proc·/sys` 阻塞项时永久卡死——与 OPS-147 修的 `replaceAtLocation` 同一形状(模型直供路径 + `existsSync` 后立即 `readFileSync`)。
- `exploreTool.js`(别名 `search_codebase` / `find_code` / `codebase_search`)—— 代码库探索工具。第 126 行的 `for` 循环遍历搜索命中的文件,第 134 行 `fs.readFileSync(absPath, 'utf8')` 逐个读取。若探索树里混入 FIFO / 阻塞伪文件,`readFileSync` 永久卡死;循环外层的 `catch` **只接抛错,不接卡死**。命中路径由工具自身的 glob/grep 产出(非模型直供),但目标机上项目目录含命名管道 / 套接字文件即触发。

## 修复(全 additive,复用 OPS-147 合成叶)

复用 `filePreReadHangGuard.classifyPreReadHang({absPath, stat, env})`(合成 Windows 保留设备名 + FIFO/套接字/设备 + `/proc·/sys` 阻塞伪文件三向量,各沿用族门 default-on,门关 byte-revert,绝不抛)。这正是「多个只需拒绝的读工具共用一个合成前检叶」的价值:新增消费者只加一次调用,零改动叶。

- `editFile.js`:`existsSync` 后、`readFileSync` 前,`fs.statSync` + `classifyPreReadHang`,命中即 `return { success:false, error, blockedRead:kind }`(与 replaceAtLocation 对称)。
- `exploreTool.js`:循环里**已有** `const stat = fs.statSync(absPath)`(第 129 行),在其后、`readFileSync` 前插 `classifyPreReadHang`(**复用已算好的 stat,零额外 IO**),命中即 `fileContents.push({ path, preview: '[skipped — <kind> would hang the reader]' })` 并 `continue`(跳过并留痕,与既有「跳过不可读文件」语义一致,而非硬失败整个探索)。

两处均 `try/catch` fail-soft,异常回退历史行为。

## 验证(全绿)

```
node --check editFile.js / exploreTool.js / filePreReadHangGuard.test.js   # OK
node --test tests/tools/filePreReadHangGuard.test.js                       # 16/16 pass
```

行为证据:

| 工具 | 目标 | 结果 | 耗时 |
|---|---|---|---|
| editFile.execute | FIFO(cwd 内) | success:false · blockedRead=special:fifo | 7ms |
| editFile.execute | 正常文本文件 | success:true · 内容正确改为 `hello khy` | — |

`exploreTool` 的端到端行为驱动在本机**无法完整跑通**:本环境 `require('glob')` 解析到**旧版 API**(`glob()` 返回 Glob 对象而非 `Promise<string[]>`),导致 `_runGlob` 的 `.slice()` 抛错被吞 → `files_found` 恒空 → 读循环不可达。这是**先存的、与本次改动正交的环境版本问题**(目标机 glob v9+ 正常)。故 `exploreTool` 由以下手段验证:① `node --check`;② 源级接线断言(守卫夹在既有 `statSync` 与 `readFileSync` 之间且命中 `continue`);③ 合成叶对 FIFO 的已证分类行为(叶测 16/16)。诚实上报,不假称跑过端到端。

门禁:

```
change-safety(我 5 文件 positional)   # no findings · exit0
check-leaf-contract / check-flag-registry / check-agent-rules   # passed(复用族门,无新门)
check:node-syntax                      # passed
wc -l   # editFile / exploreTool / filePreReadHangGuard.js / test —— 均 < 2500(arch:god)
maintainer:check                       # exit0(map 条目已扩 editFile/exploreTool + OPS-148)
维护映射表.json                        # JSON valid
```

## 教训

1. 防卡死向量要按「**哪些工具触碰字节**」**全量盘点**——`editFile` 是模型最常用的编辑工具,却与 `replaceAtLocation` 同形状漏接;系统枚举 `readFileSync|detectFile|createReadStream` 才能扫全。
2. `exploreTool` 的循环外 `catch` **只接抛错不接卡死**——`readFileSync` 卡死不抛异常,守卫必须**读前**拦截,`continue` 跳过并留痕。
3. 复用合成叶:新增消费者只加一次调用,`exploreTool` 复用循环里已算的 `stat`(零额外 IO)。
4. 端到端驱动跑不通时,**诚实甄别是环境问题(旧版 glob)还是本次缺陷**,并退回可跑的最强验证(源级接线 + 叶行为),不假称跑过。
5. `editFile` / `replaceAtLocation` 写路径限 cwd 内(traversal 检查先于本守卫),FIFO 行为测的临时管道须落 cwd 内。
6. 不 commit(feat/0.1.104);1.0.0 发布与真机手动门由用户执行。

## 补记 — `unpack`(流式读取)execute-chokepoint 防御平价

`grep -rlE "createReadStream" services/backend/src/tools/*.js` 只剩 `unpackTool.js` 一个流式读工具未接。
它经 `createReadStream → gunzip` 管道解包,对 FIFO/阻塞伪文件会**永久卡死**(实测直调 execute 卡死 = exit 124)。

**可达性诚实甄别:** `unpack` 的特殊文件防护此前**只在 `validateInput.isFile()`**。而框架
(`toolCalling.js:1912-1932`)只对 `source === 'registry'` 强制 `validateInput`;`builtin` 分支仅跑
schema 级 `validateParams`(无 `isFile`)。`unpack` 当前是 registry-only 且无直调 execute 的调用者,故
**当前 FIFO 不可达**(validateInput 在 0ms 拦下,且 `_withToolTimeout` 兜底 ~2min)。

**为何仍接:** 这是与 5 个同族读工具(readFile / FileReadTool / inspectDocument / editFile /
exploreTool / replaceAtLocation)一致的**防御平价** —— 它们的守卫都落在 **execute 体内**(source-无关),
唯 `unpack` 的防护是 source-dependent。把 `classifyPreReadHang` 接进 `unpack.execute()` chokepoint,
使其对未来 builtin 暴露 / 直调 execute 亦稳,并把「~2min 超时才结束的卡死」变为「1ms 干净拒绝」。全 additive、
复用现有合成叶与族门(**无新门**)、族门关 `KHY_READFILE_SPECIAL_GUARD=0` → byte-revert(实测关门后重新卡死 = 证明改动即守卫本身)。

验证:`node --test services/backend/tests/tools/filePreReadHangGuard.test.js` **19/19 绿**
(新增:源级接线断言 + execute 直调 FIFO 拒绝 `special:fifo` + 正常 `.gz` 往返非回归)。

**教训补充:** ①「已被 validateInput 挡住」不等于「防御到位」——框架的 validateInput 强制是
**source-dependent**,守卫应落在 execute chokepoint 才 source-无关;②源级 token-index 排序断言不可靠——
`validateInput` 与 `execute` 共享同名 helper token(`_detectFormat`/`createReadStream`),须用**行为测**
(直调 execute FIFO 拒绝)证运行期顺序;③可达性分析要诚实上报「当前不可达但防御不一致」,不夸大为「修复卡死漏洞」。
