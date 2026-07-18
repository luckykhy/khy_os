'use strict';

/**
 * pythonInvocationHint.js — 纯叶子:把三类高频「inline python 调用姿势错」的失败,从裸报错
 * 升级成一句可操作的修复指引(零 IO、确定性、绝不抛、门控)。
 *
 * 真实缺口(2026-07-04 会话现场,Windows agnes):模型想对比 CSV 找重复文件,连续踩三坑——
 *   ① `python3 -c "..."` → `'python3' 不是内部或外部命令`(Windows 无 python3 可执行,叫 python)。
 *   ② `python -c "import csv; ... def load_csv(path):"` → `SyntaxError: invalid syntax`
 *      (`-c` 单行里塞 `def`/多语句块是非法的)。
 *   ③ `python -c "f=open(...); csv.reader(...)"` → `NameError: name 'csv' is not defined.
 *      Did you forget to import 'csv'?`(inline 拆行时漏了 `import csv`)。
 * 三坑的**修复动作**都不在原始意图里,模型只能反复试错(会话里为此空转了两轮 3~4 分钟)。
 * 本叶子据「命令形态 + 报错签名」确定式识别这三类,各追加一句「怎么改」,让模型一次到位。
 *
 * 只识别**姿势错**(工具用法),不猜**数据/逻辑错**:例如 `python -c` 抛 KeyError 是脚本逻辑
 * (CSV 列名不对),不属本叶子——避免臆测。坑③同样不臆测:仅当 Python(3.11+)自己确定式
 * 给出 `Did you forget to import 'X'?` 时才回显该模块名;裸 `NameError`(无此建议,可能是
 * 变量名拼错而非漏 import)不追加。
 *
 * 契约:零 IO、确定性、绝不抛。env 门控 KHY_PYTHON_INVOCATION_HINT(默认开,仅显式
 * 0/false/off/no 关);关 / 无命中 / 异常 → null,调用方逐字节回退(不追加任何行)。
 * 门控经 flagRegistry 集中判定(CANON),fail-soft 回退本地 CANON。
 *
 * @module tools/pythonInvocationHint
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控判定:flagRegistry 优先,回退本地 CANON。默认开。 */
function pythonHintEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_PYTHON_INVOCATION_HINT', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_PYTHON_INVOCATION_HINT;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 命令是否是一次 python 调用(python / python3 / pythonw / py,允许版本号如 python3.11)。
const _PYTHON_CMD_RE = /\bpython(?:w|[0-9.]*)?\b|\bpy\b/i;
// 命令是否带 `-c` inline 代码开关。
const _DASH_C_RE = /\s-c\b/;
// 命令是否点名 python3(Windows 上不存在)。
const _PYTHON3_RE = /\bpython3(?:\.[0-9]+)?\b/;

// 报错签名。
const _NOT_FOUND_RE = /不是内部或外部命令|is not recognized|command not found|not found|No such file/i;
const _SYNTAX_ERR_RE = /SyntaxError|invalid syntax/i;
// Python 3.11+ 对「用了未导入的模块」会确定式追加 "Did you forget to import 'X'?"——
// 捕获 X。仅认这条**解释器自己给出**的建议(非臆测);裸 NameError 不匹配。
const _MISSING_IMPORT_RE = /Did you forget to import ['"]([^'"]+)['"]/i;

/**
 * 据命令形态 + 报错文本给出 inline-python 修复指引。命中多条则合并成一行。
 *
 * @param {string} command 原始命令串
 * @param {string} output  子进程 stdout+stderr 合并文本(承载 not-found / SyntaxError 签名)
 * @param {object} [env]   注入 env(测试用);缺省取 process.env
 * @returns {string|null}  门控关 / 无命中 / 异常 → null
 */
function buildPythonInvocationHint(command, output, env) {
  try {
    if (!pythonHintEnabled(env)) return null;
    const cmd = String(command == null ? '' : command);
    const out = String(output == null ? '' : output);
    if (!cmd || !_PYTHON_CMD_RE.test(cmd)) return null;

    const hints = [];

    // 坑①:python3 在 Windows 找不到。
    if (_PYTHON3_RE.test(cmd) && _NOT_FOUND_RE.test(out)) {
      const onWin = typeof process !== 'undefined' && process.platform === 'win32';
      hints.push(onWin
        ? 'Windows 上没有 `python3` 可执行文件——用 `python`(或 `py -3`)。'
        : '未找到 `python3`:确认已安装并在 PATH 中,或改用 `python` / `py -3`。');
    }

    // 坑②:`python -c "..."` 单行里写了 def/多语句块 → SyntaxError。
    if (_DASH_C_RE.test(cmd) && _SYNTAX_ERR_RE.test(out)) {
      hints.push('`python -c` 的单行代码不能包含 `def`/`class`/多行缩进块。'
        + '改为:把脚本写进临时 `.py` 文件再 `python 文件.py`;'
        + '或用 heredoc(`python - <<\'PY\' … PY`);或仅用分号连接的简单语句。');
    }

    // 坑③:inline 代码用了某模块却漏 import → NameError。仅当 Python(3.11+)确定式给出
    // "Did you forget to import 'X'?" 时触发(解释器已点名模块,非臆测)。回显该 import 修复;
    // `-c` 形态下再推向临时 `.py` 文件——单行拼接最易漏 import,写文件更不易重犯。
    const importMiss = out.match(_MISSING_IMPORT_RE);
    if (importMiss) {
      const modName = importMiss[1];
      hints.push(_DASH_C_RE.test(cmd)
        ? `NameError:代码用了 \`${modName}\` 却没导入——先加 \`import ${modName}\`。`
          + '`python -c` 单行拼接极易漏掉 import;多语句脚本建议写进临时 `.py` 文件再 `python 文件.py`,更不易重犯。'
        : `NameError:代码用了 \`${modName}\` 却没导入——在脚本顶部加 \`import ${modName}\`。`);
    }

    return hints.length ? hints.join(' ') : null;
  } catch {
    return null;
  }
}

module.exports = {
  pythonHintEnabled,
  buildPythonInvocationHint,
};
