'use strict';

/**
 * @pattern Chain of Responsibility, Facade
 *
 * imRuntimeConfig.js — IM 渠道端点/凭据的解析口子:**env 优先,其次 `.khy/` 运行期 JSON**。
 *
 * 为什么要单独一层:webhook 地址、app secret、verification token 这类东西既不能写死在
 * 源码里(换租户就得改代码、且 secret 会进 git),也不能只认 env(用户在 `khy` 交互式
 * 配置里填完,总得有个地方落盘给下次启动读)。仓里既有的运行期 JSON 约定就是
 * `<数据家>/*_runtime.json`(见 cli/handlers/gateway.js 的 ai_manage_runtime.json 与
 * doctorConnectivity.js 的多数据家探测);本模块把同一套「多数据家依次探测、第一个存在
 * 的赢」的解析收敛成 IM 渠道专用的一份,不再让每个渠道各写一遍 path.join。
 *
 * 解析链(逐级下降,第一个给出值的赢):
 *   1. env `KHY_IM_<CHANNEL>_<KEY>`(如 KHY_IM_FEISHU_WEBHOOK_URL)—— CI/容器注入
 *   2. 运行期 JSON 里的同名 camelCase 键 —— 交互式配置落盘
 *   3. 调用方给的 defaults —— 兜底
 * 运行期 JSON 候选路径(第一个**存在**的文件赢):
 *   a. `KHY_IM_CONFIG_FILE`(整文件显式指定)
 *   b. `KHY_IM_CONFIG_DIR`/<channel>.json
 *   c. `<getAppHome()>/im/<channel>.json`      ← 应用数据家(与附件同根)
 *   d. `<getDataHome()>/im/<channel>.json`     ← 统一解析器(~/.khy)
 *   e. `<getProjectDataHome()>/im/<channel>.json` ← 项目内 .khy(便携/开发)
 * 三个数据家都经 utils/dataHome 解析,**没有任何** `~/.khyquant` 硬编码。
 *
 * 契约:非纯(读 fs / env)、**绝不抛**——文件缺失、JSON 畸形、权限不足一律降级为
 * 「这一级没给出值」并把原因记进 `notes`,让调用方能在日志里说清「读了哪几个文件、
 * 哪个键从哪来」。secret 一律经 redactSecret/redactUrl 打码后才允许进日志。
 */

const fs = require('fs');
const path = require('path');

const { getAppHome, getDataHome, getProjectDataHome } = require('../../utils/dataHome');

/** camelCase 键 → env 后缀:wsUrl → WS_URL,appSecret → APP_SECRET。 */
function envSuffix(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase()
    .replace(/^_+|_+$/g, '');
}

/**
 * 某渠道某键对应的 env 变量名。
 * @param {string} channel 渠道短名(如 'feishu')
 * @param {string} key camelCase 配置键(如 'webhookUrl')
 * @returns {string} 如 'KHY_IM_FEISHU_WEBHOOK_URL'
 */
function envKey(channel, key) {
  return `KHY_IM_${envSuffix(channel)}_${envSuffix(key)}`;
}

/** 安全地解一个数据家(dataHome 内部会 mkdir;取不到就跳过这一级,不许把解析拖崩)。 */
function _safeHome(resolver) {
  try {
    const dir = resolver();
    return typeof dir === 'string' && dir ? dir : null;
  } catch {
    return null;
  }
}

/**
 * 运行期 JSON 的候选路径(按优先级,已去重)。
 * @param {string} channel
 * @param {object} [env]
 * @returns {string[]}
 */
function configFileCandidates(channel, env = process.env) {
  const e = env || process.env;
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) {
      out.push(p);
    }
  };

  const explicitFile = String(e.KHY_IM_CONFIG_FILE || '').trim();
  if (explicitFile) {
    push(path.resolve(explicitFile));
  }
  const explicitDir = String(e.KHY_IM_CONFIG_DIR || '').trim();
  if (explicitDir) {
    push(path.join(path.resolve(explicitDir), `${channel}.json`));
  }
  for (const resolver of [getAppHome, getDataHome, getProjectDataHome]) {
    const home = _safeHome(resolver);
    if (home) {
      push(path.join(home, 'im', `${channel}.json`));
    }
  }
  return out;
}

/**
 * 读取渠道的运行期 JSON。第一个**存在**的候选文件赢(即便它内容为空对象——存在即是
 * 用户的选择,不许跳过它去读下一个,否则两份配置会静默叠加成谁也说不清的状态)。
 *
 * 接受三种外形,都归一成扁平 values:
 *   { "wsUrl": … }                     扁平
 *   { "feishu": { "wsUrl": … } }       按渠道分节
 *   { "channels": { "feishu": { … } } } 带 channels 包裹
 *
 * @param {string} channel
 * @param {object} [env]
 * @returns {{file:string|null, values:object, notes:string[]}}
 */
function loadChannelFile(channel, env = process.env) {
  const notes = [];
  const candidates = configFileCandidates(channel, env);
  for (const file of candidates) {
    let raw;
    try {
      if (!fs.existsSync(file)) {
        continue;
      }
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      notes.push(`运行期配置 ${file} 读取失败(${(err && err.message) || 'unknown'}),跳过`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // 畸形 JSON 必须**说出文件名**:静默跳过会让用户对着一份改了半天的配置发懵。
      notes.push(`运行期配置 ${file} 不是合法 JSON(${(err && err.message) || 'parse error'}),已忽略`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      notes.push(`运行期配置 ${file} 顶层不是对象,已忽略`);
      continue;
    }
    let values = parsed;
    if (parsed.channels && typeof parsed.channels === 'object' && parsed.channels[channel]) {
      values = parsed.channels[channel];
    } else if (parsed[channel] && typeof parsed[channel] === 'object' && !Array.isArray(parsed[channel])) {
      values = parsed[channel];
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      notes.push(`运行期配置 ${file} 中 ${channel} 节不是对象,已忽略`);
      continue;
    }
    return { file, values, notes };
  }
  notes.push(`未发现 ${channel} 运行期配置(已探测 ${candidates.length} 个候选路径),仅用 env 与默认值`);
  return { file: null, values: {}, notes };
}

/**
 * 解析一个渠道的整套配置。
 *
 * @param {string} channel 渠道短名
 * @param {object} spec key → { default?, required?, secret? }
 * @param {object} [options]
 * @param {object} [options.env]
 * @returns {{values:object, sources:object, file:string|null, notes:string[], missing:string[]}}
 */
function resolveChannelConfig(channel, spec = {}, options = {}) {
  const env = options.env || process.env;
  const { file, values: fileValues, notes } = loadChannelFile(channel, env);
  const values = {};
  const sources = {};
  const missing = [];

  for (const [key, rule] of Object.entries(spec || {})) {
    const r = rule || {};
    const name = envKey(channel, key);
    const fromEnv = env[name];
    if (fromEnv !== undefined && String(fromEnv).trim() !== '') {
      values[key] = String(fromEnv).trim();
      sources[key] = `env:${name}`;
      continue;
    }
    const fromFile = fileValues[key];
    if (fromFile !== undefined && fromFile !== null && String(fromFile).trim() !== '') {
      values[key] = typeof fromFile === 'string' ? fromFile.trim() : fromFile;
      sources[key] = `file:${file}`;
      continue;
    }
    if (r.default !== undefined) {
      values[key] = r.default;
      sources[key] = 'default';
      continue;
    }
    values[key] = undefined;
    sources[key] = 'unset';
    if (r.required) {
      missing.push(name);
    }
  }

  return { values, sources, file, notes, missing };
}

/**
 * 写入目标文件的选法:**第一个已存在的候选赢;都不存在才落候选表头一个**。
 *
 * 为什么不直接写 candidates[0]:读取端认的是「第一个存在的文件」。若用户的配置早就落在
 * 数据家 (c/d/e) 里,而我们新建一份 candidates[0],读取端会突然改读新文件,用户原来那份
 * 键值静默失效——表现为「明明配过 appSecret,却报缺凭据」。选已存在的那个来合并,读写才
 * 指向同一份。
 * @param {string} channel
 * @param {object} env
 * @returns {string|null}
 */
function _writeTarget(channel, env) {
  const candidates = configFileCandidates(channel, env);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        return file;
      }
    } catch {
      /* 探测失败当作不存在,继续看下一个 */
    }
  }
  return candidates[0] || null;
}

/**
 * 把若干配置键**合并**进渠道的运行期 JSON(0600),保留文件原有外形(扁平 / 按渠道分节 /
 * channels 包裹)。值为空串或 null 表示**删除该键**(即「取消设置」)。
 *
 * 绝不抛。两种情况明确拒绝而不是硬写:
 *   - 目标文件存在但不是合法 JSON —— 覆盖会毁掉用户改了半天的文件,故如实报错让人自己处理;
 *   - 顶层不是对象 —— 同理。
 *
 * @param {string} channel
 * @param {object} fields camelCase 键 → 值(空串/null = 删除)
 * @param {object} [options]
 * @param {object} [options.env]
 * @returns {{ok:boolean, file?:string, set?:string[], removed?:string[], error?:string}}
 */
function writeChannelConfig(channel, fields = {}, options = {}) {
  const env = options.env || process.env;
  const name = String(channel || '').trim().toLowerCase();
  if (!name) {
    return { ok: false, error: '缺少渠道名(如 feishu),无法定位运行期配置文件' };
  }
  const file = _writeTarget(name, env);
  if (!file) {
    return {
      ok: false,
      error: `无法解析 ${name} 的运行期配置路径(数据家均不可用);可用 KHY_IM_CONFIG_FILE 显式指定一个文件`,
    };
  }

  let doc = {};
  if (fs.existsSync(file)) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return { ok: false, error: `读取 ${file} 失败(${(err && err.message) || 'unknown'})` };
    }
    if (String(raw).trim()) {
      try {
        doc = JSON.parse(raw);
      } catch (err) {
        return {
          ok: false,
          error: `${file} 不是合法 JSON(${(err && err.message) || 'parse error'});为避免覆盖你的内容,这次没有写入——请先修好或删掉该文件`,
        };
      }
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, error: `${file} 顶层不是对象;为避免覆盖你的内容,这次没有写入` };
    }
  }

  // 沿用文件既有外形,别把用户的分节结构改平。
  let target = doc;
  if (doc.channels && typeof doc.channels === 'object' && !Array.isArray(doc.channels)) {
    if (!doc.channels[name] || typeof doc.channels[name] !== 'object') {
      doc.channels[name] = {};
    }
    target = doc.channels[name];
  } else if (doc[name] && typeof doc[name] === 'object' && !Array.isArray(doc[name])) {
    target = doc[name];
  }

  const set = [];
  const removed = [];
  for (const [key, value] of Object.entries(fields || {})) {
    const k = String(key || '').trim();
    if (!k) {
      continue;
    }
    if (value === null || value === undefined || String(value).trim() === '') {
      if (k in target) {
        delete target[k];
        removed.push(k);
      }
      continue;
    }
    target[k] = String(value).trim();
    set.push(k);
  }

  const atomicWriteJson = require('../../utils/atomicWriteJson');
  if (!atomicWriteJson(file, doc, { mode: 0o600, ensureDir: true })) {
    return { ok: false, error: `写入 ${file} 失败(权限或磁盘问题)` };
  }
  return { ok: true, file, set, removed };
}

/**
 * 删除渠道的运行期 JSON(只删读写共用的那一份;env 里的值本模块管不着,由调用方提示)。
 * @param {string} channel
 * @param {object} [options]
 * @param {object} [options.env]
 * @returns {{ok:boolean, file:string|null, existed:boolean, error?:string}}
 */
function clearChannelConfig(channel, options = {}) {
  const env = options.env || process.env;
  const name = String(channel || '').trim().toLowerCase();
  const file = name ? _writeTarget(name, env) : null;
  if (!file) {
    return { ok: false, file: null, existed: false, error: `无法解析 ${name || '(空)'} 的运行期配置路径` };
  }
  if (!fs.existsSync(file)) {
    return { ok: true, file, existed: false };
  }
  try {
    fs.rmSync(file);
    return { ok: true, file, existed: true };
  } catch (err) {
    return { ok: false, file, existed: true, error: (err && err.message) || 'unknown' };
  }
}

/** secret 打码:保留前 3 后 2,中间固定长度掩码(长度也算信息,不泄漏)。 */
function redactSecret(value) {
  const s = String(value == null ? '' : value);
  if (!s) {
    return '(未设置)';
  }
  if (s.length <= 6) {
    return '******';
  }
  return `${s.slice(0, 3)}******${s.slice(-2)}`;
}

/**
 * URL 打码:保留 scheme/host/path,query 里的每个值一律换成 ***
 * ——飞书/Telegram 的长连接 URL 常把一次性 ticket 挂在 query 上,原样进日志就是泄漏。
 * @param {string} url
 * @returns {string}
 */
function redactUrl(url) {
  const raw = String(url == null ? '' : url);
  if (!raw) {
    return '(未设置)';
  }
  try {
    const u = new URL(raw);
    const keys = [...u.searchParams.keys()];
    for (const k of keys) {
      u.searchParams.set(k, '***');
    }
    if (u.password) {
      u.password = '***';
    }
    return u.toString();
  } catch {
    // 不是合法 URL(可能是用户填错的半截串):砍掉 `?` 之后的一切再回显。
    const cut = raw.indexOf('?');
    return cut >= 0 ? `${raw.slice(0, cut)}?***` : raw;
  }
}

/** 把 sources 压成一行「哪个键来自哪里」的日志串(secret 只报来源,不报值)。 */
function describeSources(sources = {}) {
  return Object.entries(sources)
    .map(([key, from]) => `${key}←${from}`)
    .join(' ');
}

module.exports = {
  envKey,
  envSuffix,
  configFileCandidates,
  loadChannelFile,
  resolveChannelConfig,
  writeChannelConfig,
  clearChannelConfig,
  redactSecret,
  redactUrl,
  describeSources,
};
