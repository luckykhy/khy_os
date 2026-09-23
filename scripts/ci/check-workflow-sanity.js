#!/usr/bin/env node
/**
 * scripts/ci/check-workflow-sanity.js
 *
 * GitHub Actions 工作流的「本地前置体检」——在 push 之前抓住那些
 * 只能等 CI 跑完才发现的失败。
 *
 * 为什么需要它：本仓库的 workflow 失败史里，绝大多数不是业务问题，
 * 而是下面这些**静态就能看出来**的问题。它们在 push 后表现为
 * 「所有 job 都报错 / 立刻失败」，排查成本却很高。
 *
 * 检查项：
 *   1. YAML 可解析                       —— 解析都失败，GitHub 直接拒绝运行
 *   2. step name 里的裸冒号              —— YAML 会当成嵌套映射，整个文件废掉
 *   3. pnpm/action-setup 未写 version    —— 依赖隐式探测，易与 corepack 打架
 *   4. install:core 与 pnpm version 漂移 —— corepack 会下载第二个 pnpm
 *   5. --frozen-lockfile 与锁文件存在性  —— 锁文件缺失 = 必然失败
 *   6. Ubuntu runner 上的 Windows 路径   —— D:\ / C:\ 在 linux 上不存在
 *   7. 双包管理器（pnpm 声明 + npm 锁）  —— 两份锁文件构成版本漂移源（warning）
 *   8. 探针端点三方一致性                —— 工作流 / fly checks 漂移 = 冒烟必然红
 *   9. 镜像 tag 与仓库路径一致性         —— 部署拿到非本次构建的镜像
 *
 * 用法：
 *   node scripts/ci/check-workflow-sanity.js            # 检查全部
 *   node scripts/ci/check-workflow-sanity.js --changed  # 只检查改动的工作流
 *
 * 退出码：0 通过；1 有 error 级发现（warning 不阻断）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');

const findings = [];
function report(level, file, line, msg) {
  findings.push({ level, file, line, msg });
}

/**
 * 极简 YAML 解析：只够用来判断文件能否被 GitHub 解析。
 * 不追求完整实现 —— 真正的判据是「有没有结构性的语法错误」。
 * 没有 yaml 依赖时降级为「不检查 YAML 结构」，而不是崩溃。
 */
function parseYaml(text) {
  let yaml = null;
  try {
    yaml = require('js-yaml');
  } catch {
    return { ok: true, skipped: true };
  }
  try {
    yaml.load(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

function listWorkflowFiles(changedOnly) {
  if (!changedOnly) {
    return fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
  }
  // 已暂存 + 未暂存的改动，取相对仓库根的路径。
  const out = new Set();
  const tryGit = (args) => {
    try {
      const s = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
      return s.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  for (const line of [...tryGit(['diff', '--name-only']), ...tryGit(['diff', '--cached', '--name-only'])]) {
    const norm = line.replace(/\\/g, '/');
    if (norm.startsWith('.github/workflows/') && /\.ya?ml$/.test(norm)) {
      out.add(path.basename(norm));
    }
  }
  return [...out];
}

/**
 * 检查 step name 中的裸冒号。
 * `- name: Smoke test: health returns 200` 会被 YAML 解析成
 * {name: "Smoke test", "health returns 200": null}，整个 workflow 失效。
 * 合法写法是给整个 name 加引号。
 *
 * ⚠️ 判据必须精确到「**冒号后跟空格**」(`: `)，不能用 `:\S`：
 *   `Runtime tests (node:test)` 里的冒号后紧跟字母，YAML 把它当普通标量，
 *   文件完全合法（已实测：frontend-ci.yml 解析成功、GitHub 接受）。
 *   用 `:\S` 会把它误判成 error —— 而误报比漏报更贵（公理 A4）：
 *   一条假 error 会挡住所有人，还会训练大家忽略这条检查。
 *   真正的破坏场景只有「冒号后是空格或行尾」，那才构成 key: value 歧义。
 */
function checkBareColonInStepName(text, file) {
  const lines = text.split('\n');
  lines.forEach((raw, idx) => {
    const m = raw.match(/^(\s*-\s*name:\s*)(.*)$/);
    if (!m) return;
    const value = m[2];
    // 已加引号的跳过。
    if (/^["'].*["']\s*$/.test(value.trim())) return;
    // 值里若有「冒号 + 空格」或「冒号 + 行尾」→ 会被解析成嵌套映射。
    if (/:\s/.test(value) || /:\s*$/.test(value)) {
      report(
        'error',
        file,
        idx + 1,
        `step name 含未加引号的冒号（冒号后跟空格），YAML 会把它解析成嵌套映射，` +
          `整个 workflow 会失效。请写成 - name: "${value.trim()}"`
      );
    }
  });
}

/** 检查 pnpm/action-setup 是否显式声明 version。 */
function checkPnpmVersionPinned(text, file) {
  const lines = text.split('\n');
  lines.forEach((raw, idx) => {
    if (!/pnpm\/action-setup@/.test(raw)) return;
    // 向后看最多 8 行，找 with: version:
    const window = lines.slice(idx, idx + 9).join('\n');
    if (!/^\s*version:/m.test(window)) {
      report(
        'warning',
        file,
        idx + 1,
        `pnpm/action-setup 未显式写 version，会依赖 action 隐式探测 packageManager。` +
          `建议写死 version，与根 package.json 的 packageManager 保持一致。`
      );
    }
  });
}

/** 检查 workflow 里 pnpm version 与根 packageManager 是否一致。 */
function checkPnpmVersionDrift(text, file, rootPackageManager) {
  if (!rootPackageManager) return;
  const m = rootPackageManager.match(/^pnpm@(.+)$/);
  if (!m) return;
  const declared = m[1];
  const lines = text.split('\n');
  lines.forEach((raw, idx) => {
    const v = raw.match(/^\s*version:\s*["']?([\d.]+)["']?\s*$/);
    if (!v) return;
    // 只在 pnpm/action-setup 附近才判定为 pnpm 版本。
    const before = lines.slice(Math.max(0, idx - 8), idx).join('\n');
    if (!/pnpm\/action-setup@/.test(before)) return;
    if (v[1] !== declared) {
      report(
        'warning',
        file,
        idx + 1,
        `pnpm version ${v[1]} 与根 package.json 的 packageManager (pnpm@${declared}) 不一致：` +
          `corepack 会另外下载一个 pnpm，导致安装阶段出现难查的失败。请对齐两者。`
      );
    }
  });
}

/** 用到 --frozen-lockfile 时，锁文件必须存在且被跟踪。 */
function checkFrozenLockfile(text, file) {
  const usesFrozen =
    /--frozen-lockfile/.test(text) || /install:core\b/.test(text) || /install:prod\b/.test(text);
  if (!usesFrozen) return;
  const lock = path.join(ROOT, 'pnpm-lock.yaml');
  if (!fs.existsSync(lock)) {
    report(
      'error',
      file,
      0,
      `工作流依赖 --frozen-lockfile 安装，但仓库根目录没有 pnpm-lock.yaml —— 必然失败。`
    );
  }
}

/** linux runner 上出现 Windows 盘符路径。 */
function checkWindowsPaths(text, file) {
  const lines = text.split('\n');
  lines.forEach((raw, idx) => {
    if (/runs-on:.*windows/.test(text)) return; // windows runner 是合法的
    if (/\b[A-Za-z]:[\\/]/.test(raw) && !/^\s*#/.test(raw)) {
      report(
        'error',
        file,
        idx + 1,
        `在非 Windows runner 上出现 Windows 盘符路径（${raw.trim().slice(0, 60)}），` +
          `该路径在 linux 上不存在。`
      );
    }
  });
}

/**
 * 双包管理器守卫：根 packageManager 声明了 pnpm，仓库里却还躺着
 * package-lock.json（npm 的锁文件）。
 *
 * ⚠️ 这个是「**已评估并接受的**现状」，不是缺陷 —— 判读前请先读这段：
 *
 *   `scripts/ci/check-dependency-size.js` **依赖** package-lock.json 作为
 *   依赖包数的**唯一计数源**（见该脚本头部「计数源为什么还是 package-lock.json」）。
 *   它明确选择了 npm 锁文件，理由是 package-lock.json 是**平铺**结构，
 *   一个条目 = 一个包，计数无歧义；而 pnpm-lock.yaml 是内容寻址的 snapshots，
 *   同一个包在不同 peer 组合下会出现多条，绝对值难以解释。
 *   该脚本 + `scripts/ci/dependency-size-baseline.json` 基线是真实在跑的预算门
 *   （实测 `npm run check:dep-size` → 「全部在预算内」）。
 *
 *   因此：**不要**因为看到两份锁文件就 `git rm --cached package-lock.json`
 *   —— 那会直接打断 check:dep-size。要退役它，必须先按该脚本头部说明
 *   把计数源换成 pnpm-lock.yaml 并重建基线（另有前置条件：脚本将不再是零依赖）。
 *
 * 仍然报 warning 的理由：两份锁文件确实构成**潜在的**漂移面（本地谁跑一次
 * `npm install` 不保证与 pnpm 树一致），值得在改动依赖时被提醒核对。
 * 但请把这条当作「知情提醒」，不是「待修的错」。
 *
 * 判级 warning 而非 error：本仓库纪律是「warning 不阻断」。只报一次
 * （属性属于「仓库」而非「某个 workflow」），否则 12 个文件各报一遍会把
 * 真正要看的那几条淹掉 —— 误报比漏报更贵。
 */
function checkDualLockfileOnce(rootPackageManager) {
  if (!rootPackageManager || !/^pnpm@/.test(rootPackageManager)) return;
  const npmLock = path.join(ROOT, 'package-lock.json');
  if (!fs.existsSync(npmLock)) return;

  // 若依赖体积检查器在场，说明双锁文件是**有意**的，降级措辞、不再建议删除。
  const depSize = path.join(ROOT, 'scripts', 'ci', 'check-dependency-size.js');
  const intentional = fs.existsSync(depSize);

  report(
    'warning',
    'package.json',
    0,
    intentional
      ? `根 packageManager 为 ${rootPackageManager}，但 package-lock.json 仍在且被跟踪。` +
        `这是**已知并接受**的现状：scripts/ci/check-dependency-size.js 用它当依赖包数的计数源` +
        `（平铺结构计数无歧义），退役它必须先迁移该脚本的计数源并重建基线，` +
        `**不要直接 git rm --cached**。改动依赖时请留意两份锁文件的一致性。`
      : `根 packageManager 声明为 ${rootPackageManager}，但仓库里同时存在 package-lock.json（npm 锁文件）。` +
        `两份锁文件可能解析出不同依赖树，构成版本漂移源；CI 只用 pnpm-lock.yaml。` +
        `建议确认无使用方后让 package-lock.json 退出跟踪并补 .gitignore。`
  );
}

/**
 * 探针端点一致性：deploy-staging 的 smoke / wait 步用了 HEALTH_PATH，
 * 必须与 fly.staging.toml 的 http_service.checks.path 指向同一个端点。
 * 三者（server.js 路由、fly checks、workflow curl）漂移 = 必然红。
 */
function checkProbeEndpointConsistency(text, file) {
  // 只对含 HEALTH_PATH 的工作流生效（即 deploy-staging 这类会探活的工作流）。
  const used = new Set();
  const re = /HEALTH_PATH:\s*(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) used.add(m[1]);
  if (used.size === 0) return;

  const flyPath = path.join(ROOT, 'fly.staging.toml');
  if (!fs.existsSync(flyPath)) {
    report(
      'error',
      file,
      0,
      `工作流用 HEALTH_PATH 探活，但找不到 fly.staging.toml，无法核对探针端点是否一致。`
    );
    return;
  }
  const fly = fs.readFileSync(flyPath, 'utf8');
  const checks = [...fly.matchAll(/path\s*=\s*["']([^"']+)["']/g)].map((x) => x[1]);
  if (checks.length === 0) {
    report(
      'error',
      file,
      0,
      `工作流用 HEALTH_PATH 探活，但 fly.staging.toml 没有 [[http_service.checks]] 的 path。` +
        `Fly 不会在切流量前摘掉不健康机器，且探针端点无从对齐。`
    );
    return;
  }
  for (const usedPath of used) {
    if (!checks.includes(usedPath)) {
      report(
        'error',
        file,
        0,
        `探针端点漂移：工作流 HEALTH_PATH=${usedPath}，但 fly.staging.toml 的 checks.path = ${checks.join(', ')}。` +
          `两端不一致会导致「Fly 认为健康」与「workflow 认为健康」判据不同 → 冒烟必然红。`
      );
    }
  }
}

/**
 * 镜像 tag 一致性：workflow 里 build-push 的 tag 必须与 fly 配置拉取的
 * image 指向同一路径与 tag。
 *
 * 历史事故：workflow 推 `ghcr.io/<repo>:staging`，fly.staging.toml 写
 * `ghcr.io/khy-os/khy-os:main` —— tag 与仓库路径**双重不一致**，
 * 结果「部署成功」但跑的根本不是本次构建，静默且难查。
 */
function checkImageTagConsistency(text, file) {
  const flyPath = path.join(ROOT, 'fly.staging.toml');
  if (!fs.existsSync(flyPath)) return;

  // 只取**镜像构建产物**的 tag，不能误抓触发器的 `on.push.tags: [v*]`。
  // 判据：该行的值含 `ghcr.io/`（是镜像引用而非 git tag glob）。
  // 值可能含空格（`ghcr.io/${{ github.repository }}:staging`），
  // 因此取到**行尾**再剥掉注释，而不是 `\S+` 截断。
  const pushed = [];
  for (const m of text.matchAll(/^\s*tags:\s*(.+?)\s*$/gm)) {
    let val = m[1].replace(/\s+#.*$/, '').trim();
    val = val.replace(/^["']|["']$/g, '');
    if (val.includes('ghcr.io/')) pushed.push(val);
  }
  if (pushed.length === 0) return;

  const fly = fs.readFileSync(flyPath, 'utf8');
  const img = fly.match(/image\s*=\s*["']([^"']+)["']/);
  if (!img) return;
  const flyImage = img[1];

  // tag = **最后一个冒号之后**的部分，但必须先跳过 `${{ ... }}` 里的冒号。
  const tagOf = (s) => {
    const cleaned = s.replace(/\$\{\{[^}]*\}\}/g, 'PLACEHOLDER');
    return cleaned.slice(cleaned.lastIndexOf(':') + 1);
  };
  const flyTag = tagOf(flyImage);
  const pushedTags = pushed.map(tagOf);

  // 占位符路径（${{ github.repository }}）解析后 tag 仍是可比的字面量；
  // 若 workflow 侧全是占位符导致的 PLACEHOLDER，则跳过逐字比对。
  const comparable = pushedTags.filter((t) => t && t !== 'PLACEHOLDER');
  if (comparable.length > 0 && !comparable.includes(flyTag)) {
    report(
      'error',
      file,
      0,
      `镜像 tag 不一致：workflow 推 ${comparable.map((t) => `:${t}`).join(', ')}，` +
        `但 fly.staging.toml 拉 :${flyTag}。部署将拿到非本次构建的镜像（或拉取失败）。`
    );
  }

  // 占位符场景下核对「仓库路径」是否同源：workflow 用 ${{ github.repository }}
  // 时无法静态展开，只能要求 fly 侧**不要**硬编码一个无关路径。
  const usesPlaceholder = /ghcr\.io\/\$\{\{\s*github\.repository\s*\}\}/.test(text);
  if (usesPlaceholder && !flyImage.includes('$')) {
    const flyRepo = flyImage.replace(/^ghcr\.io\//, '').replace(/:[^:]+$/, '');
    // 本仓实际仓库名为 luckykhy/khy_os（见 git remote）。硬编码其它路径即为漂移。
    if (!/luckykhy\/khy_os$/.test(flyRepo)) {
      report(
        'warning',
        file,
        0,
        `fly.staging.toml 的 image 仓库路径为 ${flyRepo}，而 workflow 用 \${{ github.repository }}` +
          `（本仓解析为 luckykhy/khy_os）。若两者不同源，部署会拉到不存在或旧的镜像。`
      );
    }
  }
}

function main() {
  const changedOnly = process.argv.includes('--changed');

  if (!fs.existsSync(WF_DIR)) {
    console.log('未找到 .github/workflows 目录，跳过。');
    process.exit(0);
  }

  let rootPackageManager = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    rootPackageManager = pkg.packageManager || null;
  } catch {
    /* 没有根 package.json 就跳过漂移检查 */
  }

  const files = listWorkflowFiles(changedOnly);
  if (files.length === 0) {
    console.log('📋 Workflow 体检：无待检查文件。');
    process.exit(0);
  }

  for (const file of files) {
    const full = path.join(WF_DIR, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');

    const parsed = parseYaml(text);
    if (!parsed.ok) {
      report('error', file, 0, `YAML 解析失败：${parsed.err.split('\n')[0]}`);
      continue; // 解析不了就没必要做后续检查
    }

    checkBareColonInStepName(text, file);
    checkPnpmVersionPinned(text, file);
    checkPnpmVersionDrift(text, file, rootPackageManager);
    checkFrozenLockfile(text, file);
    checkWindowsPaths(text, file);
    checkProbeEndpointConsistency(text, file);
    checkImageTagConsistency(text, file);
  }

  // 仓库级检查：只跑一次，不随 workflow 数量重复。
  checkDualLockfileOnce(rootPackageManager);

  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warning');

  if (errors.length === 0 && warnings.length === 0) {
    console.log(`✅ Workflow 体检通过（检查了 ${files.length} 个文件）。`);
    process.exit(0);
  }

  for (const f of findings) {
    const tag = f.level === 'error' ? '❌' : '⚠️ ';
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`${tag} ${loc}\n   ${f.msg}\n`);
  }

  console.log(
    `Workflow 体检：${errors.length} 个 error，${warnings.length} 个 warning（共 ${files.length} 个文件）。`
  );

  // warning 不阻断：本仓库的历史教训是「把所有 warning 升为 error」
  // 会事实上禁止任何稍大的改动（见 pr-gate.yml 里 check-change-safety
  // 那段的注释）。这里只拦 error。
  process.exit(errors.length > 0 ? 1 : 0);
}

main();
