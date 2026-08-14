# [OPS-MAN-133] restore 跨 OS 路径可移植性 · 解包前把关（让 khy restore 事前诚实告知「这批路径在你这台 Windows / macOS 上会缺文件 / 改名」）

> 本文件为手写维护文档（此层是运行时接线，无 `--gen-doc` 生成器）。承接还原诊断族
> OPS-MAN-119（解密前预检 `restorePreflightCheck`）、OPS-MAN-128（解密后归档形制
> `restoreArchiveExtractCheck`）、OPS-MAN-130（成功横幅来源可溯性 `restoreProvenanceCheck`）。
> 判定叶：`services/backend/src/services/restorePathPortabilityCheck.js`（bundled 纯叶·零 IO·绝不抛）。
> 接线：`services/backend/src/cli/handlers/publish.js` 的 `_restoreFromSnapshot`（解包前枚举）
> 与 `handleRestore`（诚实横幅）。

## 这一层闭合什么：snapshot 是 path-blind，跨 OS 还原会「悄悄少文件」却只事后猜

`makeSourceSnapshot` 把源码树打成一团 tar.gz，条目名是在 **Linux** 上铸的——Linux 文件系统
几乎什么名字都收。这团归档随 pip / npm 发到**陌生机器与陌生系统**。运行时 `handleRestore`
解密 + 校 sha256 后，直接把 `tar -xzf` 写死盲解包，**从不预先看归档里的条目名到底能不能在
目标文件系统落地**。

换到 **Windows / macOS** 还原时，同一批 Linux-valid 的名字里有相当一部分会**静默失败或改写**：

| 危害类别 | 例子 | 在目标系统上的后果 |
|---|---|---|
| `reserved`（Windows 保留设备名） | `aux.js` · `com1.txt` · `NUL` | Windows 上**根本建不出来** |
| `illegalChar`（非法字符 `< > : " \| ? *` + 0x00-0x1F） | `a:b.js` · `p*.md` | 含这些字符的条目**解不出来** |
| `trailingDotSpace`（段结尾点 / 空格） | `foo.` · `bar ` | Windows **静默剥掉** → 改名 / 撞名 |
| `tooLong`（全路径 > 259 = MAX_PATH） | 深层长路径 | 旧式 API 下**超长条目被跳过** |
| `caseCollision`（大小写不敏感碰撞） | `Foo.js` vs `foo.js` | NTFS / APFS 默认卷上**后者覆盖前者** |

结果：落地文件比归档里**少**。而运行时对此**一无所知**——唯一的跨 OS 信号是 completeness
对账（OPS-116/117）**事后**发现「文件数少了」时，才打一句泛泛的反应式提示
（"可能路径过长(Windows MAX_PATH) / tar 跳过条目…"，`publish.js:877` 附近）。那是**事后猜测**：
既不知道**是哪些**路径出问题，也不知道**为什么**。

`grep` 归档条目名在解包**前**的消费者 = 零。运行时从来没有一个**解包前**的路径可移植性
预扫描器（断桥）。

## 离机场景为什么最毒

这台云电脑过期，pip / npm 是唯二的离机渠道，源码只能靠还原到**别人的机器与系统**上复活。
Linux 开发者随手建的 `Foo.js` / `foo.js` 并存、或某个含冒号的临时文件名，在本机毫无问题；
可一旦被打进快照发到 Windows 维护者的机器上还原：

- 大小写碰撞的两个文件**只落一个**，另一个被无声覆盖；
- 保留名 / 非法字符条目**根本没解出来**；
- 维护者只看到「还原完成」的横幅 + 事后一句「文件数好像少了，可能路径过长」——
  **不知道是哪几条、也不知道为什么**，无从排查。

诚实的还原应该在**动手解包之前**就指名道姓地说清楚：「这几条路径在你这台 Windows / macOS 上
不会原样落地」。

## 这一层怎么做（全 additive · 门 default-on · 有界枚举永不卡死）

### 判定叶（bundled 纯叶·零 IO·绝不抛）

`restorePathPortabilityCheck.js` 只做**纯字符串分类**，绝不碰任何密钥：

- `assessPathPortability(entryNames, opts)` —— 逐条把归档条目名按上表五类危害分类，
  桶里放**惹祸的原始名字**（每桶截断到 `_BUCKET_CAP=50`，防超大归档撑爆裁决对象）。
  `ok===true` **仅当**五桶全空——即这批名字在 Windows / macOS 上也能原样落地。
- `buildPortabilityBannerLine(verdict, opts)` —— **按宿主系统**把裁决翻成一行横幅
  （host-aware，因为「会不会真犯事」取决于**你正在哪台机器上还原**）：
  - `win32` → 五类全是真实解包失败 → `severity:'warn'`。
  - `darwin` → `caseCollision` 是默认卷上真实覆盖 → `warn`；其余 Windows 专属危害 → `info`。
  - `linux` 等 → 本机能原样落地，但换到 Windows / macOS 会出问题 → 有危害则 `info`
    （跨 OS 前瞻提醒），无危害则 `null`（不打行，横幅字节等价旧行为）。
  - 例名截断到前 3 条，超出附 ` …`。严重度路由（printWarn vs printInfo）留给 `publish.js`。

### 接线 `publish.js`

- 门 `KHY_RESTORE_PATH_PORTABILITY`（default-on；env ∈ {0,false,off,no} → 关 = 逐字节回退
  直入 `tar -xzf`，无枚举开销）。内联读门，**不进 flagRegistry**（同 `KHY_MEMORY_NOTICE` 先例）。
- 宿主覆盖 `KHY_RESTORE_PLATFORM_OVERRIDE`（默认 `process.platform`）——让单机也能演练
  win32 / darwin 分支做测试。
- IO 助手 `_listTarGzEntries(tarGzBuffer)` 落在 `publish.js`（已有 handler，保叶纯净）：
  临时落盘密文的解密结果后 `spawnSync('tar', ['-tzf', tmp], { timeout: 20000, ... })`
  **只列条目不解包**，解析 stdout、剥前导 `./` 与结尾 `/`，**fail-soft → null**（tar 缺失 /
  超时 / 非零退出 / 畸形 → 直接放行，字节等价旧行为），`finally` 清理临时文件。
- 在 `_restoreFromSnapshot` 里 `mkdirSync(dest)` **之后**、`_extractTarGz(plaintext, dest)`
  **之前**枚举 + 评估，把 `pathPortability` 裁决塞进返回值。
- 在 `handleRestore` 的 provenance 横幅块**之后**、`docInDest` 之前，用
  `buildPortabilityBannerLine(result.pathPortability, { hostPlatform: _restoreHostPlatform() })`
  渲染：`severity==='warn'` → printWarn，否则 printInfo。**纯诊断**，绝不 `_markFailure`，
  门控 + try/catch fail-soft。

## 和已接线的还原诊断族正交（别混淆）

四层读的是**不同的东西**，字段集不重叠：

| 层 | 时机 | 读什么 | 问的问题 |
|---|---|---|---|
| `restorePreflightCheck`（OPS-119） | 解密**前** | 外层信封 format + 加密套件 | 本机解不解得开密文 |
| `restoreArchiveExtractCheck`（OPS-128） | 解密后、解包**前** | 内层归档 plaintextFormat/layout | 本机 tar 认不认识这团归档 |
| **本层（OPS-133）** | 解密后、解包**前** | 归档**条目名** vs 本机命名规则 | 每个名字能不能在本机落地 |
| `restoreCompletenessCheck`（OPS-116/117） | 解包**后** | 磁盘落地文件数 vs fileCount | 数量对不对 |

本层是 completeness 的**前置主动版**：completeness 事后发现「少了」，本层事前说清「会少哪些、
为什么」。

## 恒久红线（继承还原家族）

- **只披露不阻拦**：本层**绝不改变还原成败、绝不 markFailure**——超长 / 保留名 / 碰撞是
  **目标系统**的命名限制，不是这团归档坏了；在 Linux 上还原它照样完整。本层只把
  「悄悄少文件」变成「事前诚实告知」。
- **只读条目名字符串，绝不碰任何密钥**：入参是解密后归档的**文件名**，本层只做字符串分类，
  裁决对象里不含任何密文 / 密钥 / 文件内容（单测断言裁决 JSON 无 secret/key/token/cipher）。
- **有界枚举永不卡死**：`tar -tzf` 只列不解、带 20s 超时；任何异常 fail-soft 回退直入解包。
- **纯计算、零 IO、无时钟、无随机、绝不抛**：任何入参缺失 / 非法 → 保守（total:0, ok:true, 空桶）。

## 验证

```
node --check services/backend/src/services/restorePathPortabilityCheck.js
node --check services/backend/src/cli/handlers/publish.js
npm run test:restore-path-portability          # 纯叶单测 25/25 全绿
npm run test:maintainer:safety                 # 聚合无回归
npm run arch:god                               # 改动文件不得新增超限
```

**LIVE 真还原证据**（真 `sourceSnapshotCrypto.encrypt` AES-256-GCM + 真 `tar -czf` 驱动真实
`handleRestore([], { from, into, force })`，劫持 `process.stdout.write` 断言横幅，
`KHY_RESTORE_PLATFORM_OVERRIDE` 在单台 Linux 上证 win32 / darwin 分支）：

- 含 `Foo.js`/`foo.js`/`aux.js`/`a:b.js` 的快照，override=win32 → 横幅 `severity:warn`
  指名道姓列出危害条目；**文件仍在 Linux 上完整落地**（不阻拦）。
- override=darwin → 仅碰撞 warn、其余 info。
- override=linux（无危害快照）→ 无横幅行（字节等价旧行为）。
- 门 `KHY_RESTORE_PATH_PORTABILITY=0` → 直入 `tar -xzf`，无枚举、无横幅行（字节等价）。

## HOW-TO-EXTEND（抄写式）

新增一类跨 OS 命名危害时：① 在 `HAZARD_KINDS` 登记它的 key；② 在 `_classifyEntry` 里加一条
纯字符串判定，命中就 push 进对应桶；③ 若它在某个宿主系统上是**真实失败**（不只是提醒），
在 `buildPortabilityBannerLine` 的 host 分支里把它列进该 host 的 warn 级集合。`ok` 的定义
只有一个出口（五桶皆空）——别在别处放行。保留名 / 非法字符集若要扩充，改 `RESERVED_NAMES` /
`ILLEGAL_CHARS_RE` 一处即可。
