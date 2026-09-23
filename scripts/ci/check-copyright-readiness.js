#!/usr/bin/env node
/**
 * check-copyright-readiness.js —— 软件著作权就绪守卫
 *
 * 真源：docs/10_规范/其它规范/[DESIGN-IP-001] 软件著作权就绪规范.md
 *       （规则 PROCESS-010，登记于 docs/10_规范/registry/RULES-REGISTRY.json）
 *
 * 定位：把 DESIGN-IP-001 里**可机器判**的那部分做成门，让「以后生成的代码」
 * 不会悄悄破坏登记就绪度。规范里凡标 `人工` 的条目（C-M4 痕迹内容是否成立、
 * C-X1 随机抽 3 处能解释）**不在这里** —— 机器判不了，设了守卫只会制造形式主义。
 *
 * ── 落地阶段（PROCESS-006 / PROCESS-008） ──────────────────────────────
 * STAGE = 'S1'：观察者，**恒 exit 0、只记录不阻断**。
 * 本仓规矩（PP-3）：S1/S2 阶段的机制不得派生为 blocking，必须旁路记录 ——
 * 一步到位设成阻断会踩 check-rollout-stage.js 的 rollout-stage-blocks-too-early。
 * 升阶是人的决定：S1（≥200 样本）→ S2 → S3（真阻断）。一次只升一阶（PP-6）。
 *
 * ── 输出契约（scripts/ruleguard/lib/run.js） ────────────────────────────
 *   方言：`[ERROR|WARN ] <finding> <file>:<line>` + 两空格缩进 message，
 *         尾部 `Summary: N error(s), M warning(s).`
 *   `ERROR` / `WARN ` 必须占定宽 6 字符（ruleguard 的 FINDING_LINE 正则如此）。
 *   ⚠ 内部严重度**规范形只存小写** 'error' / 'warning'，输出时才 labelOf() 映射 ——
 *     混用两套大小写会让 error 被静默计成 warning（check-agent-feedback.js 踩过）。
 *
 * ── 精度纪律（踩过才知道，两次） ────────────────────────────────────────
 *   ① **跳过一切点目录** —— 不跳时 `.vue` 命中 33 个，样例全是
 *      `.khyos/deadcode-quarantine/` 与 `.khyos/tmp/` 里的**副本**，比真值多 14 个。
 *   ② **`--all` 模式必须给 `git log` 显式传 `--all`** —— 否则把 209 条当全量，
 *      基线算成 62/29.7%（真值 88/243 = 36.2%）。
 *   低精度守卫比没有守卫更糟（误报会被整体无视）。每次改本文件都要与官方筛查
 *   脚本 `scan_copyright_readiness.py` 的对应指标**对账**，对不上先修守卫。
 *
 * Usage:
 *   node scripts/ci/check-copyright-readiness.js                # 默认：上游..HEAD
 *   node scripts/ci/check-copyright-readiness.js --changed      # commit 档（同默认范围）
 *   node scripts/ci/check-copyright-readiness.js --range a..b
 *   node scripts/ci/check-copyright-readiness.js --all          # 全量基线（只报值，不判失败）
 *   node scripts/ci/check-copyright-readiness.js --explain      # 附判据说明
 *   node scripts/ci/check-copyright-readiness.js --json out.json
 *
 * Exit: S1（当前）恒 0；升 S3 后为 0 无 error / 1 有 error / 2 用法错误。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 本守卫**自身**的落地阶段（PROCESS-006 PP-1：守门人也要过观察期）。
 *
 * ⚠ 这个常量不是装饰：它是 FEATURE-OWNERSHIP.json 里 `copyright-readiness-guard`
 * 条目的 `executorStage.constant`，check-rollout-stage.js 会拿它跟登记表比对，
 * 漂移即报错。当前 S1 ⇒ 只记录不阻断（PP-3）。
 */
const STAGE = 'S1';

/** 内部严重度规范形：只有小写两种值。输出时才映射成定宽方言标签。 */
const SEV_ERROR = 'error';
const SEV_WARNING = 'warning';

/** 规范形 → 输出方言标签（ruleguard FINDING_LINE 要求 `ERROR` / `WARN ` 占 6 字符）。 */
const labelOf = (severity) => (severity === SEV_ERROR ? 'ERROR' : 'WARN ');

/** 是否已到「会拦截」的阶段（S3/S4）。 */
const HARD_STAGE = STAGE === 'S3' || STAGE === 'S4';

/** S1/S2 必须旁路记录：error 降级为 warning，且不影响退出码。 */
const degradeForStage = (severity) =>
  (severity === SEV_ERROR ? (HARD_STAGE ? SEV_ERROR : SEV_WARNING) : severity);

// ── 登记真源（不存在时不误伤，只报 info 指引）────────────────────────────
const REG_REL = 'docs/10_规范/registry/COPYRIGHT.json';
const MATERIALS_REL = 'docs/10_规范/registry/COPYRIGHT-MATERIALS.json';
const SSOT_REL = 'docs/10_规范/其它规范/[DESIGN-IP-001] 软件著作权就绪规范.md';

// ---------------------------------------------------------------- argv
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const RANGE = opt('--range', '');
const ALL = has('--all');
const EXPLAIN = has('--explain');
const JSON_OUT = opt('--json', '');

const findings = [];
/** 记录 finding 的**原始**严重度，供 --explain 显示「原本是 error」。 */
const add = (severity, finding, file, line, message) => {
  findings.push({
    severity: degradeForStage(severity),
    originalSeverity: severity,
    finding,
    file,
    line,
  });
  findings[findings.length - 1].message = message;
};

// ---------------------------------------------------------------- utils
const rel = (p) => path.relative(REPO_ROOT, p).replace(/\\/g, '/');
const read = (p) => {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
  } catch {
    return null;
  }
};

function git(args) {
  try {
    return execFileSync('git', ['-C', REPO_ROOT].concat(args), {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

/**
 * 遍历仓库文件。精度纪律①：**跳过一切点目录**（.khyos/.workbuddy/.ai/.git…）。
 * 它们是本机态，里面躺着 quarantine 副本、33 万行 Python 副本等，
 * 会把计数吹大好几倍（实测：不跳点目录 → `.vue` 命中从 19 涨到 33）。
 */
function walk(dir, depth, cb) {
  if (depth > 8) return;
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of items) {
    if (d.isDirectory()) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      walk(path.join(dir, d.name), depth + 1, cb);
    } else {
      cb(path.join(dir, d.name), d.name);
    }
  }
}

/** 真实行号定位：JSON 里某个 needle 首次出现的行号（抑制锚点要真行号）。 */
function lineOf(text, needle) {
  const idx = text.indexOf(needle);
  if (idx < 0) return 1;
  return text.slice(0, idx).split('\n').length;
}

/** 该文件是否是文档孪生页（有同名 .md 的 .html 是构建产物，不是界面）。 */
const isDocTwin = (full) => fs.existsSync(full.replace(/\.html$/i, '.md'));

// ══════════════════════════════════════════════════════════ 检查 1 · C-M3
// 不得把 AI 列为作者或共同作者 —— **只查新增提交，不碰历史**
//
// 本仓历史里已有 88 条 AI 署名提交，那是既成事实、**不改写 git 历史**
// （改写会破坏软著材料真实性）。门只从「现在」开始生效。
(function checkAuthorship() {
  const AI_RE =
    /co-authored-by:\s*[^\n<]*(claude|gpt|copilot|cursor|anthropic|openai|commandcode|codebuddy|gemini|qwen|deepseek)|generated with\s+\[?(claude|cursor|copilot|codebuddy|gemini)/i;

  let range = RANGE;
  if (!range && !ALL) {
    const up = git(['rev-parse', '--abbrev-ref', '@{upstream}']).trim();
    range = up ? `${up}..HEAD` : '';
  }
  if (!range && !ALL) {
    add(
      SEV_WARNING,
      'copyright-authorship-scope',
      'docs/10_规范/registry/RULES-REGISTRY.json',
      1,
      'C-M3：无法确定提交范围（没有上游分支）—— 请显式传 --range <base>..HEAD 或 --all。本次未检查提交署名。'
    );
    return;
  }

  const args = ['log', '--format=%H%x09%ad%x09%s%x09%b%x1e', '--date=short'];
  // 精度纪律②：--all 时必须显式传 --all 给 git log，否则全量基线会算错。
  if (ALL) args.push('--all');
  else args.push(range);

  const raw = git(args);
  const commits = raw.split('\x1e').map((s) => s.trim()).filter(Boolean);
  let total = 0;
  const bad = [];
  for (const c of commits) {
    if (!c.includes('\t')) continue;
    total++;
    const [hash, date, subject] = c.split('\t');
    if (AI_RE.test(c)) bad.push(`${hash.slice(0, 10)} ${date} ${subject}`);
  }

  if (ALL) {
    const pct = ((bad.length / (total || 1)) * 100).toFixed(1);
    findings.push({
      severity: SEV_WARNING,
      originalSeverity: SEV_WARNING,
      finding: 'copyright-authorship-baseline',
      file: SSOT_REL,
      line: 1,
      message:
        `C-M3 基线值（全量模式，**不判失败**）：${bad.length} 条提交含 AI 署名，占 ${total} 条的 ${pct}%。` +
        '这是既成事实，不改写历史；从此以后的新提交由本守卫挡。对账基准：官方 scan_copyright_readiness.py 的同一指标。',
    });
    return;
  }

  if (bad.length) {
    add(
      SEV_ERROR,
      'copyright-authorship',
      'docs/10_规范/registry/RULES-REGISTRY.json',
      1,
      `C-M3：${range} 范围内有 ${bad.length} 条提交含 AI 作者署名（禁止把 AI 列为作者或共同作者）。` +
        '修法：提交信息里删掉 Co-Authored-By: <AI> 一行即可，**代码不用动**。样本：' +
        bad.slice(0, 5).join(' / ')
    );
  }
})();

// ══════════════════════════════════════════════════════════ 检查 2 · C-X3
// 第三方 / 生成物不得作为登记材料的源程序
const EXCLUDE_DIRS = ['vendor', 'third_party', 'node_modules', 'dist', 'out', 'unpacked', 'dist-ts', 'release'];
const EXCLUDE_FILE = /(_gen\.|_blob\.h$|tools_gen_|cjk_font16\.h$|font.*\.h$|\.min\.js$|\.min\.css$)/i;

(function checkForbiddenMaterial() {
  const p = path.join(REPO_ROOT, MATERIALS_REL);
  if (!fs.existsSync(p)) {
    findings.push({
      severity: SEV_WARNING,
      originalSeverity: SEV_WARNING,
      finding: 'copyright-material-list',
      file: MATERIALS_REL,
      line: 1,
      message:
        `C-X3：未找到登记材料候选清单 ${MATERIALS_REL} —— 跳过本项。建了清单之后，` +
        '本守卫会自动核验「候选文件里没有第三方代码/生成物，且文件真实存在」。',
    });
    return;
  }

  let raw;
  let list;
  try {
    raw = fs.readFileSync(p, 'utf8');
    list = JSON.parse(raw);
  } catch (e) {
    add(SEV_ERROR, 'copyright-material-list-parse', MATERIALS_REL, 1, `C-X3：${MATERIALS_REL} 不是合法 JSON：${e.message}`);
    return;
  }

  const groups = ['前30页', '后30页', '中段（不提交，手册描述）'];
  const bad = [];
  let checked = 0;
  for (const g of groups) {
    for (const item of list[g] || []) {
      const f = typeof item === 'string' ? item : item && item.file;
      if (!f) continue;
      checked++;
      if (f.split('/').some((s) => EXCLUDE_DIRS.includes(s))) {
        bad.push(`${f}  ← 落在排除目录内`);
        continue;
      }
      if (EXCLUDE_FILE.test(path.basename(f))) {
        bad.push(`${f}  ← 命中排除文件模式（生成物/二进制 blob/字体数据表/压缩产物）`);
        continue;
      }
      if (!fs.existsSync(path.join(REPO_ROOT, f))) {
        bad.push(`${f}  ← 文件不存在（清单与实际脱节）`);
      }
    }
  }

  if (bad.length) {
    add(
      SEV_ERROR,
      'copyright-forbidden-material',
      MATERIALS_REL,
      lineOf(raw, '"前30页"'),
      `C-X3：登记材料候选里混入了不得提交的内容（第三方 vendor / 生成代码 / 二进制 blob / 字体数据表 / 压缩产物），或有文件已不存在。` +
        '这些内容进材料会直接导致「独创性」被质疑。明细：' +
        bad.slice(0, 8).join(' ｜ ')
    );
  } else if (checked) {
    findings.push({
      severity: SEV_WARNING,
      originalSeverity: SEV_WARNING,
      finding: 'copyright-material-ok',
      file: MATERIALS_REL,
      line: 1,
      message: `C-X3：已核验 ${checked} 个登记材料候选文件，未命中排除目录/模式，且全部真实存在。`,
    });
  }
})();

// ══════════════════════════════════════════════════════════ 检查 3 · C-MAT3
// 界面标识不得停留占位名（登记材料要放真实运行截图，截图上的名称必须与申请表一致）
const PLACEHOLDER = /^(demo|test|main window|untitled|未命名|未标题|placeholder|sample|app|vite app)$/i;

(function checkPlaceholders() {
  const hits = [];
  let scanned = 0;
  walk(REPO_ROOT, 0, (full, name) => {
    if (!/\.(html?|json)$/i.test(name)) return;
    const r = rel(full);
    if (/(^|\/)(docs?|node_modules|dist|out|coverage|build)\//.test(r)) return;
    if (/\.html$/i.test(name) && isDocTwin(full)) return; // 文档孪生页不是界面
    const c = read(r);
    if (c == null) return;
    const m = c.match(/<title>([^<]*)<\/title>/i);
    const pn = c.match(/"productName"\s*:\s*"([^"]*)"/);
    for (const v of [m && m[1], pn && pn[1]]) {
      if (!v) continue;
      scanned++;
      const t = v.trim();
      // 整标题精确匹配，不用子串 —— 否则 "KhyOS 测试台" 会被误判。
      if (PLACEHOLDER.test(t)) hits.push(`${r}:${lineOf(c, t)} ${JSON.stringify(t)}`);
    }
  });

  if (hits.length) {
    add(
      SEV_ERROR,
      'copyright-placeholder',
      SSOT_REL,
      1,
      `C-MAT3：${hits.length} 处界面标题/产品名仍是占位名（Demo / test / main window / 未命名）。` +
        '登记材料必须是真实界面且标题与申请表一致，占位名会让截图直接不可用。样本：' +
        hits.slice(0, 8).join(' ｜ ')
    );
  } else {
    findings.push({
      severity: SEV_WARNING,
      originalSeverity: SEV_WARNING,
      finding: 'copyright-placeholder-ok',
      file: SSOT_REL,
      line: 1,
      message: `C-MAT3：已检查 ${scanned} 处界面标题/产品名（整标题精确匹配），未发现占位名。`,
    });
  }
})();

// ═══════════════════════════════════════════════════ 检查 4/5 · C-MAT2 / C-MAT3
// 名称与版本的一致性（需要登记真源；未登记时只给指引，不误伤）
(function checkNameConsistency() {
  const raw = read(REG_REL);
  if (raw == null) {
    findings.push({
      severity: SEV_WARNING,
      originalSeverity: SEV_WARNING,
      finding: 'copyright-registry-missing',
      file: REG_REL,
      line: 1,
      message:
        `C-MAT2：未找到登记真源 ${REG_REL}（须含 {"name":"<软件全称>","version":"<版本号>"}）。` +
        '定名后建立该文件，本守卫即可自动核验「界面标题 / README / pyproject 与登记名称是否一致」。',
    });
    return;
  }

  let reg;
  try {
    reg = JSON.parse(raw);
  } catch (e) {
    add(SEV_ERROR, 'copyright-registry-parse', REG_REL, 1, `C-MAT2：${REG_REL} 不是合法 JSON：${e.message}`);
    return;
  }

  const NAME = reg.name;
  const VER = reg.version;
  if (!NAME) {
    add(SEV_ERROR, 'copyright-registry-name', REG_REL, lineOf(raw, '"name"'), `C-MAT2：${REG_REL} 缺少 "name" 字段。`);
    return;
  }

  // ── 界面标题必须等于登记全称
  const mism = [];
  walk(REPO_ROOT, 0, (full, name) => {
    if (!/\.html$/i.test(name)) return;
    const r = rel(full);
    if (/(^|\/)(node_modules|dist|out|coverage|build)\//.test(r)) return;
    if (/(^|\/)docs\//.test(r)) return;
    if (isDocTwin(full)) return;
    const c = read(r);
    if (c == null) return;
    const m = c.match(/<title>([^<]*)<\/title>/i);
    if (!m) return;
    const t = m[1].trim();
    if (t && t !== NAME) mism.push(`${r}:${lineOf(c, t)} → ${JSON.stringify(t)}`);
  });

  // ── README / pyproject 必须出现登记全称（C-MAT2 的「五处一致」）
  for (const f of ['README.md', 'pyproject.toml']) {
    const c = read(f);
    if (c == null) continue;
    if (!c.includes(NAME)) mism.push(`${f}:1 → 未出现登记全称 ${JSON.stringify(NAME)}`);
  }

  if (mism.length) {
    add(
      SEV_WARNING, // 名称统一是「改名工程」，不是逐条 bug；S1 记录、升阶后才挡
      'copyright-name-consistency',
      REG_REL,
      lineOf(raw, '"name"'),
      `C-MAT2/C-MAT3：${mism.length} 处名称与登记全称不一致。**这是「软件名称与功能不符 / 材料不一致」补正的典型原因。**` +
        '改法：只改标题/文档/元数据，不要改代码逻辑（顺序铁律：先改名 → 再截图 → 再出材料）。明细：' +
        mism.slice(0, 8).join(' ｜ ')
    );
  }

  // ── 版本：工程版本与登记版本的大版本必须对得上（说明书里要写对应关系）
  if (VER) {
    const py = read('pyproject.toml') || '';
    const m = py.match(/^version\s*=\s*["']([^"']+)["']/m);
    const major = String(VER).replace(/^V/i, '').split('.')[0];
    if (m && !String(m[1]).startsWith(major)) {
      add(
        SEV_WARNING,
        'copyright-version',
        'pyproject.toml',
        lineOf(py, 'version'),
        `C-MAT2：工程版本 ${m[1]} 与登记版本 ${VER} 的大版本不一致 —— 须在说明书中写明对应关系` +
          '（官方原文：鉴别材料页眉的版本号须与申请表一致，有无 V 以申请表为准）。'
      );
    }
  }
})();

// ══════════════════════════════════════════════════════════ 检查 6 · C-X2
// <style> 块占比过半的 .vue —— 抽取时会挤掉有效代码行
// （对账基准：官方 scan_copyright_readiness.py 同一指标；实测 19 = 19）
(function checkVueStyle() {
  const hits = [];
  walk(REPO_ROOT, 0, (full, name) => {
    if (!/\.vue$/i.test(name)) return;
    const r = rel(full);
    const c = read(r);
    if (c == null) return;
    const styleLen = (c.match(/<style[\s\S]*?<\/style>/gi) || []).join('\n').split('\n').length;
    const total = c.split('\n').length;
    if (total > 20 && styleLen / total >= 0.5) {
      hits.push(`${r}:1 style ${styleLen}/${total} 行（${Math.round((styleLen / total) * 100)}%）`);
    }
  });

  if (hits.length) {
    add(
      SEV_WARNING,
      'copyright-vue-style',
      SSOT_REL,
      1,
      `C-X2：${hits.length} 个 .vue 文件的 <style> 块占比 ≥50%。样式块是「占位内容」，会挤掉真正体现功能的逻辑代码，` +
        '导致抽取前/后 30 页时有效行数不达标（官方口径：每页不少于 50 行）。抽取时剥离即可，**不必改源文件**。样本：' +
        hits.slice(0, 8).join(' ｜ ')
    );
  }
})();

// ══════════════════════════════════════════════════════════ 检查 7 · C-E4
// evidence/ 自留底档（AI 参与范围自述 / 设计决策索引 / 发布记录）
// 主动记录比被追问好：被要求补充开发过程说明时，它就是「如实申报」的证据。
(function checkEvidence() {
  const gi = read('.gitignore') || '';
  const ignored = /^\s*evidence\/?\s*$/m.test(gi);
  const localDir = fs.existsSync(path.join(REPO_ROOT, 'evidence'));

  // 底档可以放在仓库内（evidence/，须 gitignore）或**仓库外**（交付目录）。
  // 后者由 COPYRIGHT.json 的 evidence 段登记指针 —— 登记了即视为满足。
  // 这条分支是必要的：本仓的登记材料全部在仓库外（避免污染仓库层级），
  // 只认仓库内 evidence/ 会把「已经做了留痕」误报成「没做」。
  const regRaw = read(REG_REL);
  if (regRaw) {
    try {
      const reg = JSON.parse(regRaw);
      const ev = reg.evidence || {};
      const outOfRepo = Object.entries(ev)
        .filter(([k, v]) => !k.startsWith('$') && typeof v === 'string' && v)
        .map(([, v]) => v);
      if (outOfRepo.length) {
        // 登记者须是真实存在的路径（防「登记一个不存在的目录」当作已留痕）
        const alive = outOfRepo.filter((p) => fs.existsSync(p));
        if (alive.length) {
          findings.push({
            severity: SEV_WARNING,
            originalSeverity: SEV_WARNING,
            finding: 'copyright-evidence-ok',
            file: REG_REL,
            line: lineOf(regRaw, '"evidence"'),
            message: `C-E4：自留底档登记为仓库外路径，已核验存在（${alive.length}/${outOfRepo.length} 处）：${alive.slice(0, 3).join(' ｜ ')}（路径在本机，CI 上不存在时本项会退化为提示而非报错）。底档不入提交是设计意图，不是遗漏。`,
          });
          return;
        }
        add(
          SEV_WARNING,
          'copyright-evidence-registry',
          REG_REL,
          lineOf(regRaw, '"evidence"'),
          'C-E4：COPYRIGHT.json 的 evidence 段登记了路径，但**没有一处真实存在** —— 这等于「声明已留痕却没留」。修法：改正路径，或补出底档。'
        );
        return;
      }
    } catch {
      /* JSON 非法由 C-MAT2 那一段报，这里不重复 */
    }
  }

  if (!localDir) {
    findings.push({
      severity: SEV_WARNING,
      originalSeverity: SEV_WARNING,
      finding: 'copyright-evidence',
      file: '.gitignore',
      line: 1,
      message:
        'C-E4：找不到自留底档。两种合规做法任选其一：① 仓库内建 evidence/（含 ai-usage.md / design-decisions.md / release-history.md）并加入 .gitignore；' +
        '② 底档放仓库外，在 ' + REG_REL + ' 的 evidence 段登记路径。底档是「被追问时如实申报」的依据 —— 主动记录比被追问好。',
    });
    return;
  }
  if (!ignored) {
    add(
      SEV_ERROR,
      'copyright-evidence-ignored',
      '.gitignore',
      1,
      'C-E4：evidence/ 存在但未加入 .gitignore —— 它是**自留底档**，不应进提交（进了提交反而暴露内部记录）。'
    );
  }
})();

// ══════════════════════════════════════════════════════ 检查 8 · 自我体检
// 本守卫自身不得成为「死指针」
(function checkSsotAlive() {
  if (!fs.existsSync(path.join(REPO_ROOT, SSOT_REL))) {
    add(
      SEV_WARNING,
      'copyright-ssot-dangling',
      SSOT_REL,
      1,
      '守卫引用的真源文档不存在 —— 死指针。守卫读不到判据就会「永远通过」，比没有守卫更糟。'
    );
  }
})();

// ---------------------------------------------------------------- 输出
const errors = findings.filter((f) => f.severity === SEV_ERROR);
const warnings = findings.filter((f) => f.severity === SEV_WARNING);
const verbose = !has('--changed');

if (verbose) {
  process.stdout.write('check-copyright-readiness: 软著就绪守卫（真源 [DESIGN-IP-001]，规则 PROCESS-010）\n');
  process.stdout.write(`mode: STAGE=${STAGE} ${ALL ? '全量基线' : 'RANGE=' + (RANGE || '@{upstream}..HEAD')}\n`);
  process.stdout.write('result:\n');
}

if (!findings.length) {
  if (verbose) process.stdout.write('  ✅ 软著就绪：无 finding。\n');
} else {
  for (const f of [...errors, ...warnings]) {
    process.stdout.write(`[${labelOf(f.severity)}] ${f.finding} ${f.file}:${f.line || 1}\n`);
    if (verbose) process.stdout.write(`  ${f.message}\n`);
  }
}

if (verbose && !HARD_STAGE) {
  const downgraded = findings.filter((f) => f.originalSeverity === SEV_ERROR).length;
  if (downgraded) {
    process.stdout.write(
      `  （其中 ${downgraded} 条原本是 error，S1「观察者」阶段按 [DESIGN-PROCESS-002] PP-3 降级为 WARN 且不拦截）\n`
    );
  }
}

if (EXPLAIN && verbose) {
  process.stdout.write('\n判据（真源 [DESIGN-IP-001]）：\n');
  process.stdout.write('  C-M3  人的意愿可追溯：提交不得把 AI 列为作者（只查新增提交，不碰历史 88 条）\n');
  process.stdout.write('  C-X3  第三方代码不进登记材料：vendor/third_party/dist/out/*_gen.*/*_blob.h/字体表/压缩产物\n');
  process.stdout.write('  C-MAT3 界面标识不得停留占位名：Demo/test/main window/未命名\n');
  process.stdout.write('  C-MAT2 名称与版本五处一致：申请材料 / 源程序页眉 / 说明书封面 / 界面标题 / README\n');
  process.stdout.write('  C-X2  产出可解释：.vue 样式块占比过半会挤掉有效代码行（抽取时剥离即可）\n');
  process.stdout.write('  C-E4  证据留痕：evidence/ 自留底档（AI 参与范围自述）\n');
  process.stdout.write('  机器判不了、故意不设守卫：C-M4 痕迹内容是否成立、C-X1 随机抽 3 处能解释 → 人工评审\n');
}

process.stdout.write(`Summary: ${errors.length} error(s), ${warnings.length} warning(s).\n`);

if (JSON_OUT) {
  fs.writeFileSync(
    path.resolve(JSON_OUT),
    JSON.stringify(
      {
        repo: REPO_ROOT,
        stage: STAGE,
        range: RANGE,
        all: ALL,
        counts: { error: errors.length, warning: warnings.length },
        findings,
      },
      null,
      2
    ),
    'utf8'
  );
}

// 阶段门：S1/S2 恒放行（PP-3「S1/S2 必须旁路记录，禁止阻断主流程」）。
if (!HARD_STAGE) process.exit(0);
if (errors.length) process.exit(1);
if (has('--strict-warnings') && warnings.length) process.exit(1);
process.exit(0);
