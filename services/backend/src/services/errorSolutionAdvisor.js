'use strict';

/**
 * errorSolutionAdvisor.js — 纯叶子:错误 → 建议方案(零 IO / 确定性 / 绝不抛 / 门控默认开)。
 *
 * 背景(用户诉求):「khyos 出错时只有报错,缺少建议方案」。既有出口里,工具失败的
 * 「任务未完成」小结(toolUseLoop)只对 3 类错误(权限 / 路径不存在 / 超时)内联地给
 * 针对性建议,其余常见错误类(连接被拒 / 端口占用 / 磁盘满 / 模块缺失 / 命令未找到 /
 * DNS 解析失败 / 内存溢出 / 文件已存在 …)一律**只甩报错、不给下一步**。且那 3 条是
 * 散落的内联 if,非单一真源、无门控、无法单测。
 *
 * 本叶子把「错误签名 → 可执行建议方案」收口为**单一真源**:按错误文本里的确定性信号
 * (errno / 关键短语)匹配,给出一条**具体可执行**的中文建议。契合 KHY 哲学「确定性
 * 真值优先于模型猜测」:只对有把握的签名给建议,匹配不到则返回空(交由调用方既有泛化
 * 建议兜底,绝不臆造)。
 *
 * 门控 KHY_ERROR_SOLUTION_ADVISOR(默认开;取 0/false/off/no 关闭 → suggestSolutions
 * 恒返 [] → 调用方逐字节回退到既有行为)。env 经 opts.env 注入可测。纯叶子:零外部 IO、
 * 无副作用、绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控是否开启(默认开;仅 KHY_ERROR_SOLUTION_ADVISOR ∈ {0,false,off,no} 时关)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isErrorSolutionAdvisorEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_ERROR_SOLUTION_ADVISOR;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 错误签名 → 建议方案规则表(小写匹配,顺序即优先级:越具体越靠前)。每条对应一类
 * 「有确定诊断」的错误;泛化/无从判断的错误不入表(交调用方兜底)。solution 为一条
 * **具体可执行**的中文建议(尽量含可直接照做的动作/命令,不含密钥等敏感信息)。
 */
const SOLUTION_RULES = Object.freeze([
  // ── 权限 ──────────────────────────────────────────────────────────────────
  // 保留既有「Shift+Tab 切权限模式」提示(工具被权限模式拦下是最常见成因),并叠加
  // 文件系统 EACCES 的处置。
  {
    name: 'permission',
    re: /\beacces\b|permission denied|operation not permitted|\beperm\b|拒绝访问|权限不足|没有权限/,
    solution: '权限不足:若是工具被权限模式拦下,按 Shift+Tab 切换权限模式后重试;若是文件系统权限,检查目标文件/目录的属主与读写位(必要时 chmod / chown 或换可写目录)。',
  },
  // ── 下载 / HTTP 404 ───────────────────────────────────────────────────────
  // 远端资源没找到(非本地路径/命令缺失)。必须排在 path-not-found / command-not-found
  // 之前:否则 web 的「Not Found」被那两条的 `not found` / `: not found` 抢走,误导成
  // 「路径不存在」或「找不到命令」(dogfood:powershell Invoke-WebRequest 404 被误判)。
  {
    name: 'download-failed',
    re: /invoke-webrequest|webcmdletwebresponseexception|webexception|http\/\d(?:\.\d)?\s+404\b|\bhttp\s+404\b|\b404\s+not\s+found\b|response status code does not indicate success|curl:\s*\(22\)/,
    solution: '下载/网络请求失败(远端 404 或错误响应):是远端资源没找到,不是本地命令或路径缺失。核对下载 URL 的仓库/标签(tag)/资产名(发布资产名常随版本变化,别猜固定 URL),先用发布 API 列出真实资产再选对应系统架构的那个(`gh release list -R <owner>/<repo>` 或 GitHub releases API)后重新下载。',
  },
  // ── 路径不存在 ────────────────────────────────────────────────────────────
  {
    name: 'path-not-found',
    re: /\benoent\b|no such file or directory|not found|不存在|找不到(文件|路径|目录)/,
    solution: '目标路径不存在:确认文件/目录路径是否正确(区分相对/绝对路径与大小写),或先创建它再重试。',
  },
  // ── 命令未找到(与「路径不存在」区分:127 / not recognized) ────────────────
  {
    name: 'command-not-found',
    re: /command not found|: not found\b|not recognized as an internal|无法将“.+”识别为|exit(ed)? (with )?(code )?127\b/,
    solution: '命令未安装或不在 PATH:确认该命令已安装并可在 PATH 中找到(用 `which`/`where` 检查),或改用其等价命令。',
  },
  // ── 工具调用缺必填参数(dogfood 发现:grep 未传 pattern → 只报错无建议) ──────
  {
    name: 'missing-parameter',
    re: /required parameter .* is missing|missing required (parameter|argument)|缺少必填参数|参数.*(缺失|缺少|未(提供|传入?))/,
    solution: '工具调用缺少必填参数:补全报错中点名的必填字段(如 grep 的 pattern)后重新调用;若不确定参数,先查该工具的参数说明再重试。',
  },
  // ── 连接被拒 ──────────────────────────────────────────────────────────────
  {
    name: 'connection-refused',
    re: /\beconnrefused\b|connection refused|连接被拒绝|拒绝连接/,
    solution: '连接被拒绝:确认目标服务/端口已启动并在监听,主机与端口填写正确;若经代理,检查代理是否可用。',
  },
  // ── DNS / 主机解析失败 ────────────────────────────────────────────────────
  {
    name: 'dns',
    re: /\benotfound\b|getaddrinfo|\beai_again\b|name or service not known|无法解析(主机|域名)/,
    solution: '域名解析失败:检查主机名拼写与网络/DNS 连通性(必要时改用 IP 或配置可用 DNS)。',
  },
  // ── 端口占用 ──────────────────────────────────────────────────────────────
  {
    name: 'port-in-use',
    re: /\beaddrinuse\b|address already in use|port .* in use|端口.*(被占用|已被使用)/,
    solution: '端口已被占用:换一个空闲端口,或先结束占用该端口的进程(`lsof -i :<port>` / `netstat` 定位后再重启)。',
  },
  // ── 超时 ──────────────────────────────────────────────────────────────────
  {
    name: 'timeout',
    re: /\betimedout\b|timed? ?out|timeout|超时/,
    solution: '请求/操作超时:网络或目标服务可能较慢,稍后重试;必要时增大超时时长或拆小任务分批执行。',
  },
  // ── 磁盘空间不足 ──────────────────────────────────────────────────────────
  {
    name: 'disk-full',
    re: /\benospc\b|no space left on device|磁盘空间(不足|已满)|disk (is )?full/,
    solution: '磁盘空间不足:清理无用文件/缓存或扩容后重试(`df -h` 查看占用,khy 亦提供磁盘清理能力)。',
  },
  // ── 内存溢出 ──────────────────────────────────────────────────────────────
  {
    name: 'out-of-memory',
    re: /\benomem\b|out of memory|heap out of memory|javascript heap|内存(不足|溢出)/,
    solution: '内存不足:减小处理批量/并发,或提高进程内存上限(如 Node `--max-old-space-size`)后重试。',
  },
  // ── 模块/依赖缺失 ────────────────────────────────────────────────────────
  {
    name: 'module-not-found',
    re: /cannot find module|module_not_found|modulenotfounderror|no module named|依赖(缺失|未安装)/,
    solution: '缺少依赖模块:安装缺失依赖后重试(Node `npm install`,Python `pip install <pkg>`),并确认在正确的项目/虚拟环境中运行。',
  },
  // ── 文件已存在 ────────────────────────────────────────────────────────────
  {
    name: 'file-exists',
    re: /\beexist\b|file already exists|已存在(且|,)?无法/,
    solution: '目标已存在:改用其他名称/路径,或在确认可覆盖后先删除/移动原文件再重试。',
  },
  // ── 认证 / 无 key ────────────────────────────────────────────────────────
  // (模型侧缺 key 有 honestFailureReason.buildKeyConfigInvite 专职;此处覆盖工具/HTTP
  //  侧的 401/403,给出通用配置指引,不与密钥邀请冲突。)
  {
    name: 'auth',
    re: /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication failed|认证失败|鉴权失败/,
    solution: '认证/鉴权失败:检查对应服务的凭据(API Key / Token)是否已配置且有效、未过期,以及是否有访问该资源的权限。',
  },
  // ── 限流 ──────────────────────────────────────────────────────────────────
  {
    name: 'rate-limit',
    re: /\b429\b|rate limit|too many requests|限流|请求过于频繁/,
    solution: '被限流:降低请求频率、稍后重试,或改用配额更充足的账号/端点。',
  },
  // ── Git 冲突 ──────────────────────────────────────────────────────────────
  {
    name: 'git-conflict',
    re: /merge conflict|conflict.*prevented|冲突,请先|合并冲突/,
    solution: 'Git 冲突:先解决冲突文件(编辑冲突标记后 `git add`),或 `git merge --abort` / `git rebase --abort` 回退再处理。',
  },
]);

/**
 * 从若干错误文本中,给出去重、按规则顺序排列的「建议方案」行。
 *
 * @param {string|string[]} errorTexts  一段或多段错误文本(工具真因 / stderr / message)
 * @param {{env?:object, max?:number}} [opts]
 *   - env:注入门控;max:最多返回几条建议(默认 4,避免刷屏)。
 * @returns {string[]}  建议方案文本数组(门关 / 无匹配 → 空数组,调用方据此兜底)
 */
function suggestSolutions(errorTexts, opts = {}) {
  try {
    if (!isErrorSolutionAdvisorEnabled(opts.env)) return [];
    const list = Array.isArray(errorTexts) ? errorTexts : [errorTexts];
    const haystack = list
      .map((t) => (t == null ? '' : String(t)))
      .join('\n')
      .toLowerCase();
    if (!haystack.trim()) return [];
    const max = Number.isFinite(opts.max) && opts.max > 0 ? Math.floor(opts.max) : 4;
    const out = [];
    const seen = new Set();
    let downloadFailed = false;
    for (const rule of SOLUTION_RULES) {
      if (out.length >= max) break;
      if (rule.re.test(haystack) && !seen.has(rule.name)) {
        // web 404 已被 download-failed 精准命中时,抑制两个会被裸 "not found" / ": not found"
        // 误触的泛化家族(path-not-found / command-not-found),避免把「远端资源没找到」再
        // 混淆成「本地路径/命令缺失」。download-failed 声明在它们之前,故此处必已判定。
        if (downloadFailed && (rule.name === 'path-not-found' || rule.name === 'command-not-found')) continue;
        seen.add(rule.name);
        out.push(rule.solution);
        if (rule.name === 'download-failed') downloadFailed = true;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 命中的规则名(供测试/诊断用,不含文案)。
 * @param {string|string[]} errorTexts
 * @param {{env?:object}} [opts]
 * @returns {string[]}
 */
function matchedSolutionNames(errorTexts, opts = {}) {
  try {
    if (!isErrorSolutionAdvisorEnabled(opts.env)) return [];
    const list = Array.isArray(errorTexts) ? errorTexts : [errorTexts];
    const haystack = list.map((t) => (t == null ? '' : String(t))).join('\n').toLowerCase();
    if (!haystack.trim()) return [];
    return SOLUTION_RULES.filter((r) => r.re.test(haystack)).map((r) => r.name);
  } catch {
    return [];
  }
}

module.exports = {
  SOLUTION_RULES,
  isErrorSolutionAdvisorEnabled,
  suggestSolutions,
  matchedSolutionNames,
};
