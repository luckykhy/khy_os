'use strict';

// @leaf
// Fresh-machine off-machine-restore self-check surfaced in `khy doctor`.
//
// WHY THIS EXISTS (farewell-gift capstone): pip and npm are the only two
// off-machine channels. A landing developer/user/maintainer on a *fresh* machine
// needs ONE human-readable command that says, in plain words, WHAT is wrong with
// their install and HOW to fix it — "真实原因 + 解决方法". The build-time restore
// mirrors (scripts/lib/restoreReadiness / installIntegrity / hydrationHealth) are
// NOT shipped in the bundle and agent-facing restore-plan emits JSON for agents.
// This leaf is the SHIPPED, HUMAN-facing complement: it runs on the installed
// machine using only runtime-available facts and appends a "离机还原自检" category
// to `khy doctor`, each failing check carrying its root cause and exact fix.
//
// Concerns mirrored here (runtime-observable subset):
//   * 启动入口  — the bin/khy.js the pip/npm shell exec's (bundle-launch-contract)
//   * 服务入口  — server.js (bundle-launch-contract)
//   * 依赖水合  — node_modules present AND non-empty (hydration-health)
//   * khy 可达  — `khy` on PATH, else the `python -m khy_platform` fallback
//                 (same PATH-stripped root cause as the tray click no-op fix)
//
// Design: PURE assessor (`assessFreshInstall(facts)`) takes already-gathered facts
// and never touches IO or throws; a thin IO gatherer (`gatherFreshInstallFacts`)
// probes the filesystem/PATH and is fully dependency-injectable for tests. Gated
// `KHY_DOCTOR_FRESH_INSTALL` default-on (0/false/off/no → byte-revert: doctor
// shows nothing new).
//
// HOW-TO-EXTEND: to add a concern, (1) gather its boolean/string fact in
// `gatherFreshInstallFacts`, (2) push a check for it in `assessFreshInstall` using
// `_check(...)` + `_causeFix(cause, fix)`, (3) add a node:test case asserting both
// the ok and the failing (cause+fix embedded) shapes. Keep the assessor pure.

const path = require('path');

const CATEGORY = '离机还原自检';
const _FALSY = new Set(['0', 'false', 'off', 'no']);

// Gate: default-on. Only 0/false/off/no disable. Read env directly (sibling gate;
// not registered in flagRegistry, which would return default-on and ignore 'off').
function _gateEnabled(env) {
  const v = (env || {}).KHY_DOCTOR_FRESH_INSTALL;
  if (v === undefined || v === null) {
    return true;
  }
  return !_FALSY.has(String(v).trim().toLowerCase());
}

// Sub-gate for the proxy-core download hint (check #5). default-on; only
// 0/false/off/no disable. Independent of KHY_DOCTOR_FRESH_INSTALL so the hint can
// be silenced alone (byte-revert: the prior four checks stay byte-for-byte
// unchanged). Same direct-env-read rationale as _gateEnabled.
function _proxyCoreHintEnabled(env) {
  const v = (env || {}).KHY_DOCTOR_PROXY_CORE_HINT;
  if (v === undefined || v === null) {
    return true;
  }
  return !_FALSY.has(String(v).trim().toLowerCase());
}

// Sub-gate for the dual-channel version-parity hint (check #6). default-on; only
// 0/false/off/no disable. Independent of the other gates so it can be silenced
// alone (byte-revert: the prior checks stay byte-for-byte unchanged). This flag IS
// declared in flagRegistry (KHY_DUAL_INSTALL_CHECK, default-on) but had no consumer
// — wiring this check makes that declared-but-orphan gate real. Read env directly
// (same rationale as the sibling sub-gates: honor 'off' without a registry round-trip).
function _dualInstallCheckEnabled(env) {
  const v = (env || {}).KHY_DUAL_INSTALL_CHECK;
  if (v === undefined || v === null) {
    return true;
  }
  return !_FALSY.has(String(v).trim().toLowerCase());
}

// Best-effort install-channel detection from the bundle root path shape. pip wheels
// nest the bundle under Python site-packages (or the khy_platform package dir); npm
// installs it under node_modules; a dev/source checkout is neither. Pure, no IO.
function _detectChannel(root) {
  const p = String(root || '')
    .replace(/\\/g, '/')
    .toLowerCase();
  if (p.includes('/site-packages/') || p.includes('khy_platform')) {
    return 'pip';
  }
  if (p.includes('/node_modules/')) {
    return 'npm';
  }
  return 'source';
}

function _causeFix(cause, fix) {
  return `原因：${cause}　解决方法：${fix}`;
}

function _check(label, ok, detail, level) {
  return {
    category: CATEGORY,
    label,
    ok: !!ok,
    detail: String(detail || ''),
    level: level || 'error',
  };
}

/**
 * Pure diagnosis: turn gathered facts into `khy doctor`-shaped checks, each
 * failing one carrying "原因 … 解决方法 …". Never throws, never does IO.
 *
 * @param {object} facts  output of gatherFreshInstallFacts
 * @returns {Array<{category,label,ok,detail,level}>}
 */
function assessFreshInstall(facts) {
  try {
    const f = facts || {};
    const checks = [];

    // 1. Launch entry — the script the pip/npm shell exec's on every `khy`.
    checks.push(
      _check(
        '启动入口 bin/khy.js',
        f.binEntryPresent,
        f.binEntryPresent
          ? '启动脚本完整'
          : _causeFix(
              'pip/npm 包的启动脚本 bin/khy.js 缺失（半装中断或安全软件误删），首启即 exec 失败',
              'pip install --force-reinstall khy-os  （npm：重装 @khy-os/khy-os）'
            ),
        'error'
      )
    );

    // 2. Server entry.
    checks.push(
      _check(
        '服务入口 server.js',
        f.serverEntryPresent,
        f.serverEntryPresent
          ? '服务入口完整'
          : _causeFix(
              '后端服务入口 server.js 缺失（同上，包不完整）',
              'pip install --force-reinstall khy-os  （npm：重装 @khy-os/khy-os）'
            ),
        'error'
      )
    );

    // 3. Dependency hydration — node_modules must exist AND be non-empty.
    const hydrated = f.nodeModulesPresent && f.hydrationSentinelPresent;
    checks.push(
      _check(
        '依赖水合 node_modules',
        hydrated,
        hydrated
          ? '依赖已水合'
          : _causeFix(
              f.nodeModulesPresent
                ? 'node_modules 存在但是空壳（首启依赖水合中断）'
                : 'node_modules 缺失（首启依赖水合尚未完成）',
              '在项目根运行 `khy`（触发首启水合）或 `npm install`'
            ),
        'error'
      )
    );

    // 4. khy command reachability — same PATH-stripped root cause as the tray fix.
    checks.push(
      _check(
        'khy 命令可达',
        f.khyOnPath,
        f.khyOnPath
          ? `已在 PATH（${f.khyResolvedName || 'khy'}）`
          : _causeFix(
              'khy 不在 PATH（pip Scripts/bin 目录未加入 PATH，开机自启/detached 启动尤其常见）',
              '改用 `python -m khy_platform <命令>`（始终可用），或把 Python 的 Scripts/bin 目录加入 PATH'
            ),
        // Warn, not error: `python -m khy_platform` is a guaranteed fallback.
        f.khyOnPath ? 'info' : 'warn'
      )
    );

    // 5. Proxy core (mihomo) — OPTIONAL runtime capability, INFO only (只披露不阻拦).
    // Raw-protocol nodes (vmess/vless/trojan/ss/ssr) need the core binary; http/https
    // direct nodes do NOT — so absence is never a fault (ok:true always, never counts
    // as a doctor failure). This is the headless/off-machine user's ONLY "代理二进制去
    // 哪下载" surface (they have no web UI), reusing the describeCoreDownload SSOT rather
    // than hardcoding a URL. Only emitted when a descriptor was gathered (proxy
    // subsystem present + sub-gate on); otherwise nothing new appears (byte-revert).
    const cd = f.coreDescriptor;
    if (cd && typeof cd === 'object') {
      const binDir = cd.binDir || cd.dest || '';
      const where =
        cd.supported && cd.url
          ? `下载 ${cd.url}（版本 ${cd.version || '?'}），解压后放到 ${binDir}`
          : `本平台无预置资产，前往 ${cd.releasesPage || 'https://github.com/MetaCubeX/mihomo/releases'} 选对应资产，放到 ${binDir}`;
      checks.push(
        _check(
          '代理内核 mihomo（可选）',
          true, // optional capability — absence is informational, never a failure
          f.corePresent
            ? `已就绪：${cd.dest || binDir}`
            : `未安装（仅原始协议节点 vmess/vless/trojan/ss/ssr 需要；http/https 直连型无需内核即可代理）。${where}`,
          'info'
        )
      );
    }

    // 6. Dual-channel version parity (pip / npm) — INFO only (只披露不阻拦), never a
    // fault. pip `khy-os` and npm `@khy-os/khy-os` are the two off-machine channels
    // and the project red line requires their versions to stay identical; a fresh-
    // machine restore that mixes versions gets a launcher/backend vs dependency-
    // hydration mismatch. This surfaces the running version + detected channel and
    // the exact same-version install command for the *other* channel, so a landing
    // maintainer can verify a complete, consistent restore. Only emitted when the
    // sub-gate is on and a version fact was resolved (else nothing new → byte-revert).
    const di = f.dualInstall;
    if (di && typeof di === 'object' && di.version) {
      const chan =
        di.channel === 'pip'
          ? 'pip（Python site-packages）'
          : di.channel === 'npm'
            ? 'npm（node_modules）'
            : '源码/开发树';
      checks.push(
        _check(
          '双渠道版本一致性（pip / npm）',
          true, // guidance only — never counts as a doctor failure
          `本次运行版本 ${di.version}，检测到本渠道：${chan}。离机还原须两条渠道版本一致：` +
            `pip 装 khy-os==${di.version}，npm 装 @khy-os/khy-os@${di.version}` +
            `（版本不一致会导致启动脚本/后端与依赖水合错配）。`,
          'info'
        )
      );
    }

    return checks;
  } catch (_) {
    // Doctor must never crash because of this add-on.
    return [];
  }
}

/**
 * Default PATH-based command lookup (no subprocess spawn). Pure over injected
 * existsSync/env/platform. Returns the matched name or ''.
 */
function _defaultWhich(names, deps) {
  const d = deps || {};
  const existsSync = d.existsSync;
  const env = d.env || {};
  const isWin = (d.platform || process.platform) === 'win32';
  if (typeof existsSync !== 'function') {
    return '';
  }
  const pathVar = env.PATH || env.Path || '';
  const dirs = String(pathVar)
    .split(isWin ? ';' : ':')
    .filter(Boolean);
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        try {
          if (existsSync(path.join(dir, name + ext))) {
            return name;
          }
        } catch (_) {
          /* keep scanning */
        }
      }
    }
  }
  return '';
}

/**
 * IO boundary: probe the installed bundle + PATH and return the fact object that
 * `assessFreshInstall` consumes. Fully injectable; fail-soft (any error → a
 * conservative "present/reachable = false" fact rather than a throw).
 *
 * @param {object} deps
 *   - bundleRoot {string}   services/backend root (where bin/, server.js live)
 *   - existsSync {function} fs.existsSync
 *   - env        {object}   process.env (for PATH)
 *   - platform   {string}   process.platform
 *   - which      {function} optional override for command lookup (tests)
 *   - readdir    {function} optional fs.readdirSync — enables the SSOT-aligned
 *                 "node_modules non-empty" hydration check (matches the pip
 *                 launcher). When absent, falls back to a name probe.
 *   - arch       {string}   process.arch — used to resolve the proxy-core asset.
 *   - describeCoreDownload {function} optional (p,arch)→descriptor override for
 *                 the proxy-core hint; defaults to the proxyCoreInstaller SSOT.
 */
function gatherFreshInstallFacts(deps) {
  const d = deps || {};
  const bundleRoot = d.bundleRoot || '';
  const existsSync = typeof d.existsSync === 'function' ? d.existsSync : () => false;
  const which =
    typeof d.which === 'function'
      ? d.which
      : (names) => _defaultWhich(names, { existsSync, env: d.env, platform: d.platform });

  const safeExists = (p) => {
    try {
      return !!existsSync(p);
    } catch (_) {
      return false;
    }
  };
  const readdir = typeof d.readdir === 'function' ? d.readdir : null;
  const safeNonEmptyDir = (p) => {
    if (!readdir) {
      return null;
    } // signal "unknown — fall back to name probe"
    try {
      const entries = readdir(p);
      return Array.isArray(entries) && entries.length > 0;
    } catch (_) {
      return false;
    }
  };

  const nmDir = bundleRoot ? path.join(bundleRoot, 'node_modules') : '';
  const nodeModulesPresent = !!nmDir && safeExists(nmDir);
  // Hydration sentinel — MUST agree with the pip launcher's own SSOT definition
  // of "hydrated" (platform/khy_platform/cli.py:1820): `node_modules exists AND is
  // non-empty`. That check is content-AGNOSTIC. An earlier name-allowlist
  // (express/.package-lock.json/.bin) disagreed with it: on a hoisted/workspace
  // layout the real deps live at the repo-root node_modules, so a perfectly
  // hydrated services/backend/node_modules holds only a few hoist-stragglers and
  // none of those names — the doctor would falsely report "空壳" and send a
  // healthy user to run a pointless `npm install`. Primary signal is now the
  // non-empty-directory check (readdir, matching the launcher); the name probe is
  // only a fallback for callers that cannot inject readdir.
  const nonEmpty = nodeModulesPresent ? safeNonEmptyDir(nmDir) : false;
  const hydrationSentinelPresent =
    nodeModulesPresent &&
    (nonEmpty === true ||
      (nonEmpty === null &&
        (safeExists(path.join(nmDir, '.bin')) ||
          safeExists(path.join(nmDir, 'express')) ||
          safeExists(path.join(nmDir, '.package-lock.json')))));

  const resolvedName = which(['khy', 'khy-os', 'khy-quant', 'khyquant']);

  // Proxy core (mihomo) download hint — reuse the describeCoreDownload SSOT so the
  // CLI doctor tells a headless off-machine user (no web UI) exactly where to get
  // the OPTIONAL proxy binary. Sub-gated + fully fail-soft: subsystem absent /
  // describe throws / no dest → coreDescriptor:null and the assessor emits nothing
  // (byte-revert). describeCoreDownload is a pure zero-IO SSOT; it is injectable
  // for tests and lazily required so this leaf never hard-couples to the proxy
  // subsystem at module-load time.
  let coreDescriptor = null;
  let corePresent = false;
  if (_proxyCoreHintEnabled(d.env)) {
    const describe =
      typeof d.describeCoreDownload === 'function'
        ? d.describeCoreDownload
        : (p, a) => require('./domain/network/proxy/proxyCoreInstaller').describeCoreDownload(p, a);
    try {
      const desc = describe(d.platform, d.arch);
      if (desc && typeof desc === 'object' && desc.dest) {
        coreDescriptor = desc;
        corePresent = safeExists(desc.dest);
      }
    } catch (_) {
      /* fail-soft: no proxy-core hint this run */
    }
  }

  // Dual-channel version parity fact — the running bundle's version + which channel
  // it came from. Reuses the bundle's own package.json as the runtime version SSOT
  // (services/backend/package.json, what `khy --version` reports). Sub-gated +
  // fully fail-soft: gate off / unreadable / unparsable → dualInstall:null and the
  // assessor emits nothing (byte-revert). readVersion is injectable for tests and
  // lazily defaults to a direct fs read so this leaf adds no new hard dependency and
  // needs no change at the init.js call site.
  let dualInstall = null;
  if (_dualInstallCheckEnabled(d.env) && bundleRoot) {
    const readVersion =
      typeof d.readVersion === 'function'
        ? d.readVersion
        : (root) => {
            try {
              const raw = require('fs').readFileSync(path.join(root, 'package.json'), 'utf-8');
              const v = JSON.parse(raw).version;
              return typeof v === 'string' ? v : '';
            } catch (_) {
              return '';
            }
          };
    try {
      const version = readVersion(bundleRoot);
      if (version) {
        dualInstall = { version, channel: _detectChannel(bundleRoot) };
      }
    } catch (_) {
      /* fail-soft: no dual-install hint this run */
    }
  }

  return {
    bundleRoot,
    binEntryPresent: !!bundleRoot && safeExists(path.join(bundleRoot, 'bin', 'khy.js')),
    serverEntryPresent: !!bundleRoot && safeExists(path.join(bundleRoot, 'server.js')),
    nodeModulesPresent,
    hydrationSentinelPresent,
    khyOnPath: !!resolvedName,
    khyResolvedName: resolvedName || '',
    coreDescriptor,
    corePresent,
    dualInstall,
  };
}

/**
 * Gate → gather → assess. Returns the doctor checks to append, or [] when the
 * gate is off (byte-revert: `khy doctor` shows nothing new).
 */
function freshInstallChecks(deps) {
  try {
    if (!_gateEnabled((deps || {}).env)) {
      return [];
    }
    return assessFreshInstall(gatherFreshInstallFacts(deps));
  } catch (_) {
    return [];
  }
}

// ── 便携自检（portable self-heal）───────────────────────────────────────────
// 与上方「离机还原自检」同模式的新增探针组：SQLite 驱动（子进程隔离防段错误）、
// junction/symlink 断链、数据指针一致性。`khy doctor --fix` 时 fixPortableIssues
// 对可修复项（断链重建、指针校准）自动修复。门控 KHY_DOCTOR_PORTABLE 默认开；
// 0/false/off/no 关闭（byte-revert：doctor 不出现任何新条目）。

const PORTABLE_CATEGORY = '便携自检';

function _portableGateEnabled(env) {
  const v = (env || {}).KHY_DOCTOR_PORTABLE;
  if (v === undefined || v === null) {
    return true;
  }
  return !_FALSY.has(String(v).trim().toLowerCase());
}

function _portableRootOf(deps) {
  const d = deps || {};
  const env = d.env || process.env;
  if (env.KHYQUANT_PORTABLE_ROOT) {
    return path.resolve(env.KHYQUANT_PORTABLE_ROOT);
  }
  if (d.bundleRoot) {
    return path.resolve(d.bundleRoot, '..', '..');
  }
  return path.resolve(__dirname, '..', '..', '..', '..');
}

/** 已知链接清单（与 scripts/link-shared-dev.js、scripts/portable-health-check.js 对齐）。 */
function _knownPortableLinks(root) {
  return [
    {
      label: 'services/backend/vendor/shared',
      linkPath: path.join(root, 'services', 'backend', 'vendor', 'shared'),
      target: path.join(root, 'platform', 'packages', 'shared'),
      optional: false,
    },
    {
      label: 'services/backend/node_modules/@khy/shared',
      linkPath: path.join(root, 'services', 'backend', 'node_modules', '@khy', 'shared'),
      target: path.join(root, 'services', 'backend', 'vendor', 'shared'),
      optional: true,
    },
    {
      label: 'node_modules/@khy/shared',
      linkPath: path.join(root, 'node_modules', '@khy', 'shared'),
      target: path.join(root, 'platform', 'packages', 'shared'),
      optional: true,
    },
  ];
}

function _linkStatus(fsMod, link) {
  let st = null;
  try {
    st = fsMod.lstatSync(link.linkPath);
  } catch (_) {
    /* missing */
  }
  if (!st) {
    return link.optional ? 'absent-optional' : 'missing';
  }
  if (!st.isSymbolicLink()) {
    return 'real-copy';
  }
  try {
    fsMod.realpathSync(link.linkPath);
    return 'linked';
  } catch (_) {
    return 'broken';
  }
}

/** IO 采集：SQLite 子进程探针 + 链接状态 + 指针状态（注入式、fail-soft）。 */
function gatherPortableFacts(deps) {
  const d = deps || {};
  const fsMod = d.fs || require('fs');
  const root = _portableRootOf(d);
  let sqlite = { ok: false, driver: '', detail: '' };
  try {
    const probe =
      typeof d.probeSqlite === 'function'
        ? d.probeSqlite
        : () =>
            require('../bootstrap/startupSqliteProbe').runStartupSqliteProbe({ timeoutMs: 8000 });
    const r = probe();
    if (r && r.checked === false) {
      sqlite = {
        ok: true,
        driver: r.driver || '',
        detail: `探针未得出结论（${r.detail || 'inconclusive'}），放行`,
      };
    } else {
      sqlite = { ok: !!(r && r.ok), driver: (r && r.driver) || '', detail: (r && r.detail) || '' };
    }
  } catch (err) {
    sqlite = {
      ok: true,
      driver: '',
      detail: `探针自身异常（${err && err.message ? err.message : err}），放行`,
    };
  }
  const links = _knownPortableLinks(root).map((link) => ({
    ...link,
    status: _linkStatus(fsMod, link),
  }));
  const pointer = { present: false, missing: [] };
  try {
    const dh = require('../utils/dataHome');
    const p = dh._readPointer();
    if (p) {
      pointer.present = true;
      for (const key of ['dataHome', 'projectDataHome']) {
        const target = p[key];
        if (typeof target === 'string' && target && !fsMod.existsSync(target)) {
          pointer.missing.push({ key, target });
        }
      }
    }
  } catch (_) {
    /* 指针不可读 → 视为未建立 */
  }
  return { root, sqlite, links, pointer };
}

/** 纯装配：facts → doctor checks（绝不 IO / 绝不 throw）。 */
function assessPortable(facts) {
  try {
    const f = facts || {};
    const checks = [];
    const sq = f.sqlite || {};
    checks.push(
      _check(
        'SQLite 驱动',
        !!sq.ok,
        sq.ok
          ? sq.driver
            ? `驱动 ${sq.driver} 可用（子进程探针通过）`
            : sq.detail || '探针通过'
          : _causeFix(
              sq.detail || 'SQLite 驱动子进程探针失败（疑似 better-sqlite3 段错误 / ABI 不匹配）',
              '使用 Node.js >= 23.4（内置 node:sqlite），或在项目根执行 `npm rebuild better-sqlite3`'
            ),
        'error'
      )
    );
    const bad = (f.links || []).filter((l) => l.status === 'broken' || l.status === 'missing');
    checks.push(
      _check(
        'junction/symlink 链接',
        bad.length === 0,
        bad.length === 0
          ? '已知链接全部有效（或为实体目录/可选缺省）'
          : _causeFix(
              bad
                .map((l) => `${l.label}（${l.status === 'broken' ? '断链' : '缺失'}）`)
                .join('、') + '——常见于整目录迁移后',
              '运行 `khy doctor --fix` 或 `khy repair` 自动重建'
            ),
        'error'
      )
    );
    const ptr = f.pointer || {};
    const ptrOk = !ptr.present || (ptr.missing || []).length === 0;
    checks.push(
      _check(
        '数据指针一致性',
        ptrOk,
        ptrOk
          ? ptr.present
            ? '指针目标全部存在'
            : '指针尚未建立（首启自动生成）'
          : _causeFix(
              (ptr.missing || []).map((m) => `${m.key} → ${m.target} 不存在`).join('；'),
              '运行 `khy doctor --fix` 或 `khy repair` 按当前便携根校准指针'
            ),
        'error'
      )
    );
    return checks;
  } catch (_) {
    return [];
  }
}

/** 门控 → 采集 → 装配（供 runDoctorChecks 追加；门关时返回 []）。 */
function portableSelfHealChecks(deps) {
  try {
    if (!_portableGateEnabled((deps || {}).env)) {
      return [];
    }
    return assessPortable(gatherPortableFacts(deps)).map((c) => ({
      ...c,
      category: PORTABLE_CATEGORY,
    }));
  } catch (_) {
    return [];
  }
}

/**
 * `khy doctor --fix`：对可修复项自动修复（断链重建、指针校准）。
 * 返回 { fixed, failed, skipped }（均为字符串数组），绝不 throw。
 */
function fixPortableIssues(deps) {
  const out = { fixed: [], failed: [], skipped: [] };
  try {
    const d = deps || {};
    const fsMod = d.fs || require('fs');
    const root = _portableRootOf(d);
    for (const link of _knownPortableLinks(root)) {
      const status = _linkStatus(fsMod, link);
      if (status !== 'broken' && status !== 'missing') {
        continue;
      }
      if (!fsMod.existsSync(link.target)) {
        out.failed.push(`${link.label}：目标不存在（${link.target}）`);
        continue;
      }
      try {
        try {
          fsMod.unlinkSync(link.linkPath);
        } catch (_) {
          try {
            fsMod.renameSync(link.linkPath, `${link.linkPath}.broken-${Date.now()}`);
          } catch (_2) {
            /* 可能本就缺失 */
          }
        }
        fsMod.mkdirSync(path.dirname(link.linkPath), { recursive: true });
        const rel = path.relative(path.dirname(link.linkPath), link.target);
        try {
          fsMod.symlinkSync(rel, link.linkPath, 'dir');
          out.fixed.push(`${link.label}：已重建 symlink → ${rel}`);
        } catch (_) {
          fsMod.symlinkSync(link.target, link.linkPath, 'junction');
          out.fixed.push(`${link.label}：已重建 junction → ${link.target}`);
        }
      } catch (err) {
        out.failed.push(`${link.label}：重建失败（${err && err.message ? err.message : err}）`);
      }
    }
    try {
      const dh = require('../utils/dataHome');
      const pointer = dh._readPointer();
      let rawObj = null;
      try {
        rawObj = JSON.parse(fsMod.readFileSync(dh._pointerFile(), 'utf8'));
      } catch (_) {
        rawObj = null;
      }
      if (pointer) {
        for (const key of ['dataHome', 'projectDataHome']) {
          const target = pointer[key];
          if (typeof target !== 'string' || !target) {
            continue;
          }
          if (fsMod.existsSync(target)) {
            // 读取端自愈（尾部重定位）已生效但文件里还是旧值 → 固化写回便携相对形式。
            const rawVal = rawObj ? rawObj[key] : undefined;
            const wantVal =
              typeof dh._toPortablePointerValue === 'function'
                ? dh._toPortablePointerValue(target)
                : target;
            if (typeof rawVal === 'string' && rawVal !== wantVal) {
              dh._writePointer(
                key === 'projectDataHome'
                  ? {
                      projectDataHome: target,
                      projectSource: 'doctor-fix',
                      projectPinnedReason: 'doctor-fix-recalibrate',
                    }
                  : {
                      dataHome: target,
                      source: 'doctor-fix',
                      pinnedReason: 'doctor-fix-recalibrate',
                    }
              );
              out.fixed.push(`指针 ${key}：已固化为便携相对形式（${wantVal}）`);
            }
            continue;
          }
          if (key === 'projectDataHome') {
            const fallback = path.join(root, '.khy');
            fsMod.mkdirSync(fallback, { recursive: true });
            dh._writePointer({
              projectDataHome: fallback,
              projectSource: 'doctor-fix',
              projectPinnedReason: 'doctor-fix-recalibrate',
            });
            out.fixed.push(`指针 projectDataHome：已校准 → ${fallback}`);
          } else {
            out.skipped.push(
              `指针 ${key}：目标 ${target} 不可达且无法重定位（可能是可移动盘未挂载），不自动改写`
            );
          }
        }
      }
    } catch (err) {
      out.failed.push(`指针校准异常（${err && err.message ? err.message : err}）`);
    }
  } catch (err) {
    out.failed.push(`便携修复自身异常（${err && err.message ? err.message : err}）`);
  }
  return out;
}

module.exports = {
  CATEGORY,
  PORTABLE_CATEGORY,
  assessFreshInstall,
  gatherFreshInstallFacts,
  freshInstallChecks,
  _gateEnabled,
  _proxyCoreHintEnabled,
  _dualInstallCheckEnabled,
  _detectChannel,
  _defaultWhich,
  portableSelfHealChecks,
  gatherPortableFacts,
  assessPortable,
  fixPortableIssues,
  _portableGateEnabled,
  _knownPortableLinks,
};
