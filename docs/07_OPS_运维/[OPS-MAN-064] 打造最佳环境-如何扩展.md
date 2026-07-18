<!-- 文档分类: OPS-MAN-064 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-064] 打造最佳环境-如何扩展.md -->
# 「打造最佳环境」— 如何扩展（新手 / 小模型手册）

> 日期: 2026-07-09
> 状态: 已实施
> 关联文件: `services/backend/src/services/envProbes.js`, `envRepair.js`, `envPlatform.js`, `localBrainEnvOptimize.js`
> 一句话验证: `npm run test:maintainer:env-optimize`

## 这份文档给谁看

你是**第一次接手**这块代码的人，或者是一个**小模型**（例如 4B）。你不需要读懂整套自检流水线，也不需要改动核心逻辑。这块功能是**照着模板抄一条就能扩**的——本文档告诉你抄哪一行、抄成什么样、怎么验证没抄错。

如果你只想改一个东西，直接跳到下面对应的「配方」小节，照抄即可。

---

## 一分钟看懂结构

用户在输入框里打「打造当前系统最佳环境」这句话，系统会依次做四件事，每件事对应一个文件：

| 你想加什么 | 改这一个文件 | 往哪个数组里加一条 |
| --- | --- | --- |
| 一个新的**健康检查**（只看不改，如「端口被占用」「证书过期」） | `envProbes.js` | `_PROBES` |
| 一个新的**安全修复**（只补缺失，绝不删东西） | `envRepair.js` | `_REPAIRS` |
| 一个新的**平台区分**（某检查只在某系统跑） | 给上面那条加一个 `platforms` 字段 | 同上 |

**关键点**：加一个检查或修复，你**只改一个文件、只加一个对象**。编排层 `localBrainEnvOptimize.js`、格式化、结论文案、接线**全都不用动**——聚合器会自动把你新加的那条纳入报告。这是设计好的，不是巧合。

---

## 配方 A：加一个「健康检查」（只读探针）

**场景举例**：你想让系统在磁盘 inode 快用完时提醒用户。

### 第 1 步：打开文件

`services/backend/src/services/envProbes.js`

### 第 2 步：照抄一个探针函数

在文件里现有的 `_probe...` 函数旁边，抄一个新的。规则只有三条：

1. **只看不改**：只能读系统状态（`os`、`fs.statSync` 之类），**绝对不能写文件、删文件、开子进程**。
2. **健康就返回 `null`**：没问题时返回 `null`，报告里就不会出现这一条。
3. **有问题就返回一个对象**：`{ severity, detail, hint }`。

```javascript
/** inode 耗尽检查 —— 示例，照抄改逻辑即可。 */
function _probeInodeExhaustion() {
  let free = 0;
  try {
    // ……在这里读你的系统指标（只读！）……
    free = 100; // 占位：换成真实读取
  } catch { return null; }        // 读不到就当健康，绝不抛异常
  if (free < 5) {
    return {
      severity: 'high',           // critical > high > warning > info
      detail: `可用 inode 仅剩 ${free}%`,
      hint: '清理小文件，否则无法再创建文件',
    };
  }
  return null;                     // 健康 → 返回 null
}
```

`severity` 四选一（从重到轻）：`critical`、`high`、`warning`、`info`。`hint` 是给用户的一句「怎么办」，可留空字符串。

### 第 3 步：在 `_PROBES` 数组里加一行

找到文件底部的 `const _PROBES = [ ... ]`，在数组里加一条：

```javascript
{ key: 'inode-exhaustion', label: 'inode 耗尽', run: _probeInodeExhaustion },
```

- `key`：英文短横线命名，全表唯一。
- `label`：中文短标签，会显示在报告里。
- `run`：你刚写的函数名（不要加括号）。

### 第 4 步：把函数加进导出（测试要用）

文件底部 `module.exports = { ... }` 里加一行 `_probeInodeExhaustion,`。

### 第 5 步：验证

```bash
npm run test:maintainer:env-optimize
```

全绿就说明你没抄错。想只跑探针测试：

```bash
node --test services/backend/tests/services/envProbes.test.js
```

---

## 配方 B：加一个「安全修复」

**场景举例**：某个必需的目录缺失了，你想自动把它建出来。

### 安全铁律（不可违反 —— 违反了会毁用户数据）

修复层 `envRepair.js` 顶部写着四条铁律，加任何修复都必须守住：

1. **只创建缺失的东西**（`mkdir` 补一个缺失目录）。**绝不删除、绝不覆盖、绝不截断**用户已有的任何文件。
2. **可重复运行**：跑第二遍必须是「什么都没做」（已经健康就返回 `null`）。
3. **失败不抛异常**：修不了就返回 `{ ok: false }` 说明原因，不能让程序崩。
4. **遇到损坏不要删**：如果路径存在但类型不对（比如本该是目录却是个文件），**不要删它**——那可能是用户的数据。返回 `ok:false` 交给人工处理。

> ⚠️ **要删东西？不要在这里做。** 删除是破坏性操作，必须走 `磁盘清理` 命令的人工确认闸门（riskGate），一句自然语言绝不能绕过它。这块只做「补缺失」，不做「删多余」。

### 照抄一个修复函数

```javascript
/** 补一个缺失的示例目录 —— 照抄改路径即可。 */
function _repairExampleDir() {
  let dir;
  try { dir = path.join(os.homedir(), '.khy', 'example'); } catch { return null; }
  if (!dir) return null;

  let stat = null;
  try { stat = fs.statSync(dir); } catch { stat = null; }

  if (stat && stat.isDirectory()) return null;          // 已健康 → 不做事（可重复运行）
  if (stat && !stat.isDirectory()) {                    // 存在但类型错 → 不删,交人工
    return { ok: false, changed: false, detail: `路径被文件占用，需人工处理: ${dir}` };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });             // 缺失 → 补上（唯一允许的写操作）
    return { ok: true, changed: true, detail: `已创建缺失的目录: ${dir}` };
  } catch (err) {
    return { ok: false, changed: false, detail: `无法创建 ${dir}（${(err && err.code) || 'IO error'}）` };
  }
}
```

返回值三选一：`null`（健康）、`{ok:true, changed:true, detail}`（这次补上了）、`{ok:false, changed:false, detail}`（没补成，交人工）。

### 在 `_REPAIRS` 数组里加一行 + 导出

```javascript
{ key: 'example-dir', label: '示例目录', run: _repairExampleDir, platforms: ['linux', 'windows', 'macos', 'android'] },
```

再在 `module.exports` 里加 `_repairExampleDir,`。验证同配方 A（`npm run test:maintainer:env-optimize`）。

---

## 配方 C：让某个检查/修复「只在某些系统跑」

**场景举例**：Windows 上 PATH 里常有失效目录，但 Linux 不需要查这个。

这就是「注意 linux/windows/macos/android/ios 系统的区分」那条需求的落地方式。**你不用写任何 `if (系统是 Windows)` 的判断**——只要在那一条注册项上加一个 `platforms` 白名单字段：

```javascript
{ key: 'path-integrity', label: 'PATH 完整性', run: _probePathIntegrity, platforms: ['windows'] },
```

- **不写 `platforms`** = 所有系统都跑（最常见）。
- **写了** = 只在列表里的系统跑，其它系统自动跳过。

合法的系统名（全小写）：`linux`、`windows`、`macos`、`android`、`harmonyos`、`ios`。这张表定义在 `envPlatform.js` 的 `_PLATFORM_META` 里，附带每个系统的特征（例如 `sandboxed`=移动沙盒受限、`hasLoadAvg`=有没有 CPU 负载均值）。

几条已经生效的例子，可照着模仿：
- `cpu-load`：`['linux', 'macos', 'android', 'harmonyos']`——排除 Windows（Windows 的负载均值恒为 0，查了没意义）。
- `path-integrity`：`['windows']`——只有 Windows 会有失效 PATH 的老毛病。
- `config-home`（修复）：`['linux', 'windows', 'macos', 'android']`——排除 iOS/HarmonyOS（手机沙盒里不能随便在 HOME 建目录）。

> 想知道当前跑在哪个系统？系统靠 `envPlatform.detectPlatform()` 判断，它复用仓库已有的 `osProfileService`（唯一权威，别再另写一套）。测试里可以用 `KHY_OS_PROFILE=windows` 之类的环境变量临时假装成某个系统。

---

## 开关（万一要临时关掉某一层）

每一层都有独立开关，默认全开。设成 `false` 就**逐字节退回**到没有这一层时的行为（不是报错，是干净地不出现）：

| 环境变量 | 关掉什么 |
| --- | --- |
| `KHY_ENV_OPTIMIZE=false` | 整个「打造最佳环境」意图（这句话会当普通对话交给模型） |
| `KHY_ENV_OPTIMIZE_JUNK_SCAN=false` | 只读垃圾扫描 |
| `KHY_ENV_OPTIMIZE_PROBES=false` | 所有健康检查探针 |
| `KHY_ENV_OPTIMIZE_REPAIR=false` | 所有安全修复（只检测不修） |

---

## 出错了怎么办（自查清单）

1. **测试报「某某未定义」**：你多半忘了在 `module.exports` 里加你的函数名。
2. **报告里没出现你的新检查**：确认你在 `_PROBES` / `_REPAIRS` 数组里加了那一行，且 `run` 写的是函数名、没加括号。
3. **`npm run maintainer:check` 报 MISSING**：你在维护映射表里写了一个不存在的文件路径，改回真实路径。
4. **守卫报 leaf-io**：`envProbes.js`/`envRepair.js` 允许做 IO（它们在文件头明确声明「不是纯叶子」）。如果你新建了别的文件又写了 IO，要么在文件头同样声明不是纯叶子，要么把 IO 挪到调用方。
5. **不确定改对没有**：跑这一条，全绿即安全：
   ```bash
   npm run test:maintainer:env-optimize
   ```

---

## 相关文档

- 架构规范：`docs/03_DESIGN_设计/[DESIGN-ARCH-026] khyos系统级服务调用审批网关规范.md`
- 维护路由表（哪块坏了改哪里）：`docs/维护者/维护映射表.json`（区域 id：`env-optimize`）
- 项目可维护性总入口：仓库根 `.ai/`（见 `CLAUDE.md`）
