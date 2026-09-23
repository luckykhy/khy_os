# khy-os 项目长期记忆（判据索引）

> **本文件是判据索引**；论证/实证/复现步骤/长正文 → `MEMORY-details.md`（下称 **6**）。
> 缩写：`SB`=`services/backend`；`$g`=`scripts/ci/`；`$r`=`docs/10_规范/registry/RULES-REGISTRY.json`。每日日志 → `YYYY-MM-DD.md`（append-only）。
> ⚠ 引用任何总数前**必须现查真源**（会漂移）。
> ⚠ **本文件有 21KB 硬上限，超了就触发模型侧截断** ⇒ **只放「一句话判据」，长正文一律外置到 6**；新增内容优先考虑直接写进 6。

## 一、静态分析八个"暗门" → **6§一**

**入口不只 `main`**：`exports` 子路径 / npm scripts / `commands[].script` / 测试 / HTML `<script src>` / vite·Electron `input` / pyproject entry-points；**服务根整个纳入**（`SB/server.js` 不在 `src/` 下）；工具链 config 是入口却**不被 require**；**`.js`/`.ts` 同名对 `.js` 赢**；扫描式加载器、`@` 别名、`APPMOD:`/`RELPATH:` 见 6§一。

## 二、守卫与判读纪律（**静默失真类警告的唯一副本**；论证 6§八）

- `archDebtScan.js`（**在 `SB/scripts/`，不在 `$g`**）管分层倒置/巨石/循环依赖，**不管死代码**；基线只拦新增，**绝不用 `--update-baseline`**。判红灯前**先看 `git status` 规模**，大规模变动**先按 mtime 判归属**。⚠ 全仓文本搜索一律 `git grep`，**不要 `grep -rln`**。
- ⚠ **`AM` 时 `git show :<path>` 是 add 时快照**（当基线 = 回滚别人改动）；读暂存用 `git show :0:<path>`。
- ⚠ **gitignore ≠ 垃圾**：先 `git check-ignore -v <p>` 再定性（≈620MB/4.4 万文件是正常的）。⚠ 根目录字面量 `nul` ⇒ **任何 Python 遍历即崩**。
- `$g` 约定：**`--json` 后仍追加 `Summary:` 行** ⇒ 解析前 `split(/\n(?=Summary:)/)[0]`。
- `check-agent-rules`：`CODE_EXTS` **含 `.json`**；`--changed` **从不查规则的 `paths`**。⚠ `check-repo-layout.js` 因「未登记顶层目录」报 error ⇒ **脚本 dry-run 不留盘痕迹**。
- ⚠ **改造引用前先分辨「引用」还是「裁定」**（仓内大量文档在「记录某名字已死」）⇒ **批量替换必须建排除表**（按文件），**只替换完整命令形态** `npm run <name>`。
- ⚠ **re-export shim 让源码文本扫描型测试失真**（`SB/src/services/` 54 个）：正向**假红**、反向**假绿** ⇒ **跟随 shim 读真实文件**并自证行数>1。
- ⚠ **`Edit` 对含全角标点（`。、：（）`）的行可能「报成功未生效」** ⇒ 写脚本文件再 `node <file>`；⚠ **同一文件多个 `Edit` 并行会互相覆盖**（后写者赢）⇒ 改同一文件要串行。⚠ `docs/**` 是 CRLF，`CLAUDE.md` 是 **LF**。
- ⚠ **生成物不能被排版脚本扫到**（破逐字节契约）⇒ **只改生成器再重跑**；**不可幂等的修复脚本要用哨兵**。

## 三、其余各节的"一句话判据"（**长正文已迁 6§十八**）

> 每条都已在 `MEMORY-details.md` 展开；此表只作**检索索引**，判据取详情。

| 主题 | 一句话判据 |
|---|---|
| 零引用清理 vs 救活 | **只看文档背书**（有 → 救活或订正文档；无 → 可隔离）；**隔离前必跑安全闸** ⇒ 已落地 `RUNTIME-009` |
| 改代码前三陷阱 | ① 纯逻辑别寄生在拉 ORM 的模块里 ⇒ 抽**零依赖叶子**；② 权限相关的"奇怪字面量"常是刻意决策 ⇒ **改前先读注释与调用点**；③ `describe is not defined` 是 **runner 用错** |
| TUI | 清屏真分支看 **`lastOutputHeight >= rows`**；**视口哨兵 `null` = 贴底**；沙箱 `.khyos/diag/headless-frames.js`；**`tests/tui/**` 走 `test:tui`**（缺 `--experimental-vm-modules` 时**静默 skip 像绿**） |
| AI 指令文件 | ⚠ **三条读取链路，预算只在两条**（own 8000/文件·24000 合计、超限**只 slice 不报错**；compat `CLAUDE.md`/`AGENTS.md` **无预算不截断**）⇒ **别对 compat 套 8000、别自造阈值**；**D9-mirror 只查显式 `<!-- MIRROR: -->`**、**warning 非 error**、**不校验新鲜度** |
| 发布与同步 | **`main` 的上游是 `khy-mirror/main`，不是 `origin/main`** ⇒ **一律 `git rev-parse --abbrev-ref @{upstream}` 动态取**；`PROCESS-005` 是**手写 YAML 结构扫描**（**YAML 1.1 把 `on` 解析成布尔 `true`**）；**双机协作 = 单仓 + 租约**；**数据真源 `.ai/hq/` 必须入仓**（`MEMORY-003`） |
| 新机制四阶段 | **禁止直进 S3**；**毕业以样本量计不以时间计**（S1 **≥200** → S2 误报率 **<10%** → S3 可豁免）；**S1/S2 必须旁路记录、禁止阻断**；**禁止同时升两阶**；⚠ **登记 stage 必须与执行器源码常量一致** |
| 提交时机（`PROCESS-009`） | **改机制先改"描述"**；**★★ 别拿 `process.uptime()` 当"会话开工时间"** ⇒ **时间锚用被判定对象自身的 mtime**；**`--help` 在顶层被拦走**（`bin/khy.js:1383`）；**工具描述 ≤600 字符**且 enum 参数必须有 `example` |
| 域迁移/映射表 | ⚠⚠ 映射表 `paths[]` 可**静默失效**——守卫**只守 `docs[]`** ⇒ 悬空时**该 area 的 verify 永不进建议命令而守卫全绿**；⚠ 它在 `entries.length===0` 早退之后 ⇒ **无改动时跑不到**；**「被消费的真源」必须订正**，而 X-003 / `[OPS-MAN-169]` §一 的**同名留存不可改**；★ **孪生件**：`.md` 是生成物 ⇒ 改真源就**重跑生成器**（**验收 = 条目数相等 + 逐条命令相等**） |
| 出厂件明文密钥 | `built_in_keys.dart` 只有 XOR 字节数组（7 把），**APK 无明文**（四层已验）；⚠ ① `gen_keys.py` 曾与 Dart **漂移** ⇒ 照 Dart 头部提示重跑会**静默丢掉 `_stepfun`**；② `check_keys.ps1` 曾漏检第 7 把 + APK 路径写死在 `build/` ⇒ 等于没检查；⇒ 已加 `gen_keys.py --check` 与 `check_builtin_keys.py`。**判据：每加一把钥匙就重跑 `gen_keys.py --check`** |
| 工具授权（`RUNTIME-010`） | **默认拒绝、显式授予**（真源 `[DESIGN-AGENT-002]`）。★ `Bash` 是唯一从不被剥的**写通道**（重定向/`sed -i`/`tee`/`git add`），三处刻意决策互证 + 测试 `roleToolScope.test.js:56` 曾**明文锁死** ⇒ 只读 agent 靠提示词「NEVER use Bash」**零机制强制**。ⓐ **改授权面后必须打印实际展开值核对**——`disallowedTools: [..., SHELL_TOOL_NAMES]`（**少 `...`**）会生成**嵌套数组**、deny 静默失效，文本扫描守卫抓不到；ⓑ **`toolCalling.js` 头 26 行有契约**：权限闸不得早 return 跳过后续闸、**PreToolUse 硬底必须在所有闸之前** ⇒ 新闸只能加在硬底之后；ⓒ commit 门**只收 `args` 含 `--changed`** 的执行器，验收口径 = 门日志出现 `action=start target=<脚本>`；ⓓ 权威 role 词表只有 **implement/verify/explore/general**（`mergeRoleAttribution.js:58`），**十域枚举无 AGENT 域** ⇒ 新规则落 RUNTIME；ⓔ `verify` 的 shell 是**显式授予**，与 explore 不同 |

## 四、新设计/新守卫：落点与接线（**长判读已迁 6§二十**）

**落点**：规范族 `[DESIGN-<域>-NNN]` → `docs/10_规范/`；设计族 `DESIGN-ARCH-*` → `docs/03_DESIGN_设计/`；名 `[<STAGE>-<TYPE>-NNN] 中文名.md`；回写就近 `00_INDEX_*`；**每 `.md` 必须有 `.html` 孪生件**；临时工具落 `.khyos/`。**`[DESIGN-ARCH-NNN]` 是文档编号不是规则 ID**。

**接线四处触点（缺一即红）**：
1. `$g*.js` 零接线被 `check-wiring` 判 error。⚠ 检查器集合 = `$g` ∪ **全部规则的 `exec.script`**；**门表面 = `package.json` scripts ∪ `.github/workflows/*.yml ∪ .githooks/* ∪ 阶段表** ⇒ **被钩子引用即算接线**，别名非必需。
2. `$r` 补条目：`ssot`=语义真源、`exec.script`=真正 spawn 的执行器（**只认 `$g`**）；`<!-- RULES-REGISTRY: ID -->` = 「本文件是这些规则的 ssot」⇒ **`ssot` 指向的文档也必须带该 marker**（**多规则共用一文件时并列一行写** `A, B` —— 写两行只最后一行生效）；**门档不用改**；同步 `meta.ruleCount`/`rules.length`；⚠ `formerly` **必须是字符串**；⚠ `domain` 是**十域封闭枚举**。
3. `AGENTS.md` 第 3 行 marker 补 ID **+ 补规则正文**。
4. `npm run docs:rules-cards` 重生成（**规则卡禁止手改**，先修登记表）；⚠ 规则卡的 **`.html` 孪生件由 `build_docs_site.js` 出**，不是规则卡生成器 ⇒ **加规则后必须跑全站 `build_docs_site.js`**，只跑前者会报 `.html` 缺失。

**判读（★ = 静默失真类，危害最高；完整清单见 6§二十）**：
- ⚠⚠★ `gate='advisory'` 的规则**永不执行**（`GATE_ORDER.advisory=4` > `max=2`）⇒「只记录不拦截」一律用 `gate:'commit'` + `severity:'advisory'`。
- ⚠⚠★ **finding 方言决定守卫是否静默失效**：**计数/盘点型只能走聚合方言** `- [warn] … (id: x)`；逐项方言**必须带 file:line**。
- ⚠⚠ **阶段表 = 门表面（S4）**：匹配是 `text.includes(<执行器 basename>)` 且取**全文** ⇒ 写出**执行器路径**即新增门表面（**别名 `npm run X` 不算**）。发布门阶段表真实路径 `scripts/release/lib/releaseGateStages.js`（有 `lib/`）。
- 其余 14 条（接线契约四则、两条 P0 覆盖率假绿、`SECURITY-001` 超 20 文件硬拦截、`check:layout` 瞬时态误报、`--files=` 空值陷阱、棘轮、`build_docs_site.js` 副作用、`RUNTIME-001` 范围漂移……）**全在 6§二十**。

## 五、结构/体积治理（6§十二）

- **结构真源** `[DESIGN-LAY-005]`（L0 `kernel/`→…→L6 `tools/`），守卫 `$g check-repo-layout.js`。**改结构前先读它**。
- **产物唯一根** `entries/<producer>[/<variant>]`（`LAYOUT-005`）；扫描/探针脚本一律落 `.khyos/diag/`。
- ⚠ **`dangling-task` 判据曾被另一智能体的未暂存 WIP 改动** ⇒ **别把读到的工作区行为当成 HEAD 行为**。
- ★★ **三条最贵的判据**：① **「混乱度」按「同一抽象层级」判**（扁平发布清单目录本就该平级 ⇒ 豁免；同类判断**已撤回三次**）⇒ 动「看着乱」的目录前先查 `package.json` 的 `main`/`bin`/`scripts`/`files` 是否按**裸文件名**绑定、有无硬编码常量、README 有无逐行说明 —— **任一命中即不动**；② **「被代码引用」≠「该补脚本」**（缺别名→补；代码**承诺**它→补或订正；只是**夹具数据**→**不补**；⚠ **补别名前先跑一次原脚本**）；③ **先分辨「引用」还是「裁定」**（同 §二）。

## 六、四块长正文的索引（**正文已迁 6§十九**）

> §五之二 可交付性 / §六 git 历史重建 / §七 `PROCESS-011` 规范-实现裁定 / §八 可维护性减负
> —— 这四块原在本文件，2026-09-22 瘦身时**原样迁入 6§十九（A/B/C/D/E）**。此处只留最高频判据。

| 主题 | 一句话判据 |
|---|---|
| 可交付性（§五之二） | ★★ **90 条规则全守「仓库内部一致性」，交付面一件都没被强制** ⇒ **规则数与可交付性零相关**；★★ **判仓库健康不能只看 `HEAD`** ⇒ 必须 `git fsck` **按类型分解**（**missing 才是真问题，dangling 无害**）；★★ **「恒真断言」= 没有断言** ⇒ 判记分板先问「**关掉守卫它会不会变红？**」；⚠ **「生成但无消费者」= 装饰**（`continue-on-error` 吞失败） |
| git 历史重建（§六） | ① **分批提交前必须 `git reset`**（`git add -A -- <批>` 只追加不移出，而 commit 提交**整个索引**）；② **message 检查落点是 `commit-msg` 不是 `pre-commit`**；③ **不能并发跑「提交」与「历史改写」**；④ **索引可能陈旧** ⇒ 判暂存集**要拿工作区复核**。⚠ 待办：`apps/ai-frontend/src/views/admin/` 24 个 `.vue` 未提交 |
| 规范-实现裁定（§七，`PROCESS-011`） | **先裁「改哪边」再动手**；**四问强制不跳**（Q1 该存在吗 → Q2 可机械判定吗 → Q3 哪边已被消费 → Q4 多严重）；★ **最反直觉一格**：Q2「不可机械判定」+ Q3「实现已被消费」⇒ **改规范（收敛到实现）**，别硬造守卫；⚠ **AI 不得自行裁决归宿**；⚠ 号段 **011**（009/010 已占） |
| 可维护性减负（§八，`[DESIGN-ARCH-127]`） | ★★ **「难以维护」是成本结构问题，不是纪律问题**（**新增一条规则 = 13 处硬触点**，只有 1 处是真语义输入）⇒ **一条规则只应有 1 处语义输入**；⚠⚠ **`gate=advisory` = 「想观察却写成永不执行」** ⇒ 一律 `gate:"commit"` + `severity:"advisory"`；⚠ 坑：**finding 方言**、**`ssot` 是目标列表不是路径**、**生成器顺序刚性**、**`.git/hooks` 与 `.githooks` 同时生效**、**bash `/tmp` ≠ node `/tmp`** |

## 七、对象库损伤辨识（2026-09-22 实测；**详 6§十九-E**）

- ⚠⚠ **「对象库损坏」必须按类型分解**：**`missing blob` 分两类**——**被 HEAD 树引用的**（真阻断提交）/ **dangling·历史的**（**不影响提交**）。判定用 `git ls-tree -r HEAD | awk '{print $3"\t"$4}'` 建 sha→路径表反查。
- ⚠⚠ **`missing tree` 大多是假象**：本仓 27 个**全部**来自 `invalid sha1 pointer in cache-tree of .git/index` ⇒ 只是 **index 的 cache-tree 陈旧**。**先用 `git cat-file -t <sha>` 验真**再定性。
- ⚠ **`git commit` 只需「HEAD 树 + 新树 + 父提交」，不遍历历史** ⇒ **`git log`/`rev-list` 全炸时提交仍可能成功**。
- ★★ **重建子树用 `git mktree` 并校验 sha 命中**：`git hash-object -w --stdin-paths`（**路径必须仓库根相对**）+ `printf '<mode> blob <sha>\t<name>\n' | git mktree`。**验收 = 算出 sha 与 HEAD 期望 sha 逐字符相等**（等即证逐字节一致、重建忠实）。
- ⚠ **并发 git 进程会让 fsck 不可信**：先 `git verify-pack -v <idx>` 确认 `pack: ok`，再看 `git show-index` 有无目标 sha。

## 八、前端 404/500 + WS 反复失败：四条叠加根因（详解 2026-09-23.md）

**daemon 与 web 后端默认都占 3000**：`start-daemon.js` 兜底 `'3000'`（真源是
`serviceDefaults.AI_BACKEND_DEFAULT_PORT`=**9090**），且 daemon 绑 `127.0.0.1`、
web 后端绑 `0.0.0.0` ⇒ **Windows 下更具体的绑定优先，浏览器全部落到 daemon**。
判据：`netstat` 同一端口出现两条 LISTENING，且 `127.0.0.1` 与 `192.168.x.x` 返回不同服务的报文。
**WS 握手协议错配**：ESM `wsClientCore.js` 发 `'auth:request'`，协议真源
`protocol.cjs` 与服务端只认 `'auth'`（`.cjs` 孪生件是对的）⇒ 走 default 回
`Unknown message type`。⚠ **单元测试把错误字面量固化成了断言** ⇒ 改真源前先判断哪边权威。
**syncServer 心跳 60s 必踢**：30s 置 `isAlive=false`+ping，但**全文件无 `pong` 监听**。
**空闲看门狗**只数 app 级 `wss.clients`，不含 syncServer 的 `_wss`。
⚠⚠ **修复有依赖顺序**：`_clients` 只在收到 `auth` 后填充 ⇒ **不先修协议，看门狗修复恒为无效**。
探针：`.khyos/diag/{ws-handshake-probe,idle-shutdown-live,frontend-e2e-verify}.js`。
