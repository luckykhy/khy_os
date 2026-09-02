'use strict';

/**
 * commandCodeInvocation.js — 纯叶子:把「让 khyos 指挥 Command Code CLI」
 * 的调用参数构建为单一真源(零 IO、确定性、env 门控、绝不抛、可单测)。
 *
 * 背景(目标「让 khyos chat 也能用 minimax m3 free」):Command Code CLI 的
 * 非交互入口是 `cmdcode --print --model <provider/model> [message..]`(位置
 * 参数,不读 stdin;与 opencode run 同构)。本叶子只负责把开关规范化成参数数组
 * —— 真正的 spawn / 探测 / 输出捕获仍复用 cliToolAdapter 既有的子进程机制
 * (与 OpenCode 的「位置参数 + 非流式」模式同构)。
 *
 * 已知 wire(基于桌面端抓包 D:\desktop\cmdc_endpoint_probe_2026-08-28.md):
 *   - cmdc 不是 OpenAI 协议;真实模型调用点 = `POST https://api.commandcode.ai/alpha/generate`
 *     (Command Code 自定义 JSON,model id 放 body 顶层)。
 *   - 启动握手序列:`GET /alpha/whoami` → `POST /alpha/fingerprint/record` → `POST /alpha/lifecycle-events`
 *     然后才是 `POST /alpha/generate`。握手失败也会被 cmdc 内部吞掉、不影响 prompt 流程。
 *   - 固定遥测:每次调用都额外打 `api.axiom.co` (Axiom 日志) + `ingestion.claicode.com`
 *     (Claude usage 上报),即便下游是 MiniMax 模型也走 claicode 上报 —— 这是 cmdc
 *     默认行为,不要试图去掉。
 *   - `config` 字段含 `workingDir/date/environment/structure[]`;`structure` 是 workingDir
 *     根下文件名/子目录列表,大目录会让单次请求 body 达到 ~91KB。这是 cmdc 内部拼装、
 *     adapter 不可控;若要省 token,运行目录保持空。
 *   - OpenAI 兼容路径 `/provider/v1/chat/completions` 在抓包里 0 命中 —— 切勿尝试让
 *     khyos 直接打这条 URL(此前 opencode.json 第 513 行的猜测是错的)。
 *
 * 契约:零 IO(只做字符串/数组逻辑,不 require fs/net/子进程);确定性(同输入同
 * 输出);绝不抛(坏输入 → 安全回退)。
 *
 * 门控 KHY_COMMANDCODE(默认关,仅显式 1/true/on/yes 开启):关闭后 commandcode
 * 既不进入 cliToolAdapter 的探测清单,专用 commandCodeAdapter 也表现为「不可用
 * 」—— 逐字节回退到「commandcode 未被接入」的历史行为。默认关的理由:commandcode
 * 会把整个 prompt 当作单轮 conversation 喂给上游,与 khyos 多轮/工具调用形态不
 * 同;只在用户显式 opt-in 时才激活。
 *
 * @module services/gateway/adapters/commandCodeInvocation
 */

const _ON = new Set(['1', 'true', 'on', 'yes']);

/** 门控:KHY_COMMANDCODE 默认关,仅显式 1/true/on/yes 开启。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_COMMANDCODE;
  if (v === undefined || v === null) return false;
  return _ON.has(String(v).trim().toLowerCase());
}

/**
 * Command Code CLI 的 `--model` 形式为 `provider/model`(首段是 provider,其余是
 * model;model 本身可含 `/`,如 `MiniMaxAI/MiniMax-M3`)。故仅当首段非空且其后还有
 * 非空模型名才注入;否则让 commandcode 用它自己配置的默认模型。
 */
function looksLikeProviderModel(model) {
  if (typeof model !== 'string') {
    return false;
  }
  const s = model.trim();
  const slash = s.indexOf('/');
  return slash > 0 && slash < s.length - 1;
}

/**
 * 构建 `cmdcode --print` 的参数数组。`__PROMPT__` 占位符由 cliToolAdapter
 * 在 spawn 前替换为真实 prompt(与 OpenCode 的 `run __PROMPT__` 同一机制)。
 *
 * @param {object} [opts]
 * @param {string} [opts.model]            provider/model(仅合法时注入 --model)
 * @returns {string[]}
 */
function buildPrintArgs(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const args = ['--print', '__PROMPT__'];
  if (looksLikeProviderModel(o.model)) {
    args.push('--model', o.model.trim());
  }
  return args;
}

/**
 * 构建 `cmdcode --print` 的纯 argv 数组(不含 `__PROMPT__`),供 useStdin=true
 * 模式使用。prompt 由 cliToolAdapter 直接写入子进程 stdin,完全绕开 Windows
 * cmd 拆参与命令行长度上限的坑(`cmdc -p <多词>` 会被 cmd 拆成多个 argv,
 * `cmdc -p <超长>` 会撞 Windows ERROR_FILENAME_EXCED_RANGE)。
 *
 * Wire 实测:`echo "Say hello..." | cmdc -p` 与 `cmdc -p "Say hello..."` 在
 * stdout 上行为一致,cmdc 接收 stdin 的内容作为 prompt 字符串并照常走
 * `POST /alpha/generate`。
 *
 * @param {object} [opts]
 * @param {string} [opts.model]            provider/model(仅合法时注入 --model)
 * @returns {string[]}
 */
function buildPrintArgsStdin(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const args = ['--print'];
  if (looksLikeProviderModel(o.model)) {
    args.push('--model', o.model.trim());
  }
  return args;
}

/**
 * 在既有参数数组上追加 `--model provider/model`(仅当模型合法)。供 cliToolAdapter
 * 的通用 model 注入钩子调用。绝不改动入参:返回新数组;不合法 → 原样返回浅拷贝。
 */
function applyModelArg(args, model) {
  const base = Array.isArray(args) ? args.slice() : [];
  if (looksLikeProviderModel(model)) {
    base.push('--model', model.trim());
  }
  return base;
}

module.exports = {
  isEnabled,
  looksLikeProviderModel,
  buildPrintArgs,
  buildPrintArgsStdin,
  applyModelArg,
};
