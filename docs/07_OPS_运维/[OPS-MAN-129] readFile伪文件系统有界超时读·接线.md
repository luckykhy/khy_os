# [OPS-MAN-129] readFile 伪文件系统（/proc·/sys）有界超时读 · 接线（让 khy 不再因读到会阻塞的 /proc 伪文件而永久卡死）

> 本文件为手写维护文档（此层是工具接线，无 `--gen-doc` 生成器）。承接 OPS-MAN-121 / OPS-MAN-123 / OPS-MAN-125。
> 判定 + 有界读改在 `services/backend/src/tools/pseudoFileReadGuard.js`（纯叶·绝不抛），
> 接线改在 `services/backend/src/tools/readFile.js` 的 `execute`。

## 这一层闭合什么：按「文件位置」拦下会永久阻塞的**常规**伪文件（第四条卡死向量）

读工具此前有三道卡死守卫，各按「文件的某个属性」拦：

| OPS | 守卫 | 拦的键 |
|---|---|---|
| 121 | readBinaryGuard | **二进制内容** → 拒绝 |
| 123 | readFileFormatRouter | **格式**（pdf/图片/压缩包/docx）→ 路由到有界提取器 |
| 125 | specialFileReadGuard | **文件类型**（FIFO/套接字/字符或块设备）→ 快速拒绝 |

但仍有一类**会让进程永久卡死**的目标从这三道下溜过去：**Linux 伪文件系统 `/proc`·`/sys`
下的条目**。它们是**常规文件**（`stat.isFile() === true`）、`stat.size === 0`、内容在读时由
内核**现生成**——其中一部分（`/proc/kmsg`、某些 `/sys` poll 属性等）**读第一个字节就永久阻塞**。

它们让每一道既有守卫都失效：

- 是常规文件 → 溜过 OPS-125 的**类型谓词**（`isFIFO/isSocket/isCharacterDevice/isBlockDevice`
  全 `false`）；
- `size === 0` → 溜过 OPS-121 之后的「超限」检查（`0 > maxBytes` 恒 `false`）；
- 多非二进制 → `detectFile()` 为判格式会去**读 magic 字节**，恰在此处对阻塞伪文件卡死，
  连二进制守卫自己都先挂住。

已实测：`/proc/cpuinfo` 就是 `size === 0` 的常规文件，四个特殊文件谓词全 `false`——即它是
OPS-121/123/125 三道守卫都放行、却会被 `detectFile` 读 magic 字节卡住的隐蔽目标。

## 为什么不「一律拒绝」，而是「有界读」（承 OPS-123 教训）

OPS-123 的教训：**拒绝不是终态**——能读的要真读出来。`/proc`·`/sys` 下**大多数**伪文件是
**有限**的（`cpuinfo`、`uptime`、`self/status`…），秒读即得可用内容；只有**少数**会阻塞。
所以本层不「拒绝伪文件」，而是「用有界方式读伪文件」：有内容 → 返回文本；到点仍阻塞 →
才返回信息性拒绝。

## 关键架构点：同步阻塞读无法在进程内超时 → 必须搬进可被杀的子进程

这是 OPS-125 的血泪延伸：`fs.readFileSync` / `readTextFileSmart` 是**同步**读，一旦卡在阻塞
`read()` 上就**锁死事件循环**，进程内 `Promise.race` / `setTimeout` **永不触发**——在同一进程里
无论如何都无法给同步阻塞读加超时。

唯一同步安全的解法：把阻塞读**搬进子进程**，用 `spawnSync` 的 `timeout` 选项杀掉它。子进程
`head -c <maxBytes> <path>` 阻塞在 `read()` 上 → 到点收 `SIGTERM` 而死，父进程在 timeout 处
返回 `error.code === 'ETIMEDOUT'`。

- **有限伪文件**（`/proc/cpuinfo`）：`head` 读满退出 0 → 返回内容；
- **阻塞伪文件**（`/proc/kmsg`，root 可读时）：`head` 卡住 → 到点被杀 → 有界返回，**绝不无限挂起**。

已实测：真 `spawnSync('head', ['-c', N, path], {timeout:1500})` 对无写端 FIFO（真实阻塞源，
等价于阻塞 `/proc` 文件）**在 1502ms 处被杀**（`timedOut:true`），而非卡死。

## 修法：特殊文件守卫之后、detectFile / 二进制守卫之前插入有界读

`readFile.execute` 在 OPS-125 特殊文件守卫的 `catch` 之后：

```js
try {
  const { shouldBoundedRead, readPseudoFileBounded } = require('./pseudoFileReadGuard');
  const _pkind = shouldBoundedRead({ absPath: filePath, stat, env: process.env }); // 'proc'|'sys'|null
  if (_pkind) {
    const routed = readPseudoFileBounded({ filePath, kind: _pkind, env: process.env });
    if (routed && routed.handled) return routed.result;  // 有界读到内容 / 超时拒绝 → 直接返回
  }
} catch { /* 判定/有界读失败 → 回退历史读取行为 */ }
```

`shouldBoundedRead` 仅当**全部**成立才返回 kind：门开 + 平台 linux + `stat.isFile()` +
`stat.size === 0` + 路径落在 `/proc/` 或 `/sys/` 挂载下。其中 `isPseudoFsPath` 精确匹配
`/proc`、`/proc/...`、`/sys`、`/sys/...`——工程目录里名为 `proc`/`sys` 的子目录（如
`/home/x/proc/y`）、前缀陷阱（`/procession`）**不**匹配；非 linux 平台恒 `null`。**零误伤常规文件**。

`readPseudoFileBounded` 返回：
- 子进程退出 0 且有内容 → `{handled:true, result:{success:true, content:'【/proc 伪文件 · 有界读】\n…', format:'pseudo-fs-proc', extractedBy:'bounded-read', size, truncated}}`；
- 超时 / 被信号杀 → `{handled:true, result:{success:false, error:超时拒绝消息, pseudoFile, timedOut:true}}`；
- `head` 不存在（ENOENT）/ status≠0 / 空入参 / 抛错 → `{handled:false}`（调用方回退历史读取路径）。

## 四层守卫顺序（都在内容读取之前，逐层放行到下一层）

1. **目录**（fsReadErrorGuard.directoryReadMessage，KHY_FS_ERROR_HUMANIZE）。
2. **特殊文件**（OPS-125 KHY_READFILE_SPECIAL_GUARD）：FIFO/套接字/设备 → 快速拒绝。
3. **伪文件系统**（本层 KHY_READFILE_PSEUDO_GUARD，default-on）：`/proc`·`/sys` 常规伪文件 →
   有界子进程读，**绝不卡死**。
4. **二进制/格式路由**（OPS-123 → OPS-121）。
5. 常规文本 → 有界窗口读取 + 分页提示。

## 门控 / fail-soft

- 门 `KHY_READFILE_PSEUDO_GUARD`（默认开；env ∈ {0,false,off,no} 归一后关）。关 → 逐字节
  回退历史行为（对阻塞伪文件照旧走 detectFile/解码 → 卡死），本防护完全旁路（LIVE 已验：
  `/proc/cpuinfo` GUARD-OFF → `format=undefined size=0` 走旧解码路径）。
- 纯叶各函数绝不抛；任一步抛错 → readFile 的 try/catch 跳过，回退历史读取路径。

## 恒久红线

- 只读伪文件内容（有界），不碰任何密钥；有界子进程 `head` 只读、无副作用。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

## 验证

```bash
npm run test:readfile-pseudo-guard      # 纯叶 DI 单测(27 用例)
npm run test:readfile-special-guard     # OPS-125 无回归
npm run test:readfile-binary-guard      # OPS-121 无回归
npm run test:readfile-format-route      # OPS-123 无回归
# LIVE(经真 readFile.execute + 真 spawnSync，带 timeout 防自身卡死):
#   真 /proc/cpuinfo GUARD-ON → success:true format=pseudo-fs-proc 33ms(有界读出真内容);
#   /proc/uptime、/proc/self/status → 同样秒读出;
#   KHY_READFILE_PSEUDO_GUARD=0 + /proc/cpuinfo → format=undefined 走旧解码路径(字节等价回退);
#   真无写端 FIFO(阻塞源) + 真 spawnSync timeout=1500 → 1502ms 被杀 timedOut:true(不卡死);
#   /proc/kmsg(root-only) 非 root → EACCES 快速 handled:false(2ms,不卡死)。
```
