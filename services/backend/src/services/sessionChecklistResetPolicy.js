'use strict';

/**
 * sessionChecklistResetPolicy.js — 纯叶子:新会话启动时「该清空哪些 legacy 会话
 * 清单文件」的确定性判定单一真源。
 *
 * 背景(真缺口):一个「任务清单」面板实际混了三套生命周期不同的状态源:
 *   ① V1 TodoWrite   → os.tmpdir()/khy-todos.json(本会话计划清单,却落成全局 tmp 文件);
 *   ② 兼容 todoWrite → .khyquant/todo_state.json(同为会话清单,另一条工具链、另一份文件);
 *   ③ 持久化 large-task store(跨会话的项目任务,正当地长存)。
 * ①② 语义上都是「本会话计划清单」(session checklist),本应随会话结束而消失;但二者
 * 都写成进程级 / 全局文件、不与真实会话绑定。启动清理(taskCleanupService)只按年龄清
 * ③,从不碰 ①②,故「会话清单重启还在」是架构必然而非偶发 bug。本刀给 TodoWrite 真正
 * 的会话边界:**新会话(非 resume)启动时清空 ①②**,与 repl 既有
 * `if (!options.resumed) ai().clearHistory()` 完全同一条会话边界(清单生命周期 == 历史
 * 生命周期)。
 *
 * 契约(CONTRACT):零 IO、确定性、绝不抛(fail-soft)、env 门控 KHY_SESSION_TODO_RESET
 *   默认开。门控关 / resume 会话 / 坏输入 → 返回空数组(「无需清空」),薄壳
 *   sessionChecklistResetService 据此**字节回退**到今日「从不清空」行为。
 *
 * 诚实边界:
 *   · 只**判定候选文件路径**,绝不碰 IO——目录探测(os.tmpdir/homedir、cwd、
 *     platformUtils.getTmpDir)与 unlink 全部由薄壳执行;本叶子只接收已解析的基目录并
 *     拼接已知文件名。这保证清空的正是写入侧写的那些文件(路径集镜像写入/读取侧)。
 *   · 全局 / 进程级文件天然与「并发多会话」不兼容:两个 khy 会话共享同一 tmp 文件时,
 *     新会话启动会清掉另一个会话的清单。这是 legacy 全局文件设计的既有缺陷;真正修复
 *     是按 sessionId 分文件存储(后续刀)。本刀先补齐「重启还在」这一最直观症状,且与
 *     既有 clearHistory 同边界——clearHistory 同样是进程级、同样在 resume 时豁免。
 *   · path 是纯 / 确定性模块(不在纯叶子 IO 禁列),仅用于跨平台路径拼接,不触碰文件系统。
 */

const path = require('path');

// ── env 门控(默认开,仅显式 0/false/off/no 关)────────────────────────
const _OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控:KHY_SESSION_TODO_RESET 默认开,仅 {0,false,off,no} 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_SESSION_TODO_RESET;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_OFF.has(v);
  } catch {
    return true;
  }
}

// 已知会话清单文件名(叶子拥有的知识;基目录由壳注入)。
const V1_TODO_FILE = 'khy-todos.json';       // V1 TodoWrite,直接位于 tmpdir 下
const COMPAT_TODO_FILE = 'todo_state.json';  // 兼容 todoWrite,位于 .khyquant/ 或 khyquant/ 下
const COMPAT_DOT_DIR = '.khyquant';          // homedir / cwd 下的隐藏目录
const COMPAT_TMP_DIR = 'khyquant';           // tmp 下的非隐藏目录

/**
 * 计算新会话应清空的 legacy 会话清单文件的绝对路径集合。
 *
 * 路径集镜像写入侧(TodoWriteTool.TODO_FILE + 兼容 todoWrite 的 candidateDirs)与读取侧
 * (largeTasks 的 _candidateTodoStateFiles),故清空的正是这些链路读写的文件。dedup 折叠
 * 重叠(如 getLegacyDataHome() === homedir/.khyquant、tmpdir === compatTmpdir)。
 *
 * @param {object} args
 * @param {boolean} args.resumed  是否为 resume 会话(true → 不清空,豁免)
 * @param {object}  args.paths    { tmpdir, compatTmpdir, homedir, cwd } 由壳注入(叶子零 IO)
 * @param {object}  [args.env]
 * @returns {string[]} 应 unlink 的绝对路径(去重、非空);门控关 / resume / 坏输入 → []
 */
function selectResetPaths(args = {}) {
  try {
    const env = args.env || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(env)) return [];
    if (args && args.resumed) return [];

    const p = (args && args.paths) || {};
    const tmpdir = typeof p.tmpdir === 'string' ? p.tmpdir : '';
    // compatTmpdir 缺省回退 tmpdir(壳解析失败时保守用 os.tmpdir 语义)。
    const compatTmpdir = typeof p.compatTmpdir === 'string' && p.compatTmpdir ? p.compatTmpdir : tmpdir;
    const homedir = typeof p.homedir === 'string' ? p.homedir : '';
    const cwd = typeof p.cwd === 'string' ? p.cwd : '';

    const out = [];
    // ① V1 TodoWrite:tmpdir/khy-todos.json
    if (tmpdir) out.push(path.join(tmpdir, V1_TODO_FILE));
    // ② 兼容 todoWrite 三候选目录 + 读取侧 legacyDataHome(=homedir/.khyquant,dedup 合并)
    if (homedir) out.push(path.join(homedir, COMPAT_DOT_DIR, COMPAT_TODO_FILE));
    if (cwd) out.push(path.join(cwd, COMPAT_DOT_DIR, COMPAT_TODO_FILE));
    if (compatTmpdir) out.push(path.join(compatTmpdir, COMPAT_TMP_DIR, COMPAT_TODO_FILE));
    // 读取侧(largeTasks)在 tmpdir 下也可能存 khyquant/todo_state.json(getTmpDir vs os.tmpdir
    // 在部分平台不同);一并纳入以免遗漏。dedup 折叠与 compatTmpdir 相同的情形。
    if (tmpdir) out.push(path.join(tmpdir, COMPAT_TMP_DIR, COMPAT_TODO_FILE));

    return [...new Set(out.filter((x) => typeof x === 'string' && x))];
  } catch {
    return [];
  }
}

module.exports = { isEnabled, selectResetPaths };
