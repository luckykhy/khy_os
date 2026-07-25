'use strict';

/**
 * pipFailurePolicy.js — 纯叶子:khy 自升级(`khy update`/`/upgrade`)时 pip 失败的
 * 确定性分类 + 直连重试策略 + 可执行诊断文案的单一真源。
 *
 * 背景(真缺口):`cli/router.js` 的 `case 'update'` 用 `execSync('pip install --upgrade <pkg> 2>&1')`
 * 自升级。而 `proxyConfigService` 会把 `HTTP_PROXY/HTTPS_PROXY` 写进 `process.env`,`execSync`
 * **继承**了这个代理;一旦代理软件(Clash/V2Ray 等)被关掉,pip 就报
 *   ProxyError('Cannot connect to proxy.', ... [WinError 10061] 由于目标计算机积极拒绝)
 * 自升级失败,且旧逻辑只把截断的原始错误吐给用户(`err.message.slice(0,200)`),既不可读也不可操作。
 * 旧重试循环只在「找不到分布/404」时换下一个候选包,对**代理/网络类**失败直接 throw。
 *
 * 本叶子把三件事收成一处单一真源:
 *   - classifyPipFailure() —— 把 pip 的 stdout/stderr 文本确定性归类(proxy/network/not-found/permission/other);
 *   - stripProxyEnv()      —— 产出一份「剥掉代理」的环境对象,供调用方直连重试(纯函数,不碰 process);
 *   - buildPipFailureDiagnosis() —— 产出第一人称、带编号的可执行修复方案(中文)。
 *
 * 契约:零 IO(只读 process.env 做门控,不碰 fs/网络/子进程;环境对象由调用方传入)、确定性、
 * 绝不抛(fail-soft,坏输入返回安全值)、env 门控 `KHY_PIP_FAILURE_POLICY` 默认开。
 * 门控关 → `isEnabled()===false`,调用方应退回原有「直接 throw + 截断原始错误」的逐字节行为。
 *
 * 全局门控惯例:khyos 所有 KHY_* 开关读法为「仅 0/false/off/no(去空白小写)才算关」。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// trim+小写 nullish-安全规整单一真源 utils/normLower。
const _norm = require('../utils/normLower');

/** 门控:默认开,仅显式 0/false/off/no 才关。 */
function isEnabled(env = process.env) {
  return !_FALSY.has(_norm(env && env.KHY_PIP_FAILURE_POLICY));
}

// ── 失败模式(单一真源)──────────────────────────────────────────────────────────
// 顺序即优先级:proxy 先于 network(代理拒连本质是网络,但修法不同——优先按代理诊断)。
// 每条 re 都对 pip 实际吐出的英文 + 中文 Windows 错误做强匹配,误报率极低。
const _PROXY_RE = /proxyerror|cannot connect to proxy|tunnel connection failed|proxy.{0,40}(refused|10061|拒绝)|由于目标计算机积极拒绝.{0,40}(代理|proxy)|\[winerror 10061\][\s\S]{0,80}proxy/i;
const _NETWORK_RE = /failed to establish a new connection|max retries exceeded|connection (refused|reset|aborted|timed out)|connection broken|temporary failure in name resolution|getaddrinfo|name or service not known|network is unreachable|read timed out|由于目标计算机积极拒绝|无法连接|连接超时|connecttimeout|newconnectionerror/i;
const _NOT_FOUND_RE = /no matching distribution found|could not find a version|\b404\b|not found on|no such package/i;
const _FILE_LOCKED_RE = /\[winerror 32\]|另一个程序正在使用此文件|进程无法访问|being used by another process|cannot access the file because it is being used|the process cannot access the file/i;
const _PERMISSION_RE = /permission denied|access is denied|拒绝访问|\beacces\b|errno 13|could not install packages.*permission/i;

/**
 * 把 pip 的合并输出(stdout+stderr+message)确定性归类。绝不抛。
 * @param {string} text
 * @returns {{kind:'proxy'|'network'|'not-found'|'file-locked'|'permission'|'other', retryWithoutProxy:boolean, transient:boolean}}
 */
function classifyPipFailure(text) {
  try {
    const t = String(text || '');
    if (!t.trim()) return { kind: 'other', retryWithoutProxy: false, transient: false };
    if (_PROXY_RE.test(t)) return { kind: 'proxy', retryWithoutProxy: true, transient: true };
    // not-found 先于 network 判定:404/无分布是「换包/换版本」问题,不是连通性问题。
    if (_NOT_FOUND_RE.test(t)) return { kind: 'not-found', retryWithoutProxy: false, transient: false };
    if (_NETWORK_RE.test(t)) return { kind: 'network', retryWithoutProxy: true, transient: true };
    // file-locked 先于 permission:WinError 32 文本里也含「拒绝访问」类词,但根因不同。
    if (_FILE_LOCKED_RE.test(t)) return { kind: 'file-locked', retryWithoutProxy: false, transient: true };
    if (_PERMISSION_RE.test(t)) return { kind: 'permission', retryWithoutProxy: false, transient: false };
    return { kind: 'other', retryWithoutProxy: false, transient: false };
  } catch {
    return { kind: 'other', retryWithoutProxy: false, transient: false };
  }
}

/** 便捷判定:这次失败是不是代理连接被拒。 */
function isProxyFailure(text) {
  return classifyPipFailure(text).kind === 'proxy';
}

// ── 直连重试:剥掉代理的环境对象 ──────────────────────────────────────────────────
const _PROXY_ENV_KEYS = Object.freeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy',
]);

/**
 * 产出一份剥掉所有代理变量、并设 `NO_PROXY=*` 的环境**副本**,供调用方做直连重试。
 * 纯函数:不修改入参、不碰 process.env;调用方把它当 execSync 的 `env` 传入即可。
 * @param {Object} [env]
 * @returns {Object} 新对象
 */
function stripProxyEnv(env = process.env) {
  const out = {};
  try {
    const src = env && typeof env === 'object' ? env : {};
    for (const k of Object.keys(src)) {
      if (_PROXY_ENV_KEYS.includes(k)) continue;
      out[k] = src[k];
    }
    // 双保险:即使有遗漏的代理键,NO_PROXY=* 让 requests/urllib3 对所有主机绕过代理。
    out.NO_PROXY = '*';
    out.no_proxy = '*';
  } catch {
    return { ...((env && typeof env === 'object') ? env : {}) };
  }
  return out;
}

// ── 可执行诊断文案 ────────────────────────────────────────────────────────────
const _DEFAULT_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';

/**
 * 产出第一人称、带编号的修复方案。确定性、绝不抛。
 * @param {object} [opts]
 * @param {string} [opts.kind]   classifyPipFailure().kind
 * @param {string} [opts.pkg]    包名(默认 khy-os)
 * @param {string} [opts.mirror] 国内镜像
 * @param {boolean} [opts.autoRetried] 是否已自动直连重试过(影响措辞)
 * @returns {string}
 */
function buildPipFailureDiagnosis(opts = {}) {
  try {
    const pkg = String((opts && opts.pkg) || 'khy-os').trim() || 'khy-os';
    const mirror = String((opts && opts.mirror) || _DEFAULT_MIRROR).trim() || _DEFAULT_MIRROR;
    const kind = (opts && opts.kind) || 'other';
    const auto = !!(opts && opts.autoRetried);

    if (kind === 'proxy') {
      const head = auto
        ? '更新失败:pip 通过代理连接被拒(WinError 10061 / Cannot connect to proxy),我已自动尝试「绕过代理直连」重试但仍未成功。'
        : '更新失败:pip 通过代理连接被拒(WinError 10061 / Cannot connect to proxy)。';
      return [
        head,
        '原因:你开过的代理软件(Clash/V2Ray 等)已关闭,但代理地址仍残留在环境变量或 pip 配置里,pip 连不上那个端口。',
        '修复(任选其一):',
        `  1) 直连重试:       pip install --proxy "" --upgrade ${pkg}`,
        `  2) 国内镜像直连:   pip install --proxy "" -i ${mirror} --upgrade ${pkg}`,
        '  3) 确需代理:       先打开代理软件,确认端口在监听(netstat -ano | findstr 7890),再重试。',
        '  4) 永久清除残留代理:pip config unset global.proxy;并在系统环境变量里删掉 HTTP_PROXY/HTTPS_PROXY。',
        '注:输出里若已有 "Requirement already satisfied",依赖都在,khy 多半可用 —— 运行 `khy --version` 确认。',
      ].join('\n');
    }

    if (kind === 'network') {
      const head = auto
        ? '更新失败:连不上 PyPI(网络不可达 / 连接被拒 / 解析失败),绕过代理直连后仍未成功。'
        : '更新失败:连不上 PyPI(网络不可达 / 连接被拒 / 解析失败)。';
      return [
        head,
        '修复(任选其一):',
        `  1) 换国内镜像:     pip install -i ${mirror} --upgrade ${pkg}`,
        '  2) 检查网络/代理:  确认能上网;若需代理请先把代理软件打开再重试。',
        `  3) 稍后重试:       上游可能临时不可用,过一会儿再 pip install --upgrade ${pkg}`,
        '注:输出里若已有 "Requirement already satisfied",khy 多半可用 —— 运行 `khy --version` 确认。',
      ].join('\n');
    }

    if (kind === 'not-found') {
      return [
        `更新失败:在当前索引里找不到可安装的 ${pkg}。`,
        '修复(任选其一):',
        `  1) 换国内镜像:     pip install -i ${mirror} --upgrade ${pkg}`,
        `  2) 强制重装:       pip install --force-reinstall --no-cache-dir ${pkg}`,
        '  3) 确认包名:       khy-os(兼容旧名 khy-quant)。',
      ].join('\n');
    }

    if (kind === 'permission') {
      return [
        '更新失败:权限不足,无法写入安装目录。',
        '修复(任选其一):',
        `  1) 用户级安装:     pip install --user --upgrade ${pkg}`,
        '  2) Windows:        以管理员身份打开终端再重试;',
        '  3) Linux/macOS:    用虚拟环境,或谨慎使用 sudo。',
      ].join('\n');
    }

    if (kind === 'file-locked') {
      return [
        '更新失败:安装目录被占用(WinError 32,文件正被另一个程序使用)。',
        '真实原因:升级时你还开着 khy(或它启动的 Node 后台/编辑器),Windows 不允许删除',
        '          正在使用的文件,pip 删到一半就失败,并可能让安装目录残缺。',
        '修复(按顺序):',
        '  1) 关掉所有 khy:关掉所有 khy 终端窗口;任务管理器里结束残留的 node.exe / khy 进程。',
        `  2) 重新安装:    pip install --force-reinstall --no-cache-dir ${pkg}`,
        '  3) 若仍报占用:  注销/重启 Windows 再执行第 2 步(彻底释放文件句柄)。',
        '  4) 装完首次运行 khy 会自动清理上次残留的损坏目录(corrupt orphan)。',
      ].join('\n');
    }

    return [
      `更新失败。手动更新:pip install --upgrade ${pkg}`,
      `若网络慢可走国内镜像:pip install -i ${mirror} --upgrade ${pkg}`,
    ].join('\n');
  } catch {
    return 'pip 更新失败。手动更新:pip install --upgrade khy-os';
  }
}

// ── Windows 升级前预检:检测多余的 node 进程(锁文件风险)──────────────────────────
/**
 * 检测 Windows 上是否有多余的 khy/node 进程(升级时可能锁文件导致 WinError 32)。
 * 纯函数:入参由调用方注入(platform, tasklist CSV 文本);绝不抛、fail-soft。
 *
 * 逻辑:`khy update` 自身必然占用 ≥1 个 node,所以阈值是「>1」才算有风险——
 * 即存在「除当前升级进程之外的」node/khy,可能锁住 site-packages 里的文件。
 * 非 Windows / 取不到进程列表 / 只有 1 个 node → atRisk:false,静默通过。
 *
 * @param {object} opts
 * @param {string} opts.platform process.platform
 * @param {string} opts.processListText tasklist CSV 输出(可选;缺省/空→atRisk:false)
 * @returns {{atRisk:boolean, count:number}}
 */
function detectWindowsUpgradeLockRisk(opts = {}) {
  try {
    const plat = String((opts && opts.platform) || '').trim().toLowerCase();
    if (plat !== 'win32') return { atRisk: false, count: 0 };

    const text = String((opts && opts.processListText) || '');
    if (!text.trim()) return { atRisk: false, count: 0 };

    // tasklist /FO CSV 输出:首行 "Image Name","PID"...;后续每行一个进程。
    // 简单数行数:跳过首行标题,数包含 node.exe 的实际进程行数。
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    let count = 0;
    for (const line of lines) {
      // CSV 首列是 "Image Name",若含 node.exe 则是一个 node 进程。
      // 保守匹配:不严格解析 CSV,只要行里含 node.exe 就算(tasklist 输出稳定)。
      if (/node\.exe/i.test(line) && !/image name/i.test(line)) {
        count++;
      }
    }
    // 阈值:>1 才算有风险(1 个是 khy update 自己,>1 表示有其它 khy/node 在跑)。
    return { atRisk: count > 1, count };
  } catch {
    return { atRisk: false, count: 0 };
  }
}

/**
 * 升级前停机计划:决定「该不该停常驻进程、停哪些」——判定与执行分离,叶子只出决定,
 * 调用方(router.js `case 'update'`)持有「怎么停」(daemonStop + best-effort tray stop)。
 *
 * 背景:Windows 上常驻管理守护进程(node.exe,托盘分离拉起)持有 site-packages 里 bundle
 * 的句柄/cwd,`pip install --upgrade` 覆盖不了 → WinError 32 → 装到一半损坏。旧逻辑只警告
 * 并继续;这里给出「先停再装」的确定性计划。
 *
 * 仅当 win32 ∧ risk.atRisk ∧ 门开 → shouldStop:true(steps 含 daemon+tray);否则不停。
 *
 * @param {object} opts
 * @param {string} opts.platform process.platform
 * @param {{atRisk:boolean,count:number}} [opts.risk] detectWindowsUpgradeLockRisk() 的结果
 * @param {object} [opts.env] 环境(读门控;默认 process.env)
 * @returns {{shouldStop:boolean, steps:Array<{id:string,label:string}>, message:string}}
 */
function buildUpgradeStopPlan(opts = {}) {
  const NONE = { shouldStop: false, steps: [], message: '' };
  try {
    const env = opts && typeof opts.env === 'object' && opts.env ? opts.env : process.env;
    if (!isEnabled(env)) return NONE;
    const plat = String((opts && opts.platform) || '').trim().toLowerCase();
    if (plat !== 'win32') return NONE;
    const risk = opts && typeof opts.risk === 'object' && opts.risk ? opts.risk : null;
    if (!risk || !risk.atRisk) return NONE;
    return {
      shouldStop: true,
      steps: [
        { id: 'daemon', label: '管理守护进程(锁住 bundle 文件的 node.exe)' },
        { id: 'tray', label: '系统托盘(防升级窗口内重新拉起守护进程)' },
      ],
      message: '升级前先停掉常驻进程以释放文件占用(否则 Windows 会 WinError 32 导致安装损坏)…',
    };
  } catch {
    return NONE;
  }
}

// ── 文件占用(WinError 32)一次性自动重试计划(修:「pip 装到一半失败,往往要装两次才成功」)──
//
// 真缺口:classifyPipFailure 早已把 WinError 32 归为 `kind:'file-locked', transient:true`,
// 但 `khy update` 的升级循环只在 `retryWithoutProxy`(代理/网络)时自动重试;file-locked 只是
// break 放弃 → 打印诊断 → 用户被迫再敲一次。那枚 `transient` 标志从未被任何生产代码消费。
// 第二次手动重试之所以能成,是因为 Python 启动器的 `_sweep_corrupt_orphans` 在下次启动时清掉了
// `~hy-os` 半装残骸、且守护进程的文件句柄已释放。本计划把「第二次」收进同一条命令内:
//   先清残骸 → 短暂等待 OS 释放句柄 → 用 `--force-reinstall --no-cache-dir` 干净覆盖重试一次。
// `--force-reinstall` 正是 startupFailureExplain / buildPipFailureDiagnosis(file-locked)一贯建议的解法。
//
// 门控 KHY_UPDATE_LOCK_RETRY 默认开(父门 KHY_PIP_FAILURE_POLICY);关 → shouldRetry 恒 false
//(逐字节回退旧「file-locked 直接放弃」行为)。纯函数、零 IO、绝不抛。

/** 文件占用一次性重试门控:默认开,仅显式 0/false/off/no 才关。 */
function isLockRetryEnabled(env = process.env) {
  return !_FALSY.has(_norm(env && env.KHY_UPDATE_LOCK_RETRY));
}

/**
 * 判定 pip 失败后是否应做「一次性」文件占用自动重试,以及重试形态。
 * 纯函数、绝不抛。消费 classifyPipFailure 的 `transient` 语义。
 *
 * @param {object} opts
 * @param {string}  opts.kind            classifyPipFailure().kind。
 * @param {boolean} [opts.alreadyRetried] 本次升级是否已用掉这枚一次性重试(全局仅一次)。
 * @param {object}  [opts.env]
 * @returns {{shouldRetry:boolean, forceReinstall:boolean, waitMs:number}}
 *   shouldRetry=true  → 调用方应清残骸 + 等待 waitMs + 重试一次(force-reinstall 时带 --force-reinstall --no-cache-dir);
 *   shouldRetry=false → 调用方逐字节回退旧「放弃并诊断」行为。
 */
function buildLockRetryPlan(opts = {}) {
  const NONE = { shouldRetry: false, forceReinstall: false, waitMs: 0 };
  try {
    const env = opts && typeof opts.env === 'object' && opts.env ? opts.env : process.env;
    // 父门 + 子门任一关 → 不重试(逐字节回退)。
    if (!isEnabled(env) || !isLockRetryEnabled(env)) return NONE;
    if (opts && opts.alreadyRetried) return NONE; // 一次性:已用掉则不再重试。
    const kind = String((opts && opts.kind) || '').trim();
    if (kind !== 'file-locked') return NONE; // 仅文件占用这类瞬态失败才自动重试。
    return { shouldRetry: true, forceReinstall: true, waitMs: 1500 };
  } catch {
    return NONE;
  }
}

// ── 版本串包守卫(修①:「khy update 把无关包 khy-quant 的版本冒充成 khy-os」根治)──────
//
// 真缺口:`khy update` 升级 `khy-os` 后用 `pip show <pkg>` 读回版本(readInstalledVersion),
// 而 detectInstalledPackage 在目标包读不出时会**回退到候选列表下一个包**(khy-quant)。
// 当 WinError 32 的 `~hy-os` 半装残骸让 `pip show khy-os` 读不干净时,回退恰好读到本地
// 装着的 khy-quant 1.8.0 —— 于是"khy-os 升到了 v1.8.0"这个假结论就显示出来了(khy-os
// 真身在 PyPI 只有 0.1.x,从无 1.x)。
//
// 本守卫把「读回的版本是否可信」收成一处纯判定:
//   - 跨包泄漏:实际升级/读回的包 ≠ 意图的目标包(khy-os)→ 拒绝显示,判为串包;
//   - 主版本反常跳变:currentVersion 主版本号 → newVersion 主版本号 的跨度异常(如 0 → 1
//     且非相邻)→ 疑似串包,拒绝并告警。
// 门控 KHY_PIP_VERSION_SANITY 默认开;关 → trusted 恒 true(逐字节回退旧「照单显示」行为)。
// 纯函数、零 IO、绝不抛。

/** 版本串包守卫门控:默认开,仅显式 0/false/off/no 才关。 */
function isVersionSanityEnabled(env = process.env) {
  return !_FALSY.has(_norm(env && env.KHY_PIP_VERSION_SANITY));
}

/** 解析语义版本主号(整数);无法解析 → null。纯函数。 */
function _majorOf(version) {
  const m = String(version == null ? '' : version).trim().match(/^(\d+)\./);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 判定「升级后读回的版本」是否可信,防止把无关包的版本冒充成目标包的版本。
 * 纯函数、绝不抛。
 *
 * @param {object} opts
 * @param {string} opts.targetPkg      本次意图升级的目标包(如 'khy-os')。
 * @param {string} opts.upgradedPkg    pip 实际升级成功的包(外层候选循环得到)。
 * @param {string} [opts.versionPkg]   readInstalledVersion 实际读到版本的那个包
 *                                     (若与 upgradedPkg 不同 → 发生了回退读别的包)。
 * @param {string} opts.currentVersion 升级前的当前版本。
 * @param {string} opts.newVersion     读回的新版本。
 * @param {object} [opts.env]
 * @returns {{trusted:boolean, reason:string, message:string}}
 *   trusted=true  → 版本可信,调用方照常显示;
 *   trusted=false → 疑似串包/读回不可信,调用方应拒绝显示该版本并告警。
 */
function evaluateUpdatedVersion(opts = {}) {
  const SAFE = { trusted: true, reason: '', message: '' };
  try {
    const env = opts && typeof opts.env === 'object' && opts.env ? opts.env : process.env;
    // 门关:逐字节回退旧行为(一律信任读回的版本)。
    if (!isVersionSanityEnabled(env)) return SAFE;

    const target = _norm(opts && opts.targetPkg);
    const upgraded = _norm(opts && opts.upgradedPkg);
    const versionPkg = _norm(opts && opts.versionPkg) || upgraded;
    const currentVersion = String((opts && opts.currentVersion) || '').trim();
    const newVersion = String((opts && opts.newVersion) || '').trim();

    // (a) 跨包泄漏:读回版本的包与意图目标包不一致 → 串包,拒绝。
    //     仅在两侧都可辨识时判定,避免坏输入误伤(缺省 → 信任)。
    if (target && versionPkg && versionPkg !== target) {
      return {
        trusted: false,
        reason: 'cross_package',
        message:
          `✗ 升级结果异常:目标包是 ${opts.targetPkg},但版本号读自另一个包 ${opts.versionPkg}。` +
          `已拒绝把无关包的版本冒充为 ${opts.targetPkg} 的升级结果(疑似 pip 半装残骸导致的读回错位)。`,
      };
    }

    // (b) 主版本反常跳变:如 0.1.x → 1.8.x(主号 0 → 1 属于跨大版本)。
    //     khy-os 真身长期停留在 0.1.x;跨主号跳变高度疑似读到了别的包。
    //     仅当两侧主号都可解析且跨度 >=1 时告警;无法解析 → 不误伤。
    const curMajor = _majorOf(currentVersion);
    const newMajor = _majorOf(newVersion);
    if (curMajor != null && newMajor != null && newMajor > curMajor) {
      return {
        trusted: false,
        reason: 'major_jump',
        message:
          `✗ 升级结果异常:版本从 v${currentVersion} 跳到 v${newVersion}(跨主版本号)。` +
          `khy-os 长期为 0.1.x,跨主版本跳变高度疑似读到了无关包的版本,已拒绝显示。` +
          `请重启 CLI 后用 pip show ${opts.targetPkg || 'khy-os'} 核对真实已装版本。`,
      };
    }

    return SAFE;
  } catch {
    // 保守:异常 → 信任读回版本(逐字节回退,绝不因守卫本身阻断升级流)。
    return SAFE;
  }
}

module.exports = {
  isEnabled,
  classifyPipFailure,
  isProxyFailure,
  stripProxyEnv,
  buildPipFailureDiagnosis,
  detectWindowsUpgradeLockRisk,
  buildUpgradeStopPlan,
  isLockRetryEnabled,
  buildLockRetryPlan,
  evaluateUpdatedVersion,
  isVersionSanityEnabled,
  PROXY_ENV_KEYS: _PROXY_ENV_KEYS,
  DEFAULT_MIRROR: _DEFAULT_MIRROR,
};
