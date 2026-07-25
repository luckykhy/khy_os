# [DESIGN-ARCH-054] AI 逆向工程 —— 从产物还原与自验软件

> 状态：已实现（确定性核心 + 模型增益 + 自验闭环）
> 子系统：`services/backend/src/services/reverseEngineer/`
> 工具：`reverse_engineer`（`services/backend/src/tools/reverseEngineer.js`）
> 测试：`services/backend/tests/services/reverseEngineer/reverseEngineer.test.js`（36 例绿）

## 1. 背景与目标

打包后常常只剩一个 `exe`/`dll`/`so`/`jar`/`wasm`，源码丢失或不在手边。诉求是让 Khy-OS 具备
**AI 逆向分析、还原软件结构**的能力，从而 **khy 自己生成的软件也能由 khy 更好地验证**。

目标拆成两层：
1. **还原/分析**：从编译产物尽可能取回源码或重建高层结构（语言、工具链、模块、入口、伪源码）。
2. **自验**：当产物由 khy 构建（有构建清单）时，逆向还原的结构能与清单比对，给出**保真度评分**，
   形成「构建 → 产物 → 逆向 → 比对」的闭环。

## 2. 设计原则（与全局工程铁律一致）

- **只读、绝不执行被分析的制品**（防呆①）。逆向永远只读字节，不运行不可信二进制。
- **确定性优先、模型增益**：分诊/字符串/源码还原/比对全部确定性、零模型；模型只在最后做
  「证据 → 结构」的推断，且**无模型也能跑**（退化为证据报告）。
- **证据 ≠ 推断**（防呆①续）：报告里确定性证据与模型推断严格分离，模型产物标 `source:'model'`
  且带 `confidence`，绝不把猜测混进事实。
- **外部工具不存在就如实说**（防呆②）：反编译器一律运行时探活，没有就给安装提示并降级，
  **绝不伪造反汇编/反编译输出**。
- **零硬编码、单一真源**：格式签名集中在 `formatRegistry`，工具计划集中在 `toolOrchestrator.PLANS`。
- **沙箱安全**：解包复用 unpackTool 同源护栏（路径穿越/绝对路径/盘符/总量上限）（防呆④）；
  外部工具一律 `execFile`（无 shell）+ 超时 + 输出上限，制品路径作参数注入而非拼命令行（防呆⑤）。
- **授权语义**：逆向定位为「自验自有/受权软件」（防呆⑥）。未提供构建清单且未显式 `authorized`
  时，仅做只读分诊与字符串归纳，不驱动反编译与源码还原。
- **fail-soft**：任一阶段失败只降级该段证据，绝不冒泡使整条流水线崩溃；门面 `analyze` 永不抛。

## 3. 模块（7 纯模块 + 1 门面）

### 3.1 `formatRegistry.js` —— 制品格式单一真源
声明式表：魔数签名（偏移+字节）、家族、**可还原档位**（SOURCE/BYTECODE/NATIVE/ARCHIVE）、
候选外部工具、还原策略提示。另有 `EMBEDDED_MARKERS`（.NET/PyInstaller/Node SEA/pkg/nexe/Go/Rust）
用内嵌特征二次升级档位。数据与匹配逻辑分离（匹配在 scanner）。

### 3.2 `artifactScanner.js` —— 只读分诊
读头部签名 + 头/尾窗口标记，输出格式/家族/档位/架构/大小/SHA-256/命中标记。处理 `cafebabe`
撞号消歧（Java class ↔ macOS fat Mach-O，用 major 版本字节判定）。畸形/不可读降级为 `unknown`，永不抛。

### 3.3 `stringHarvester.js` —— 字符串证据
提取 ASCII + UTF-16LE 可打印串（带偏移），按 URL/路径/版本/邮箱/密钥分类，并匹配工具链指纹
（gcc/clang/msvc/rustc/go/python/node/dotnet/electron/upx）。纯确定性，信息密度最高的免费证据。

### 3.4 `sourceRecoverer.js` —— 自包含产物还原（SOURCE 档主路径）
ZIP 家族（jar/whl/nupkg/apk/asar-zip）安全解包并编目成员（source/bytecode/asset）；脚本直接登记；
PyInstaller/Node 自包含产物**诚实交棒**给 toolOrchestrator（不重写易错的 CArchive 解析器）。
默认仅编目（listOnly），给出 `outDir` 才落盘抽取。

### 3.5 `toolOrchestrator.js` —— 外部反编译/反汇编编排
`PLANS`：family → 候选工具链（objdump/nm/readelf/radare2/otool/ilspycmd/jadx/javap/wasm2wat/
decompyle3…）。`probe` 探活，`orchestrate` 选最高优先级可用工具执行（execFile+超时+输出上限），
无工具则给安装提示并降级。绝不伪造输出。

### 3.6 `reconstructionPort.js` —— 证据 → 结构化重建
注入式 `brain`：把证据包交模型推断语言/工具链/模块/入口/伪源码/置信度/caveats。无模型/超时/
非 JSON 一律降级为确定性证据报告（基于指纹的保守语言推断）。模型产物归一化 + `confidence` 钳制。

### 3.7 `verificationLedger.js` —— 保真度自验
`buildManifest` 记录构建清单（源文件 sha256 + 入口 + 工具链 + 产物 sha256）；`verify` 比对还原
成员 vs 清单：产物哈希同一性（占 50%）+ 源覆盖率（占 50%）→ `fidelity` 评分与 `verdict`
（verified/partial/mismatch）。无清单 → `no-baseline`，不阻断。

### 3.8 `index.js` —— 门面
`analyze(artifactPath, opts)` 串联 ①分诊 → 授权判定（显式或清单存在）→ ②字符串 →（授权后）
③还原 → ④编排 → ⑤重建 → ⑥自验，产出结构化 `ReconstructionReport`。永不抛。

## 4. 工具契约 `reverse_engineer`

| 入参 | 说明 |
|---|---|
| `path` (必填) | 产物路径 |
| `authorized` | 断言拥有/受权（启用源码还原 + 反编译编排）；发现构建清单时自动 true |
| `runTools` | 是否真正执行外部反编译器（默认 false，仅探活） |
| `outDir` | 提供则把可还原成员沙箱抽取到此目录 |
| `manifestPath` | 指定构建清单（默认产物同目录 `.khy-build-manifest.json`） |
| `maxTools` | runTools 时每 family 执行的工具上限（默认 2） |

`isReadOnly:true`、`category:execution`、`risk:medium`。返回 `{success, data: ReconstructionReport}`。

## 5. 验证

`node --test tests/services/reverseEngineer/reverseEngineer.test.js` → 36 例绿，覆盖：格式识别与
`cafebabe` 消歧、嵌入标记升级档位、字符串/指纹分类、ZIP 安全解包与抽取、路径穿越拒绝、外部工具
缺失诚实降级、模型 JSON 解析/超时/非 JSON 三路降级、清单比对四种判决、门面端到端（未授权仅分诊 /
授权 ZIP 还原 / 清单旁置自动授权 verified / 产物缺失 no-artifact）。合成产物逐字节构造，全程 hermetic。

## 6. 后续增强（未接线，留后续 PR）

- PyInstaller CArchive / Node SEA 的内置纯 JS 抽取器（当前交外部工具）。
- 把 agent 主循环的模型作为 `brain` 注入 reconstructionPort，实现工具内深度重建（当前由调用方
  模型读证据包自行重建）。
- khy 构建命令（`khy build` / `deploy` / `compile`）在产出产物时自动写 `.khy-build-manifest.json`，
  让自验默认开箱即用。
