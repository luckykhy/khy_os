'use strict';

/**
 * shellErrorClassify.js — 纯叶子:把「未见过的」shell 失败,从裸 stderr 升级成一句可操作的
 * 「怎么改」指引(零 IO、确定性、绝不抛、门控)。
 *
 * 真实缺口:pythonInvocationHint 只治两类 inline-python 姿势错;diagnoseEmptyFailure /
 * shellEmptyOutputNote 只治「空输出」。命令带**非空 stderr** 却不属这两类时,
 * composeShellError 只把 stderr 尾部原样贴上——命令找不到、权限拒绝、路径不存在、缺依赖/
 * 模块、端口占用、磁盘满、网络/DNS 失败这些**跨工具高频环境/姿势错**,报错文字只说「是什么」
 * 不说「怎么改」,模型每碰一次就反复试错。本叶子据「报错签名(+ 命令形态)」确定式识别这
 * **一组常见错误家族**,各给一句可操作改法,把 khyos 面对「没被专门教过的错误」时的默认反应
 * 从「裸抛→试错」提升为「附一条修复方向」。
 *
 * 边界(与 pythonInvocationHint 同源的克制):
 *   - 只识别**环境/姿势错**(工具是否存在、权限、路径、依赖、端口、磁盘、网络),
 *     **不猜业务/逻辑错**(断言失败、KeyError、编译期类型错、测试断言……)——那些的修复
 *     在用户代码里,臆测只会误导。无法归入某个已知家族 → 返回 null(逐字节回退,不追加)。
 *   - **单火**:一次失败最多追加**一条**(命中优先级最高的家族即停),避免堆叠成一墙文字。
 *   - **让位 python**:命令形态是 python 调用时不接管 not-found —— 那类由更精准的
 *     pythonInvocationHint(python3→python)负责,两者绝不双开同一条。
 *
 * 契约:零 IO、确定性、绝不抛。env 门控 KHY_SHELL_ERROR_CLASSIFY(默认开,仅显式
 * 0/false/off/no 关);关 / 无命中 / 异常 → null,调用方逐字节回退
 * (不追加任何行)。门控经 flagRegistry 集中判定(CANON),fail-soft 回退本地 CANON。
 *
 * @module tools/shellErrorClassify
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控判定:flagRegistry 优先,回退本地 CANON。默认开。 */
function shellErrorClassifyEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_SHELL_ERROR_CLASSIFY', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_SHELL_ERROR_CLASSIFY;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 命令形态:是否 python 调用(让位 pythonInvocationHint,避免 not-found 双开)。────────
const _PYTHON_CMD_RE = /\bpython(?:w|[0-9.]*)?\b|\bpy\b/i;

// ── 报错家族签名(按“越具体越靠前”排序,单火取第一命中)。─────────────────────────────

// 缺依赖 / 缺模块:语言运行时找不到已 import 的包(而非命令本身找不到)。
// Node: `Cannot find module 'x'` / `ERR_MODULE_NOT_FOUND`;
// Python: `ModuleNotFoundError: No module named 'x'` / `ImportError: No module named x`。
const _MISSING_MODULE_RE = /Cannot find module\s+['"]([^'"]+)['"]|ERR_MODULE_NOT_FOUND|ModuleNotFoundError:\s*No module named\s+['"]?([A-Za-z0-9_.]+)|ImportError:\s*No module named\s+['"]?([A-Za-z0-9_.]+)/;

// 端口被占用:典型 EADDRINUSE / address already in use。
const _PORT_IN_USE_RE = /EADDRINUSE|address already in use|端口.*(?:占用|被占)|bind:\s*address already in use/i;

// 磁盘满:ENOSPC / no space left。
const _DISK_FULL_RE = /ENOSPC|No space left on device|磁盘空间不足|disk (?:is )?full/i;

// 网络 / DNS / 连接:ENOTFOUND / ECONNREFUSED / ETIMEDOUT / Could not resolve host / connection refused。
const _NETWORK_RE = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|Could not resolve host|Temporary failure in name resolution|Connection (?:refused|timed out)|无法解析|连接(?:被拒绝|超时)/i;

// 权限拒绝:EACCES / Permission denied / Access is denied / 拒绝访问。
const _PERMISSION_RE = /EACCES|EPERM|Permission denied|Access is denied|拒绝访问|权限不足|operation not permitted/i;

// 命令找不到:not recognized(Win)/ command not found(POSIX)/ 不是内部或外部命令 / No such file(exec 层)。
const _CMD_NOT_FOUND_RE = /is not recognized as an internal or external command|不是内部或外部命令|command not found|:\s*not found/i;

// 下载 / HTTP 请求失败(远端 404 / 错误响应):**远端资源没找到**,不是本地命令缺失。
// 锚定 web 请求标记(PowerShell Invoke-WebRequest / .NET WebException / curl / wget /
// 显式 HTTP 404),刻意**不**用裸 `not found`——那会和上面命令找不到家族抢，正是本次
// 「Invoke-WebRequest : Not Found」被误判成「找不到命令 powershell」的病根。故本家族排在
// 命令找不到家族**之前**(单火取先者),把 web 404 从「命令缺失」误诊里救出来。
const _HTTP_DOWNLOAD_FAIL_RE = /Invoke-WebRequest|WebCmdletWebResponseException|System\.Net\.[A-Za-z]*WebRequest|WebException|The remote server returned an error|response status code does not indicate success|HTTP\/\d(?:\.\d)?\s+404\b|\bHTTP\s+404\b|\b404\s+not\s+found\b|curl:\s*\(22\)|wget:[^\n]*\b404\b/i;

// 路径 / 文件不存在:ENOENT / No such file or directory / cannot find the path / 系统找不到指定的(路径|文件)。
const _PATH_NOT_FOUND_RE = /ENOENT|No such file or directory|cannot find the (?:path|file) specified|系统找不到指定的(?:路径|文件)|找不到路径/i;

/**
 * 从命令串抽第一个「疑似可执行名」——供 command-not-found 家族点名。取第一个非重定向、
 * 非环境赋值的 token 的 basename。纯字符串,尽力而为(抽不到不影响措辞主体)。
 */
function _firstCommandToken(command) {
  const tokens = String(command == null ? '' : command).trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;    // 跳 FOO=bar
  while (i < tokens.length && (tokens[i] === 'sudo' || tokens[i] === 'env')) i++;
  if (i < tokens.length && tokens[i] === 'rtk') i++;                        // 剥 RTK 前缀
  if (i >= tokens.length) return '';
  const full = tokens[i].replace(/^["'`]+/, '');
  const slash = full.lastIndexOf('/');
  return slash >= 0 ? full.slice(slash + 1) : full;
}

/**
 * 家族规则表(单火:自上而下第一命中即返回其 build 结果)。每条 build 收 (cmd, out, match)
 * 返回一句「怎么改」;命中家族但决定让位(如 python 的 not-found)时 build 可返回 null,
 * 继续尝试下一条。
 */
const _RULES = [
  // ① 缺依赖 / 缺模块 —— 最具体(点名了缺哪个包)。
  {
    re: _MISSING_MODULE_RE,
    build(cmd, out, m) {
      const name = m && (m[1] || m[2] || m[3]);
      const who = name ? `\`${name}\`` : '某个依赖';
      // 据运行时形态给对应的安装器,避免让模型在 pip / npm 间瞎猜。
      const isNode = /Cannot find module|ERR_MODULE_NOT_FOUND/.test(out) || /\bnode\b|\bnpm\b|\bnpx\b/.test(cmd);
      const isPy = /ModuleNotFoundError|ImportError/.test(out) || _PYTHON_CMD_RE.test(cmd);
      let how;
      if (isNode) how = '先 `npm install`(或 `npm i ' + (name || '<包名>') + '`)装齐依赖再重跑';
      else if (isPy) how = '先 `pip install ' + (name || '<包名>') + '`(在正确的虚拟环境里)再重跑';
      else how = '先用该语言的包管理器安装缺失依赖再重跑';
      return `缺少依赖 ${who}:这是「已 import 但未安装」而非代码逻辑错。${how};`
        + '若已装,检查是否装在了另一个环境/版本(node_modules 缺失、venv 未激活、全局 vs 本地)。';
    },
  },
  // ② 端口被占用。
  {
    re: _PORT_IN_USE_RE,
    build() {
      return '端口已被占用(EADDRINUSE):另一个进程正监听同一端口。'
        + '先查是谁占用(`lsof -i:<端口>` / Windows `netstat -ano | findstr :<端口>`)并结束它,'
        + '或换一个空闲端口(改配置/环境变量);别反复重启同一端口。';
    },
  },
  // ③ 磁盘满。
  {
    re: _DISK_FULL_RE,
    build() {
      return '磁盘空间不足(ENOSPC):写入失败是因为目标卷没有可用空间。'
        + '先 `df -h`(Windows 看盘符可用空间)确认哪个卷满了,清理临时文件/日志或换有空间的路径后重跑;'
        + '这不是命令本身的错。';
    },
  },
  // ④ 网络 / DNS / 连接。
  {
    re: _NETWORK_RE,
    build() {
      return '网络/连接失败(DNS 解析或 TCP 连接不通):不是命令语法错。'
        + '先核实主机名/URL 拼写与网络可达性(`ping <主机>` / `curl -v <URL>`),'
        + '确认代理/防火墙/VPN 设置;若是临时性失败(EAI_AGAIN/ETIMEDOUT)可稍后重试。';
    },
  },
  // ⑤ 权限拒绝。
  {
    re: _PERMISSION_RE,
    build() {
      return '权限被拒绝(EACCES/Permission denied):当前用户对目标文件/目录/端口没有相应权限。'
        + '先核实目标属主与权限位(`ls -l <路径>`);按需 `chmod`/`chown` 或改到有权限的路径,'
        + '仅在确有必要且安全时才用 `sudo`;<1024 的端口在 POSIX 上需特权。';
    },
  },
  // ⑥ 下载 / HTTP 404 —— 必须排在命令找不到之前:web「Not Found」不是命令缺失。
  {
    re: _HTTP_DOWNLOAD_FAIL_RE,
    build() {
      return '下载/网络请求失败(远端返回 404 或错误响应):这是**远端资源没找到**,不是本地命令缺失。'
        + '核对下载 URL 的仓库 / 标签(tag)/ 资产名是否正确——发布资产名常随版本变化,别猜固定 URL;'
        + '先用发布 API 列出真实可用资产,再选对应你系统架构(如 windows-x64 / linux-amd64 / darwin-arm64)的那个:'
        + '`gh release list -R <owner>/<repo>` 或 GET `https://api.github.com/repos/<owner>/<repo>/releases/latest`;'
        + '确认无误后再重新下载。';
    },
  },
  // ⑦ 命令找不到 —— 让位 python(那类由 pythonInvocationHint 精准处理)。
  {
    re: _CMD_NOT_FOUND_RE,
    build(cmd) {
      if (_PYTHON_CMD_RE.test(cmd)) return null;                 // 让位 pythonInvocationHint
      const name = _firstCommandToken(cmd);
      const who = name ? `\`${name}\`` : '该命令';
      return `找不到命令 ${who}:它未安装、拼写错,或不在 PATH 中。`
        + '先确认拼写与是否已安装(`which ' + (name || '<命令>') + '` / Windows `where ' + (name || '<命令>') + '`);'
        + '若已装则把其目录加入 PATH;注意 Windows 与 POSIX 的命令名常不同(如 python3→python)。';
    },
  },
  // ⑧ 路径 / 文件不存在 —— 最泛,压末位。
  {
    re: _PATH_NOT_FOUND_RE,
    build() {
      return '路径/文件不存在(ENOENT):命令引用的文件或目录在当前位置找不到。'
        + '先核实路径确实存在且相对的是正确的工作目录(`ls -d <路径>` / `pwd`);'
        + '注意相对路径的基准目录、大小写、以及空格/中文需正确加引号。';
    },
  },
];

/**
 * 据报错文本(+ 命令形态)把失败归入一个已知环境/姿势错家族,返回一句「怎么改」。
 * 单火:命中优先级最高的家族即返回;无任何家族命中 → null。
 *
 * @param {string} command 原始命令串
 * @param {string} output  子进程 stdout+stderr 合并文本(承载报错签名)
 * @param {object} [env]   注入 env(测试用);缺省取 process.env
 * @returns {string|null}  门控关 / 无命中 / 异常 → null
 */
function buildShellErrorHint(command, output, env) {
  try {
    if (!shellErrorClassifyEnabled(env)) return null;
    const cmd = String(command == null ? '' : command);
    const out = String(output == null ? '' : output);
    if (!out) return null;                                       // 空输出归 diagnoseEmptyFailure 管

    for (const rule of _RULES) {
      const m = rule.re.exec(out);
      if (!m) continue;
      const line = rule.build(cmd, out, m);
      if (line) return line;                                     // 命中且未让位 → 单火返回
      // build 返回 null(如让位 python):继续尝试后续家族。
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  shellErrorClassifyEnabled,
  buildShellErrorHint,
  // 暴露内部助手供确定性单测
  _firstCommandToken,
  _RULES,
};
