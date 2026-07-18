# [OPS-MAN-147] 次级读取工具统一读前防卡死前检

## 背景与缺口

防卡死读守卫族此前只覆盖两条**主**读路径:

- `readFile.js`(OPS-121 二进制内容 / OPS-123 格式路由 / OPS-125 特殊文件 FIFO·套接字·设备 / OPS-129 伪文件有界读)。
- `FileReadTool`(模型主调的 `Read`,OPS-146 补齐 parity)。

但**次级**读取工具同样面向模型、同样触碰字节,却**零防卡死守卫**:

- `inspectDocument.js`(别名 `read_format` / `inspect_format` / `doc_format`):`execute()` 在 `existsSync` 后立刻 `detectFile(absPath)`(读 magic bytes → 对 FIFO / 阻塞伪文件**永久卡死**),随后 `fs.readFileSync(absPath,'utf-8')` 也会阻塞。
- `replaceAtLocation.js`(别名 `replace_at`):同样 `detectFile(absPath)` 后 `fs.readFileSync(absPath,'utf-8')`,同一卡死暴露。

即:把 khy 指向含 FIFO / 设备节点 / `/proc·/sys` 阻塞项的目录,再用这两个工具就会永久卡死——正是 /goal「不要再次因为阅读工具不对不支持，长时间卡死」诉求的残余缺口。

## 修复(全 additive)

新增**合成纯叶** `services/backend/src/tools/filePreReadHangGuard.js`,导出 `classifyPreReadHang({absPath, stat, env})`,把三条会**永久卡死**的读前向量合成单一调用:

1. **Windows 保留设备名**(CON/PRN/AUX/NUL/COM1-9/LPT1-9、`\\.\…`)—— 纯路径判定,无需 stat。委派 `winDeviceReadGuard`。
2. **特殊文件**(FIFO / 套接字 / 字符或块设备)—— 用已算好的 `stat` 类型谓词(`statSync` 对设备只读元数据,不阻塞)。委派 `specialFileReadGuard`。
3. **阻塞伪文件**(Linux `/proc·/sys`)—— 路径 + stat 谓词检测。委派 `pseudoFileReadGuard.shouldBoundedRead`;本合成器面向「只需拒绝」的工具,故**检测即拒绝**(不做有界读回内容,与 `readFile.js` 的有界读路径分工)。

每条向量各自沿用其族门(default-on):门关 → 该向量返 `null`(逐字节回退历史行为)。纯判定、零副作用、**绝不抛**。返回 `null`(安全)或 `{ blocked:true, kind, error }`。

**接线**(两处对称,均在 `detectFile` / `readFileSync` 触碰字节之前):

- `inspectDocument.js`:`existsSync` 后、`detectFile(absPath)` 前,`fs.statSync` + `classifyPreReadHang`,命中即 `return { success:false, error, blockedRead:kind }`。
- `replaceAtLocation.js`:同一插入点(`existsSync` 后、`detectFile` 前)。

`try/catch` 包裹,任何异常回退历史行为(fail-soft)。

### 设计边界

`readFile.js` / `FileReadTool` **不**改用本合成器:它们有更细的读路径(pseudo 走**有界读**取回内容、binary 走**格式路由**),保留各自读专用内联守卫。本合成器只服务「命中即拒绝、不需读回内容」的次级读类工具。

## 验证(全绿)

```
node --check filePreReadHangGuard.js / inspectDocument.js / replaceAtLocation.js   # OK
node --test tests/tools/filePreReadHangGuard.test.js                              # 12/12 pass
```

LIVE 防卡死冒烟(经真实 execute 路径):

| 工具 | 目标 | 结果 | 耗时 |
|---|---|---|---|
| inspectDocument.execute | FIFO | success:false · blockedRead=special:fifo | 3ms |
| replaceAtLocation.execute | FIFO | success:false · blockedRead=special:fifo | 3ms |
| inspectDocument.execute | /proc/self/status | success:false · blockedRead=pseudo:proc | 0ms |
| inspectDocument.execute | 普通文本文件 | 正常通过(不误伤) | — |

(修复前这些目标会永久卡死。)

门禁:

```
change-safety(我 4 文件 positional)   # no findings · exit0
check-leaf-contract filePreReadHangGuard.js   # passed
check-flag-registry                    # passed(复用既有族门,无新门)
check-agent-rules(我 4 文件)           # passed
check:node-syntax                      # 4354 files · passed
wc -l   # 叶 74 / inspect 224 / replace 144 / test 138  —— 均 < 2500(arch:god)
maintainer:check                       # exit0(已登记 file-preread-hang-guard 条目)
维护映射表.json                        # JSON valid
```

## 教训

1. 防卡死向量要按「**哪些工具触碰字节**」全量盘点——主读路径(readFile / FileReadTool)修好后,次级读工具(inspectDocument / replaceAtLocation)是同一缺口的残余面。
2. `detectFile` 读 magic bytes,本身就会对 FIFO / 阻塞伪文件卡死——守卫**必须**在 `detectFile` 之前。
3. 多个「只需拒绝」的读工具应共用一个**合成前检叶**,而非各自复制三段守卫:新增向量时只改叶,调用方零改动。
4. `replaceAtLocation` 的写路径限定在 cwd 内(traversal 检查先于本守卫),故其 FIFO 行为测的临时管道须落 cwd 内。
5. 不 commit(feat/0.1.104);1.0.0 发布与真机手动门由用户执行。
