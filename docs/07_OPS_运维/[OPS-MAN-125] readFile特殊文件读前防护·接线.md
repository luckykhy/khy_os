# [OPS-MAN-125] readFile 特殊文件（FIFO/套接字/设备）读前防护 · 接线（让 khy 不再因读到会阻塞的非常规文件而永久卡死）

> 本文件为手写维护文档（此层是工具接线，无 `--gen-doc` 生成器）。承接 OPS-MAN-121 / OPS-MAN-123。
> 判定逻辑改在 `services/backend/src/tools/specialFileReadGuard.js`（纯叶·零 IO·绝不抛），
> 接线改在 `services/backend/src/tools/readFile.js` 的 `execute`。

## 这一层闭合什么：按「文件类型」拦下会永久阻塞的读

OPS-121 给读工具接了「二进制读前拒绝」，OPS-123 又把二进制路由到已存在的提取器。但仍有
一类**会让进程永久卡死**的目标从所有守卫下溜过去：**非常规文件**——命名管道（FIFO）、
UNIX 域套接字、字符设备（如 `/dev/random`）、块设备。

它们的共同特征让每一道既有守卫都失效：
- `stat.size === 0`（或无意义）→ 溜过 OPS-121 之后的「超限」检查；
- 不是二进制格式，而 `detectFile()` 为判格式会去**读 magic 字节**——**读 FIFO 的第一个
  字节就会阻塞等待写端**，于是二进制守卫不但拦不住，`detectFile` 自己先卡死；
- 随后 `readTextFileSmart` 打开并读取，在无写端的 FIFO / 阻塞设备上**永久挂起**。

已复现：`mkfifo /tmp/hangfifo` 后经 `readFile.execute` 读它，6s 超时仍未返回（EXIT=124）。
接线后同一 FIFO **4ms 返回** `success:false`。

`inputValidators.validateNotDevicePath` 只是一张**路径精确名单**（`/dev/zero`、`/dev/stdin`…），
无法按类型拦下任意位置的 FIFO / 套接字 / 自建设备节点 = 典型「守卫存在但覆盖不全 / 能力
没接线」。本层按 **`fs.statSync` 返回的类型**拦下。

## 为什么可以安全地在读之前判定

关键事实：`fs.statSync` 对 FIFO / 设备**只读元数据、瞬时返回、绝不阻塞**（已实测 0ms 返回，
`isFIFO()=true`）。`readFile.execute` 早已算好 `stat`（用于 size / isDirectory），本层只消费它的
类型谓词（`isFIFO/isSocket/isCharacterDevice/isBlockDevice`），**零额外 IO**，且发生在任何会
阻塞的 `open/read`（detectFile / readTextFileSmart）之前。

## 修法：isDirectory 特判之后、detectFile / 二进制守卫之前插入类型拦截

`readFile.execute` 在 `if (stat.isDirectory())` 之后：

```js
try {
  const { specialReadGuardEnabled, classifySpecialFile, buildSpecialFileRefusal } = require('./specialFileReadGuard');
  if (specialReadGuardEnabled(process.env)) {
    const _kind = classifySpecialFile(stat);      // 'fifo'|'socket'|'char-device'|'block-device'|null
    if (_kind) {
      return { success:false, error: buildSpecialFileRefusal({ kind:_kind, path:filePath, size:stat.size }),
               specialFile:_kind, size:stat.size };
    }
  }
} catch { /* 判定失败 → 回退历史读取行为 */ }
```

`classifySpecialFile(stat)` 只认明确的 FIFO/套接字/字符设备/块设备；常规文件、目录、
stat 缺失 / 非对象 / 谓词非函数或抛错 → 一律 `null`（放行），绝不误伤常规文件。目录由
readFile 既有的 isDirectory 特判处理，本叶对目录返回 null（不接管）。

## 三层守卫顺序（都在内容读取之前，逐层放行到下一层）

1. **目录**（fsReadErrorGuard.directoryReadMessage，KHY_FS_ERROR_HUMANIZE）。
2. **特殊文件**（本层，KHY_READFILE_SPECIAL_GUARD，default-on）：FIFO/套接字/设备 → 快速拒绝，
   **绝不卡死**。
3. **二进制/格式路由**（OPS-123 KHY_READFILE_FORMAT_ROUTE → OPS-121 KHY_READFILE_BINARY_GUARD）。
4. 常规文本 → 有界窗口读取 + 分页提示。

## 门控 / fail-soft

- 门 `KHY_READFILE_SPECIAL_GUARD`（默认开；env ∈ {0,false,off,no} 归一后关）。关 → 逐字节
  回退历史行为（对特殊文件照旧走 detectFile/解码 → 卡死），本防护完全旁路。
- 纯叶 `classifySpecialFile` / `buildSpecialFileRefusal` 零 IO、绝不抛；任一步抛错 → readFile
  的 try/catch 跳过，回退历史读取路径。

## 恒久红线

- 只按 stat 类型判定，不碰任何密钥；无重 IO（复用 readFile 已算好的 stat）。
- 真 key/token 永不进包、不落盘；pip `khy-os` 与 npm `@khy-os/khy-os` 版本必须一致。

## 验证

```bash
npm run test:readfile-special-guard     # 纯叶单测(15 用例)
npm run test:readfile-binary-guard      # OPS-121 无回归
npm run test:readfile-format-route      # OPS-123 无回归
# LIVE(带 timeout 防自身卡死):
#   真 mkfifo → readFile.execute 4ms 返回 success:false(不再 6s+ 卡死);
#   KHY_READFILE_SPECIAL_GUARD=0 + 同 FIFO → 回退历史行为(会卡死,timeout 佐证);
#   常规文本文件 → 不受影响,照常读出。
```
