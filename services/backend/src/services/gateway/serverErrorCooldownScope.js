'use strict';

/**
 * serverErrorCooldownScope — 纯叶子:把 `server_error`(上游 5xx)的 fast-fail 冷却
 * 从「按通道(adapter)」收窄为「按池(pool)」,并提供 5xx 快速切池判定。
 *
 * 背景(用户实测,CLI 单次对话 114s 超时):
 *   agnes 池上游 502 → 冷却被写到整条 `api` 通道键。GATEWAY_API_POOL_FALLBACK 切到
 *   sensenova 池时,inspectCachedFastFail 命中刚写下的同通道冷却 → virtualSkip →
 *   后备池从未获得真实尝试 → 级联落到不可用通道 → 60s idle timeout 拖垮整轮对话。
 *   把「某个池的上游 5xx」这条**按池**的事实,当成「整条 api 通道不可用」来冷却,
 *   是后备池救不回的根因。
 *
 * 定性:server_error 是**按上游端点/池**的错误(该池的服务端 5xx),而 fast-fail 缓存按
 *   adapter 键控。冷却记录已带 model 字段(三段式 `api:<pool>:<model>`,由
 *   _recordAdapterFailureWithAttachment 写入):当前尝试的池段 ≠ 造成 5xx 的池段 →
 *   该冷却与本池无关,放行做真实尝试。同池仍尊重冷却(不硬撞确实 5xx 的端点)。
 *
 * 同时提供 shouldFastSwitchPoolOnServerError:上游 5xx 属「换通道比重试同通道更有
 * 价值」的错误类别 — 同池换 key 重试大概率仍 5xx,继续原地重试只会耗尽整体预算。
 * 调用方据此 break 内层 key 循环,立即推进到下一 pool provider。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读 env 门控;不碰 fs / 网络 / 子进程 / 时钟 / 随机)。
 *   - 确定性:同输入恒同输出(纯字符串比较)。
 *   - 绝不抛:任何异常路径返回安全值(false → 尊重今日冷却/今日重试行为,逐字节回退)。
 *   - 门控默认开;关 / 缺模型串 / 旧记录无模型 → 返回 false,调用方按今日行为处理。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

function _gateOn(env, name) {
  try {
    return require('../flagRegistry').isFlagEnabled(name, env || process.env);
  } catch {
    /* fall through to local */
  }
  try {
    const raw = (env || process.env)[name];
    const v = String(raw === undefined || raw === null ? 'true' : raw)
      .trim()
      .toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

/** 门控 KHY_SRV_ERR_COOLDOWN_PER_POOL(冷却按池放行)是否启用。绝不抛。 */
function isEnabled(env = process.env) {
  return _gateOn(env, 'KHY_SRV_ERR_COOLDOWN_PER_POOL');
}

/** 门控 KHY_SRV_ERR_FAST_POOL_SWITCH(5xx 快速切池)是否启用。绝不抛。 */
function isFastSwitchEnabled(env = process.env) {
  return _gateOn(env, 'KHY_SRV_ERR_FAST_POOL_SWITCH');
}

function _norm(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase();
}

/**
 * 从模型串提取池段。三段式 `<adapter>:<pool>:<model>` → 池段;两段式 `<pool>:<model>`
 * → 首段;裸名 → ''(无法归池)。纯字符串解析,不读注册表,绝不抛。
 * @param {*} model
 * @returns {string} 归一化池段,提取不出返回 ''
 */
function extractPoolSegment(model) {
  try {
    const m = _norm(model);
    if (!m) {
      return '';
    }
    const parts = m.split(':');
    if (parts.length >= 3) {
      return parts[1].trim();
    }
    if (parts.length === 2) {
      return parts[0].trim();
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 是否应对**当前请求的池**放行一条已缓存的 server_error 冷却。
 *
 * true 的充要条件(全部满足):门开 + 缓存项确为 server_error + 未开熔断 +
 * 双方模型串均非空(旧记录无则保守不放行)+ 池段(或退化为整串)归一后**不相等**。
 * 任何一项不满足 → false(尊重今日冷却,逐字节回退)。
 *
 * @param {object} [opts]
 * @param {object} [opts.cached]        _getRecentFastFail 返回的缓存失败项(含 errorType / model / circuitOpen)
 * @param {*}      [opts.currentModel]  当前这次尝试实际要送出的模型串
 * @param {object} [opts.env]
 * @returns {boolean} true → 放行(视为未冷却,继续真实尝试)
 */
function shouldBypassServerErrorCooldown(opts = {}) {
  try {
    if (!isEnabled(opts && opts.env)) {
      return false;
    }
    const cached = opts && opts.cached;
    if (!cached) {
      return false;
    }
    if (_norm(cached.errorType) !== 'server_error') {
      return false;
    }
    if (cached.circuitOpen === true) {
      return false;
    } // 熔断已开 → 保守,尊重冷却
    const currentModel = _norm(opts.currentModel);
    if (!currentModel) {
      return false;
    } // 当前模型未知 → 保守
    const cachedModel = _norm(cached.model);
    if (!cachedModel) {
      return false;
    } // 旧记录无模型串 → 保守,逐字节回退
    const curPool = extractPoolSegment(currentModel);
    const cachedPool = extractPoolSegment(cachedModel);
    if (curPool && cachedPool) {
      return curPool !== cachedPool; // 不同池 → 该 5xx 与本池无关,放行
    }
    return currentModel !== cachedModel; // 归不了池 → 退化按整串比较
  } catch {
    return false;
  }
}

/**
 * 上游 5xx 时是否应快速切池(break 内层 key 循环,推进到下一 pool provider)。
 * 门开 + errorType 为 server_error → true。绝不抛。
 * @param {*} errorType
 * @param {object} [env]
 * @returns {boolean}
 */
function shouldFastSwitchPoolOnServerError(errorType, env = process.env) {
  try {
    if (!isFastSwitchEnabled(env)) {
      return false;
    }
    return _norm(errorType) === 'server_error';
  } catch {
    return false;
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeServerErrorCooldownScope() {
  return {
    gates: ['KHY_SRV_ERR_COOLDOWN_PER_POOL', 'KHY_SRV_ERR_FAST_POOL_SWITCH'],
    defaultOn: true,
    summary:
      'server_error(上游 5xx)的 fast-fail 冷却从「按通道」收窄为「按池」:当前请求的' +
      '池段与造成 5xx 的池段不同 → 放行做真实尝试,后备池当轮即可救回;同池仍尊重冷却。' +
      '并提供 5xx 快速切池判定:同池换 key 重试大概率仍 5xx,立即推进下一池不耗尽预算。' +
      '门控关 / 模型串缺失 → 逐字节回退今日行为。',
  };
}

module.exports = {
  isEnabled,
  isFastSwitchEnabled,
  extractPoolSegment,
  shouldBypassServerErrorCooldown,
  shouldFastSwitchPoolOnServerError,
  describeServerErrorCooldownScope,
};
