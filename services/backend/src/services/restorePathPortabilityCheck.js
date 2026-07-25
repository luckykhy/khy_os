'use strict';

/**
 * 还原「路径可移植性 / restore-path-portability」解包前把关 —— bundled 运行时纯叶子（零 IO · 绝不抛）。
 *
 * ── 补的缺口：snapshot 是 path-blind，跨 OS 还原会「悄悄少文件」却只事后猜 ─────────────
 * 源码快照打成一团 tar.gz，随 pip / npm 发到**陌生机器与陌生系统**。运行时 `handleRestore`
 * 解密后直接 `tar -xzf` 盲解包，**从不预先看归档里的条目名到底能不能在本机文件系统落地**。
 * 但归档里的条目名是在 **Linux** 上打的，Linux 文件系统几乎什么名字都收；换到 **Windows / macOS**
 * 还原时，同一批名字里有相当一部分会**静默失败或改写**：
 *   · Windows **保留设备名**（CON / PRN / AUX / NUL / COM1-9 / LPT1-9，大小写与扩展名无关）——
 *     `aux.js`、`com1.txt` 这种文件在 Windows 上**根本建不出来**；
 *   · Windows **非法字符**（`< > : " | ? *` 以及 0x00-0x1F 控制字符）——含这些字符的条目**解不出来**；
 *   · 段**结尾的点 / 空格**（`foo.` / `bar `）——Windows 会**静默剥掉**，导致改名或与别的文件撞名；
 *   · 全路径 **超 259 字符**（MAX_PATH）——旧式 API 下**超长路径条目被跳过**；
 *   · **大小写不敏感碰撞**（`Foo.js` vs `foo.js`）——在 Windows NTFS / macOS APFS 默认大小写不敏感的卷上
 *     **后者覆盖前者**，落地文件比归档里少。
 * 运行时对这些**一无所知**：唯一的跨 OS 信号是 completeness 对账**事后**发现「文件数少了」时，才打一句
 * 泛泛的反应式提示（"可能路径过长(Windows MAX_PATH) / tar 跳过条目…"，publish.js）。那是**事后猜测**，
 * 既不知道**是哪些**路径出问题、也不知道**为什么**。本叶把这条缺失的**解包前**消费者接上线：在
 * `tar -xzf` **之前**把归档条目名枚举出来，逐条按上述五类危害分类，给出**主动、精确、指名道姓**的
 * 诚实横幅——让陌生机器上的维护者在还原当下就知道「这几条路径在你这台 Windows / macOS 上不会落地」。
 *
 * ── 和已接线的还原诊断族正交（别混淆）──────────────────────────────────────────────
 *   · restorePreflightCheck（解密**前**）：外层信封 format + 加密套件——「本机解不解得开密文」。
 *   · restoreArchiveExtractCheck（解密后、解包**前**）：内层归档形制 plaintextFormat/layout——
 *     「本机 tar 认不认识这团归档」。
 *   · **本叶（解密后、解包前）**：归档**条目名**逐条 vs 本机文件系统命名规则——「这些名字在本机
 *     （尤其 Windows / macOS）建不建得出来」。前者管**能不能解开这团归档**，本叶管**解开后每个名字
 *     能不能落地**——正交。
 *   · restoreCompletenessCheck（解包**后**）：磁盘落地文件数 vs 快照 fileCount——「数量对不对」。本叶
 *     是它的**前置主动版**：completeness 事后发现「少了」，本叶事前说清「会少哪些、为什么」。
 *
 * ── 怎么判：五类危害分类（纯字符串规则 · 绝不碰任何密钥）──────────────────────────────
 * assessPathPortability(entryNames, opts) 纯函数、绝不抛。entryNames = 归档条目名数组（已去掉
 * 前导 './' 与结尾 '/'）。逐条分类，桶里放的是**惹祸的原始名字**（截断到上限，避免爆内存）：
 *   reserved          —— 某个路径段的**主名**（第一个点之前）是 Windows 保留设备名。
 *   illegalChar       —— 某个路径段含 `< > : " | ? *` 或 0x00-0x1F 控制字符。
 *   trailingDotSpace  —— 某个路径段以 '.' 或 ' ' 结尾（'.' / '..' 导航段除外）。
 *   tooLong           —— 全路径长度 > 259（MAX_PATH）。
 *   caseCollision     —— 两个**不同**条目名小写化后相等（大小写不敏感卷上互相覆盖）。
 * ok===true **仅当**五个桶全空——即这批名字在 Windows / macOS 上也能原样落地。任何一桶非空 → ok:false，
 * 诚实披露「这批源码在别的系统上还原会缺文件 / 改名」。
 *
 * ── 横幅渲染：buildPortabilityBannerLine(verdict, opts) → {line, severity} | null ──────
 * **按宿主系统**把裁决翻成一行给运行时 restore 横幅（host-aware，因为「会不会真出问题」取决于**你正在
 * 哪台机器上还原**）：
 *   · hostPlatform==='win32' —— 五类危害在 Windows 上**全是真实解包失败** → severity:'warn'（printWarn）。
 *   · hostPlatform==='darwin' —— caseCollision 在 macOS 默认卷上是**真实覆盖** → severity:'warn'；其余
 *     Windows 专属危害在本机不一定犯事，作为跨 OS 提醒 → 若无 caseCollision 但有别的 → severity:'info'。
 *   · 其它（linux 等大小写敏感、宽松命名的系统）—— 本机能原样落地，但这批名字**换到 Windows / macOS
 *     会出问题** → 有危害则 severity:'info'（跨 OS 前瞻提醒），无危害则 null（不打行，横幅字节等价旧行为）。
 * 渲染是纯函数、可单测，例名截断到前 3 条；严重度路由（printWarn vs printInfo）留给 publish.js。
 *
 * ── 恒久红线（继承还原家族）──────────────────────────────────────────────────────
 * · 只披露不阻拦：本叶**绝不改变还原成败、绝不 markFailure**——超长 / 保留名 / 碰撞是**目标系统**的
 *   命名限制，不是这团归档坏了；在 Linux 上还原它照样完整。本叶只把「悄悄少文件」变成「事前诚实告知」。
 * · 只读条目名字符串，**绝不碰任何密钥**：入参是解密后归档的**文件名**，本叶只做字符串分类，
 *   裁决对象里不含任何密文 / 密钥 / 文件内容。
 * · 纯计算、零 IO、无时钟、无随机、绝不抛：任何入参缺失 / 非法 → 保守（total:0, ok:true, 空桶）。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────────────
 * 新增一类跨 OS 命名危害时：① 在 HAZARD_KINDS 登记它的 key；② 在 _classifyEntry 里加一条纯字符串
 * 判定，命中就 push 进对应桶；③ 若它在某个宿主系统上是**真实失败**（不只是提醒），在
 * buildPortabilityBannerLine 的 host 分支里把它列进该 host 的 warn 级集合。ok 的定义只有一个出口
 * （五桶皆空）——别在别处放行。保留名 / 非法字符集若要扩充，改 RESERVED_NAMES / ILLEGAL_CHARS_RE 一处即可。
 */

// 会惹祸的五类命名危害的 key（新增类别时在此登记，并同步 _classifyEntry 与横幅 host 分支）。
const HAZARD_KINDS = ['reserved', 'illegalChar', 'trailingDotSpace', 'tooLong', 'caseCollision'];

// Windows 保留设备名（大小写与扩展名无关；判定时取路径段的「主名」= 第一个点之前的部分）。
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// Windows 文件名非法字符 `< > : " | ? *` 加控制字符 0x00-0x1F（不含路径分隔符 '/'；空格 / 连字符合法，不列入）。
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS_RE = /[<>:"|?*\x00-\x1f]/;

// MAX_PATH：全路径超过此长度在旧式 Windows API 下会被跳过。
const MAX_PATH_LEN = 259;

// 每个危害桶最多保留多少个原始名字（防止超大归档把裁决对象撑爆；横幅另截断到前 3）。
const _BUCKET_CAP = 50;

/** 非空字符串判定。 */
function _isNonEmptyStr(x) {
  return typeof x === 'string' && x.length > 0;
}

/** 把条目名切成路径段，过滤空段与 '.' / '..' 导航段。 */
function _segments(name) {
  return String(name).split('/').filter((s) => s && s !== '.' && s !== '..');
}

/** 段的「主名」（第一个点之前）大写后是否命中保留设备名。 */
function _isReservedSegment(segment) {
  const base = String(segment).split('.')[0];
  return RESERVED_NAMES.has(base.toUpperCase());
}

/** 段是否含 Windows 非法字符。 */
function _hasIllegalChar(segment) {
  return ILLEGAL_CHARS_RE.test(String(segment));
}

/** 段是否以 '.' 或 ' ' 结尾（Windows 会静默剥掉）。 */
function _hasTrailingDotSpace(segment) {
  const s = String(segment);
  if (s.length === 0) return false;
  const last = s[s.length - 1];
  return last === '.' || last === ' ';
}

/**
 * 对单个条目名做「非碰撞类」的四项分类，返回命中的 kind 数组（不含 caseCollision——那要跨条目比较）。
 */
function _classifyEntry(name) {
  const hits = [];
  const segs = _segments(name);
  let reserved = false;
  let illegal = false;
  let trailing = false;
  for (const seg of segs) {
    if (!reserved && _isReservedSegment(seg)) reserved = true;
    if (!illegal && _hasIllegalChar(seg)) illegal = true;
    if (!trailing && _hasTrailingDotSpace(seg)) trailing = true;
  }
  if (reserved) hits.push('reserved');
  if (illegal) hits.push('illegalChar');
  if (trailing) hits.push('trailingDotSpace');
  if (String(name).length > MAX_PATH_LEN) hits.push('tooLong');
  return hits;
}

/** 空裁决（入参缺失 / 非法时保守返回：无条目 = 无危害 = ok）。 */
function _emptyVerdict() {
  const hazards = {};
  const counts = {};
  for (const k of HAZARD_KINDS) {
    hazards[k] = [];
    counts[k] = 0;
  }
  return { ok: true, total: 0, hazardTotal: 0, hazards, counts };
}

/**
 * 逐条把归档条目名按五类跨 OS 命名危害分类。绝不抛。
 *
 * @param {string[]} entryNames  归档条目名（已去掉前导 './' 与结尾 '/'）
 * @param {object} [opts]
 * @returns {{ok:boolean, total:number, hazardTotal:number,
 *            hazards:{reserved:string[], illegalChar:string[], trailingDotSpace:string[],
 *                     tooLong:string[], caseCollision:string[]},
 *            counts:{reserved:number, illegalChar:number, trailingDotSpace:number,
 *                    tooLong:number, caseCollision:number}}}
 */
function assessPathPortability(entryNames, opts) {
  void opts;
  try {
    if (!Array.isArray(entryNames)) return _emptyVerdict();

    const names = entryNames.filter(_isNonEmptyStr);
    const verdict = _emptyVerdict();
    verdict.total = names.length;
    verdict.ok = true;

    // 非碰撞四类：逐条分类。
    for (const name of names) {
      const hits = _classifyEntry(name);
      for (const kind of hits) {
        const bucket = verdict.hazards[kind];
        if (bucket.length < _BUCKET_CAP) bucket.push(name);
        verdict.counts[kind] += 1;
      }
    }

    // 大小写不敏感碰撞：按小写全名分桶，桶内出现 ≥2 个**不同**原始名即碰撞。
    const byLower = new Map();
    for (const name of names) {
      const key = name.toLowerCase();
      let group = byLower.get(key);
      if (!group) {
        group = new Set();
        byLower.set(key, group);
      }
      group.add(name);
    }
    for (const group of byLower.values()) {
      if (group.size >= 2) {
        for (const name of group) {
          const bucket = verdict.hazards.caseCollision;
          if (bucket.length < _BUCKET_CAP) bucket.push(name);
          verdict.counts.caseCollision += 1;
        }
      }
    }

    let hazardTotal = 0;
    for (const k of HAZARD_KINDS) hazardTotal += verdict.counts[k];
    verdict.hazardTotal = hazardTotal;
    verdict.ok = hazardTotal === 0;
    return verdict;
  } catch {
    return _emptyVerdict();
  }
}

// 每类危害的人类可读标签（横幅用）。
const _KIND_LABEL = {
  reserved: 'Windows 保留设备名',
  illegalChar: 'Windows 非法字符',
  trailingDotSpace: '结尾点/空格段',
  tooLong: '超 259 字符(MAX_PATH)',
  caseCollision: '大小写不敏感碰撞',
};

/** 把某几类危害拼成 "标签×N(例 a, b, c)" 片段。例名截断到前 3。 */
function _fragments(verdict, kinds) {
  const parts = [];
  for (const k of kinds) {
    const n = verdict.counts[k] || 0;
    if (n <= 0) continue;
    const examples = (verdict.hazards[k] || []).slice(0, 3);
    const exStr = examples.length ? `（例 ${examples.join('、')}${n > examples.length ? ' …' : ''}）` : '';
    parts.push(`${_KIND_LABEL[k]}×${n}${exStr}`);
  }
  return parts;
}

/**
 * 把路径可移植性裁决翻成一行运行时 restore 横幅提示。按宿主系统决定严重度。绝不抛。
 *
 * @param {object} verdict  assessPathPortability 的返回值
 * @param {object} [opts]
 * @param {string} [opts.hostPlatform]  宿主系统（process.platform：'win32' | 'darwin' | 'linux' | …）
 * @returns {({severity:string, line:string}|null)}
 */
function buildPortabilityBannerLine(verdict, opts) {
  try {
    if (!verdict || typeof verdict !== 'object') return null;
    if (!(verdict.hazardTotal > 0)) return null; // 无危害 → 不打行，横幅字节等价旧行为。

    const host = (opts && _isNonEmptyStr(opts.hostPlatform)) ? opts.hostPlatform : '';
    const present = HAZARD_KINDS.filter((k) => (verdict.counts[k] || 0) > 0);

    let severity;
    let hostNote;
    if (host === 'win32') {
      // 五类在 Windows 上全是真实解包失败。
      severity = 'warn';
      hostNote = '本机是 Windows，以下条目还原时会失败 / 改名 / 覆盖';
    } else if (host === 'darwin') {
      // caseCollision 在 macOS 默认卷上真实覆盖；其余作跨 OS 提醒。
      severity = (verdict.counts.caseCollision || 0) > 0 ? 'warn' : 'info';
      hostNote = '本机是 macOS（默认大小写不敏感），大小写碰撞会互相覆盖；其余为跨系统提醒';
    } else {
      // linux 等：本机能原样落地，但换到 Windows / macOS 会出问题——跨 OS 前瞻提醒。
      severity = 'info';
      hostNote = '本机可原样落地，但这批路径在 Windows / macOS 上还原会缺文件 / 改名';
    }

    const frags = _fragments(verdict, present);
    if (frags.length === 0) return null;

    const line = `路径可移植性：${hostNote} —— ${frags.join('；')}`;
    return { severity, line };
  } catch {
    return null;
  }
}

module.exports = {
  assessPathPortability,
  buildPortabilityBannerLine,
  HAZARD_KINDS,
  RESERVED_NAMES,
  ILLEGAL_CHARS_RE,
  MAX_PATH_LEN,
  _isReservedSegment,
  _hasIllegalChar,
  _hasTrailingDotSpace,
  _classifyEntry,
  _isNonEmptyStr,
};
